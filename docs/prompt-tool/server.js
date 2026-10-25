#!/usr/bin/env node
/**
 * 本地提示词出图工具
 *
 * 干什么：把 docs 里 2179 条人工标注的提示词列出来，勾选后调 Agnes 逐张出图。
 *
 * 为什么是本地 Node 服务而不是纯静态页：
 * 1) API Key 不能出现在浏览器里（页面源码、devtools、任何截图都会漏）
 * 2) Agnes 不支持并发（实测并行 5/5 被 RST），必须由一个进程串行排队
 * 3) 出图 15s 一张，浏览器直接等会撞 CORS 预检 + 超时，需要服务端持有长连接
 *
 * 为什么零依赖：Node 内置 http/https/fs 足够，不需要 npm install，
 * 拷到任何装了 Node 的机器上 `node server.js` 就能跑。
 *
 * 启动：node server.js  →  http://127.0.0.1:4780
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const OUTPUT_DIR = path.join(ROOT, 'output');
const INDEX_FILE = path.join(OUTPUT_DIR, 'index.json');

const PORT = Number(process.env.PORT || 4780);
const HOST = '127.0.0.1';

/** 单张请求预算。文生图实测 14-16s，给到 180s 是留 503 重试与慢队列的余量 */
const REQUEST_TIMEOUT_MS = 180000;
/** 相邻两张之间的间隔。Agnes 不接受高并发，留 1.5s 让上游释放连接 */
const GAP_MS = 1500;
/** 503「队列满」是主要失败原因，退避三次后再放弃 */
const RETRY_BACKOFF = [5000, 12000, 25000];

/**
 * 安全兜底尾句。
 *
 * 为什么需要：A 库 1450 条里 1331 条（92%）的 `服装` 字段是空的，
 * 渲染出的提示词里就没有服装信息。模型遇到「七分身与全身构图」时会自由发挥，
 * 实测 P0005 直接生成了裸上身的形象（原提示词只写了「一位女孩…摆出姿态」）。
 *
 * 不改数据（提示词要可溯源），改在出图这一侧追加一句正向约束。
 * 用正向描述而不是 negative_prompt：负向字段在 OpenAI 兼容网关上的支持不稳定。
 */
const SAFE_TAIL = '，人物着装完整得体，画面干净';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
};

// ---------------- 配置 ----------------

function loadConfig() {
  const file = path.join(ROOT, 'config.local.json');
  if (!fs.existsSync(file)) {
    console.error(`[启动失败] 缺少 ${file}\n从 config.example.json 复制一份并填入 api_key。`);
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!cfg.api_key) {
    console.error('[启动失败] config.local.json 里没有 api_key');
    process.exit(1);
  }
  return cfg;
}

const CFG = loadConfig();
const ENDPOINT = new URL(CFG.endpoint || 'https://apihub.agnes-ai.com/v1/images/generations');
const MODEL = CFG.model || 'agnes-image-2.5-flash';

// ---------------- 提示词库 ----------------

function readJsonl(file) {
  if (!fs.existsSync(file)) {
    console.error(`[启动失败] 缺少 ${file}，先跑 python extract_prompts.py`);
    process.exit(1);
  }
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

const PROMPTS = readJsonl(path.join(DATA_DIR, 'prompts.jsonl'));
const BY_CODE = new Map(PROMPTS.map((p) => [p.code, p]));

/** 分组归一：A 库的 bulk/01_portrait 这类路径式分组太长，取末段 */
function groupLabel(raw) {
  const value = String(raw || '').trim();
  const seg = value.split('/').pop();
  return seg || value || '未分组';
}

const GROUPS = (() => {
  const count = new Map();
  PROMPTS.forEach((p) => {
    const g = groupLabel(p.group);
    count.set(g, (count.get(g) || 0) + 1);
  });
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => ({ name, count: n }));
})();

// ---------------- 任务 ----------------

/** job: { id, code, prompt, ratio, size, status, file, error, elapsed, startedAt, attempts } */
const JOBS = [];
const BY_ID = new Map();
let queue = [];
let paused = false;
let draining = false;
let seq = 0;

/** 已完成的出图记录落盘，重启后仍能在图墙上看到 */
function loadIndex() {
  if (!fs.existsSync(INDEX_FILE)) return;
  try {
    const rows = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    rows.forEach((row) => {
      const job = { ...row, status: 'done' };
      JOBS.push(job);
      BY_ID.set(job.id, job);
    });
    console.log(`[索引] 载入 ${rows.length} 条历史出图记录`);
  } catch (err) {
    console.warn('[索引] 读取失败，忽略：', err.message);
  }
}

function saveIndex() {
  const rows = JOBS.filter((j) => j.status === 'done' && j.file).map((j) => ({
    id: j.id,
    code: j.code,
    ratio: j.ratio,
    size: j.size,
    file: j.file,
    elapsed: j.elapsed,
    finishedAt: j.finishedAt,
    group: j.group,
  }));
  fs.writeFileSync(INDEX_FILE, JSON.stringify(rows.slice(-2000), null, 2));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function enqueue(code, opts = {}) {
  const item = BY_CODE.get(code);
  if (!item) throw new Error(`提示词 ${code} 不存在`);
  seq += 1;
  const job = {
    id: `j${Date.now().toString(36)}${seq}`,
    code,
    group: groupLabel(item.group),
    prompt: item.prompt,
    ratio: opts.ratio || item.ratio,
    size: opts.size || '1K',
    safe: opts.safe !== false,
    status: 'queued',
    attempts: 0,
    createdAt: Date.now(),
  };
  JOBS.push(job);
  BY_ID.set(job.id, job);
  queue.push(job);
  drain();
  return job;
}

/**
 * 调一次 Agnes。
 * 请求体用 extra_body.response_format=b64_json：拿 base64 直落盘，
 * 不依赖上游临时链接的存活时间（链接会过期，图墙就全是裂图）。
 */
function callAgnes({ prompt, ratio, size }) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(
      JSON.stringify({
        model: MODEL,
        prompt,
        size: size || '1K',
        ratio: ratio || '1:1',
        extra_body: { response_format: 'b64_json' },
      }),
      'utf8'
    );

    const req = https.request(
      {
        hostname: ENDPOINT.hostname,
        path: ENDPOINT.pathname + ENDPOINT.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          Authorization: `Bearer ${CFG.api_key}`,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (err) {
            /* 上游 5xx 有时返回 HTML，保留 text 给上层判断 */
          }
          resolve({ status: res.statusCode, json, text });
        });
        res.on('error', reject);
      }
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** 上游给 b64 就用 b64；只给 url 就下载回来，统一落成文件 */
function extractImage(result) {
  const item = ((result.json && result.json.data) || [])[0] || {};
  const b64 = item.b64_json || (result.json && result.json.b64_json);
  if (b64) return { buffer: Buffer.from(b64, 'base64'), revised: item.revised_prompt || '' };
  const url = item.url || (result.json && (result.json.image_url || result.json.result_url));
  if (url) return { url, revised: item.revised_prompt || '' };
  return null;
}

function download(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('http://') ? http : https;
    const req = client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        download(res.headers.location).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`下载失败 HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.setTimeout(60000, () => req.destroy(new Error('下载超时')));
    req.on('error', reject);
  });
}

async function runJob(job) {
  job.status = 'running';
  job.startedAt = Date.now();

  for (let attempt = 0; attempt <= RETRY_BACKOFF.length; attempt += 1) {
    job.attempts = attempt + 1;
    try {
      const result = await callAgnes({
        prompt: job.safe ? job.prompt + SAFE_TAIL : job.prompt,
        ratio: job.ratio,
        size: job.size,
      });
      if (result.status === 200) {
        const image = extractImage(result);
        if (!image) throw new Error('返回里没有图片数据');
        const buffer = image.buffer || (await download(image.url));
        const name = `${job.code}_${job.ratio.replace(':', 'x')}_${job.id.slice(-6)}.png`;
        fs.writeFileSync(path.join(OUTPUT_DIR, name), buffer);
        job.file = name;
        job.revised = image.revised;
        job.status = 'done';
        job.elapsed = Date.now() - job.startedAt;
        job.finishedAt = Date.now();
        saveIndex();
        console.log(`[完成] ${job.code} ${job.ratio} ${(job.elapsed / 1000).toFixed(1)}s → ${name}`);
        return;
      }

      const errText =
        (result.json && result.json.error && (result.json.error.message || result.json.error)) ||
        result.text ||
        '';
      const retryable = result.status === 429 || result.status === 503 || result.status >= 500;
      job.error = `HTTP ${result.status}：${String(errText).slice(0, 200)}`;
      if (!retryable) break;
      if (attempt < RETRY_BACKOFF.length) {
        console.warn(`[重试] ${job.code} ${job.error}，${RETRY_BACKOFF[attempt] / 1000}s 后再试`);
        await sleep(RETRY_BACKOFF[attempt]);
      }
    } catch (err) {
      job.error = String(err.message || err);
      if (attempt < RETRY_BACKOFF.length) {
        await sleep(RETRY_BACKOFF[attempt]);
      }
    }
  }

  job.status = 'failed';
  job.elapsed = Date.now() - job.startedAt;
  console.error(`[失败] ${job.code} ${job.error}`);
}

/** 串行消费队列。整个进程只有一个 worker，这是 Agnes 的并发限制决定的 */
async function drain() {
  if (draining) return;
  draining = true;
  while (queue.length && !paused) {
    const job = queue.shift();
    if (!job || job.status !== 'queued') continue;
    await runJob(job);
    if (queue.length && !paused) await sleep(GAP_MS);
  }
  draining = false;
}

// ---------------- HTTP ----------------

function json(res, payload, status = 200) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function serveFile(res, filePath) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': ext === '.png' || ext === '.jpg' ? 'max-age=604800' : 'no-store',
  });
  res.end(body);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** 列表查询：关键词 + 分组 + 画幅，分页返回 */
function queryPrompts(params) {
  const q = String(params.get('q') || '').trim();
  const group = String(params.get('group') || '').trim();
  const ratio = String(params.get('ratio') || '').trim();
  const page = Math.max(1, Number(params.get('page') || 1));
  const size = Math.min(100, Math.max(1, Number(params.get('size') || 30)));

  const done = new Set(JOBS.filter((j) => j.status === 'done').map((j) => j.code));

  let rows = PROMPTS;
  if (group) rows = rows.filter((p) => groupLabel(p.group) === group);
  if (ratio) rows = rows.filter((p) => p.ratio === ratio);
  if (q) {
    const needle = q.toLowerCase();
    rows = rows.filter(
      (p) =>
        p.code.toLowerCase().includes(needle) ||
        p.prompt.toLowerCase().includes(needle) ||
        groupLabel(p.group).toLowerCase().includes(needle)
    );
  }

  const total = rows.length;
  const start = (page - 1) * size;
  return {
    total,
    all: PROMPTS.length,
    page,
    size,
    pages: Math.ceil(total / size),
    groups: GROUPS,
    items: rows.slice(start, start + size).map((p) => ({
      code: p.code,
      prompt: p.prompt,
      ratio: p.ratio,
      group: groupLabel(p.group),
      lib: p.lib,
      shot: p.shot,
      light: p.light,
      chars: p.chars,
      dup: p.dup,
      done: done.has(p.code),
    })),
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);

  try {
    if (pathname === '/api/prompts') {
      return json(res, queryPrompts(url.searchParams));
    }

    if (pathname === '/api/jobs') {
      return json(res, {
        paused,
        queueLength: queue.filter((j) => j.status === 'queued').length,
        jobs: JOBS.slice(-80).reverse().map((j) => ({
          id: j.id,
          code: j.code,
          group: j.group,
          ratio: j.ratio,
          status: j.status,
          file: j.file,
          error: j.error,
          elapsed: j.elapsed,
          attempts: j.attempts,
          prompt: j.prompt,
        })),
        stats: {
          total: JOBS.length,
          done: JOBS.filter((j) => j.status === 'done').length,
          failed: JOBS.filter((j) => j.status === 'failed').length,
          running: JOBS.filter((j) => j.status === 'running').length,
        },
      });
    }

    if (pathname === '/api/generate' && req.method === 'POST') {
      const body = await parseBody(req);
      const codes = Array.isArray(body.codes) ? body.codes : [];
      if (!codes.length) return json(res, { ok: false, error: '没有选中任何提示词' }, 400);
      const created = [];
      for (const code of codes) {
        try {
          created.push(enqueue(code, { ratio: body.ratio, size: body.size, safe: body.safe }));
        } catch (err) {
          console.warn('[入队跳过]', code, err.message);
        }
      }
      return json(res, { ok: true, added: created.length, jobs: created.map((j) => j.id) });
    }

    if (pathname === '/api/pause' && req.method === 'POST') {
      const body = await parseBody(req);
      paused = Boolean(body.paused);
      if (!paused) drain();
      return json(res, { ok: true, paused });
    }

    if (pathname === '/api/retry' && req.method === 'POST') {
      const body = await parseBody(req);
      const job = BY_ID.get(body.id);
      if (!job || job.status !== 'failed') return json(res, { ok: false, error: '任务不可重试' }, 400);
      job.status = 'queued';
      job.error = '';
      job.attempts = 0;
      queue.push(job);
      drain();
      return json(res, { ok: true });
    }

    if (pathname === '/api/clear' && req.method === 'POST') {
      paused = false;
      queue = queue.filter((j) => j.status !== 'queued');
      return json(res, { ok: true });
    }

    if (pathname.startsWith('/output/')) {
      const name = path.basename(pathname);
      return serveFile(res, path.join(OUTPUT_DIR, name));
    }

    if (pathname === '/' || pathname === '/index.html') {
      return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
    }

    return serveFile(res, path.join(PUBLIC_DIR, pathname));
  } catch (err) {
    console.error('[请求失败]', pathname, err.message);
    return json(res, { ok: false, error: err.message }, 500);
  }
});

server.timeout = 0;
server.headersTimeout = 0;

loadIndex();
server.listen(PORT, HOST, () => {
  console.log('');
  console.log(`  提示词出图工具已启动`);
  console.log(`  http://${HOST}:${PORT}`);
  console.log('');
  console.log(`  提示词 ${PROMPTS.length} 条 / 分组 ${GROUPS.length} 个`);
  console.log(`  模型 ${MODEL}`);
  console.log(`  输出 ${OUTPUT_DIR}`);
  console.log('');
});
