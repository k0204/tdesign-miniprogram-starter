/**
 * Agnes 生图 · 执行侧（worker）
 *
 * 由 `agnesImage`（派发侧）在服务端触发，**不面向客户端直接调用**。
 * 存在意义只有一个：绕过 `wx.cloud.callFunction` 的 60s 客户端硬上限。
 * 派发侧秒回 taskId，这里可以跑满 200s；跑完把结果写回 `ai_image_tasks`，
 * 客户端靠轮询读结果。
 *
 * ============ 部署要求 ============
 * 1) 本函数执行超时必须在腾讯云 CloudBase 控制台调到 240s（默认 3s，3s 一定失败）
 * 2) 环境变量 AGNES_API_KEY 与 agnesImage 共用（同一个环境，分别配置）
 * 3) 环境变量 AGNES_API_HOST 可选，接口地址，缺省 api.agnes-ai.cn（换镜像/代理时才配）
 *
 * 入参（event）：
 *   taskId     {string}   必填，agnesImage 创建的任务文档 _id
 *   prompt     {string}   提示词
 *   fileIDs    {string[]} 垫图云存储 fileID（小程序端主路径，最多 4 张）
 *   imageUrls  {string[]} 垫图公网 URL
 *   images     {string[]} 垫图 base64 / data URI
 *   size       {string}   '1K'|'2K'|'3K'|'4K' 或精确尺寸
 *   ratio      {string}   档位式 size 时的比例
 *
 * 出参：{ ok, fileID?, url?, imageCount, elapsed } 或 { ok:false, error }
 *       （任务状态以数据库为准，返回值只用于日志）
 */

const https = require('https');
const http = require('http');
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV, timeout: 150000 });

const COLLECTION = 'ai_image_tasks';

/**
 * 接口地址：默认 api.agnes-ai.cn，可用环境变量 AGNES_API_HOST 覆盖。
 * https.request 的 hostname 不能带协议，环境变量里手写成 `https://api.agnes-ai.cn`
 * 会直接报 ENOTFOUND 却很难看出原因，所以这里统一做一次规范化：
 * 剥掉协议头与末尾斜杠，允许附带基础路径（如 `https://proxy.com/agnes`）。
 */
function resolveEndpoint(raw) {
  const DEFAULT_HOST = 'api.agnes-ai.cn';
  const value = String(raw || '').trim();
  if (!value) return { hostname: DEFAULT_HOST, basePath: '' };
  const withoutScheme = value.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '').replace(/\/+$/, '');
  const slash = withoutScheme.indexOf('/');
  if (slash === -1) return { hostname: withoutScheme || DEFAULT_HOST, basePath: '' };
  return {
    hostname: withoutScheme.slice(0, slash) || DEFAULT_HOST,
    basePath: withoutScheme.slice(slash),
  };
}

const ENDPOINT = resolveEndpoint(process.env.AGNES_API_HOST);
const API_HOST = ENDPOINT.hostname;
const API_PATH = `${ENDPOINT.basePath}/v1/images/generations`;
const MODEL = 'agnes-image-2.5-flash';
const API_KEY = process.env.AGNES_API_KEY || '';

/**
 * 时间预算。既然客户端不再等，就把预算放大到 200s：
 * 图生图单次 85-96s，留出「一次 503 重试 + 转存」的余量。
 * 必须小于本函数配置的执行超时（240s），给回写数据库留收尾时间。
 */
const TOTAL_BUDGET_MS = 200 * 1000;
const REQUEST_TIMEOUT_MS = 150 * 1000;
/**
 * 503「队列满」是当前最主要的失败原因（实测图生图 9 次里 6 次撞上）。
 * 既然客户端不再等，退避窗口就拉长到 ~92s、最多 6 次尝试：
 * 出一次图约 93s，所以退避完之后还剩不到 100s 就不再试了，
 * 免得请求刚发出去就被预算切断，白烧一次。
 */
const RETRY_BACKOFF = [4000, 8000, 15000, 25000, 40000];

const MAX_PROMPT_LENGTH = 2000;
const MAX_INPUT_IMAGES = 4;
const ALLOWED_SUFFIX = ['jpg', 'jpeg', 'png', 'webp'];

const SIZE_TIERS = ['1K', '2K', '3K', '4K'];
const RATIOS = ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9'];

// ---------------- 工具 ----------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSize(raw) {
  const value = String(raw || '').trim().toUpperCase();
  if (SIZE_TIERS.includes(value)) return { size: value, tiered: true };
  const matched = /^(\d{3,4})\s*[xX*]\s*(\d{3,4})$/.exec(value);
  if (matched) return { size: `${matched[1]}x${matched[2]}`, tiered: false };
  return { size: '1K', tiered: true };
}

function normalizeRatio(raw) {
  const value = String(raw || '').trim();
  return RATIOS.includes(value) ? value : '1:1';
}

function pickSuffix(name = '') {
  const matched = /\.([a-zA-Z0-9]+)(?:[?#].*)?$/.exec(String(name));
  const suffix = matched ? matched[1].toLowerCase() : '';
  return ALLOWED_SUFFIX.includes(suffix) ? suffix : 'png';
}

function randomSuffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------- 任务状态回写 ----------------

/** 任务状态一律以数据库为准；回写失败只记日志，不覆盖原始错误 */
async function patchTask(taskId, patch) {
  try {
    await cloud
      .database()
      .collection(COLLECTION)
      .doc(taskId)
      .update({ data: { ...patch, updatedAt: Date.now() } });
  } catch (err) {
    console.error('[agnesImageWorker] 回写任务失败：', err);
  }
}

// ---------------- HTTP ----------------

function postJson(body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const request = https.request(
      {
        hostname: API_HOST,
        path: API_PATH,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
          Authorization: `Bearer ${API_KEY}`,
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (err) {
            json = null;
          }
          resolve({ status: response.statusCode, json, text });
        });
        response.on('error', reject);
      }
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）`));
    });
    request.on('error', reject);
    request.write(payload);
    request.end();
  });
}

/**
 * 调 Agnes 生图，带「503 队列满 / 429 限流」的退避重试。
 * 重试只针对没接单的情况；网络超时不重试（请求可能已经进去并出图了）。
 */
async function callAgnes(body, deadline) {
  let lastError = '';

  for (let attempt = 0; attempt <= RETRY_BACKOFF.length; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining < 8000) {
      throw new Error(lastError || '生成超时，请稍后重试');
    }

    const timeout = Math.min(REQUEST_TIMEOUT_MS, remaining - 5000);

    let res;
    try {
      res = await postJson(body, timeout);
    } catch (err) {
      throw new Error(`生成超时或网络异常：${err.message}，请稍后重试`);
    }

    const first = res.json && res.json.data && res.json.data[0];
    if (res.status === 200 && first) return res.json;

    const message =
      (res.json && res.json.error && res.json.error.message) || `HTTP ${res.status}`;

    if (res.status === 200) {
      console.error('[agnesImageWorker] 返回 200 但无 data：', res.text.slice(0, 300));
      throw new Error('模型未返回图片，请换个提示词重试');
    }
    if (res.status === 401) {
      throw new Error('Agnes 鉴权失败，请检查云函数环境变量 AGNES_API_KEY');
    }
    if (res.status === 404) {
      throw new Error(`模型不可用：${message}`);
    }

    const retryable = res.status === 429 || res.status === 503 || res.status >= 500;
    const backoff = RETRY_BACKOFF[attempt];

    if (!retryable) throw new Error(message);

    lastError = message;
    if (backoff === undefined) break;
    // 出一次图约 93s，退避完剩不到 100s 就别再试了
    if (Date.now() + backoff > deadline - 100000) break;

    console.warn(`[agnesImageWorker] ${message}，${backoff}ms 后重试（第 ${attempt + 1} 次）`);
    await sleep(backoff);
  }

  throw new Error(lastError || '生成失败，请稍后重试');
}

/** 下载图片为 Buffer（兼容 http / https，最多跟随 3 次 3xx） */
function downloadImage(url, timeoutMs, depth = 0) {
  return new Promise((resolve, reject) => {
    const client = String(url).startsWith('http://') ? http : https;
    const request = client.get(url, (response) => {
      if (
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        response.resume();
        if (depth >= 3) {
          reject(new Error('下载生成图失败：重定向次数过多'));
          return;
        }
        downloadImage(response.headers.location, timeoutMs, depth + 1).then(
          resolve,
          reject
        );
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`下载生成图失败，HTTP ${response.statusCode}`));
        return;
      }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('下载生成图超时'));
    });
  });
}

// ---------------- 垫图 ----------------

/** 云存储 fileID 列表 -> 临时 HTTPS 链接（批量一次换） */
async function fileIdsToUrls(fileIDs) {
  const { fileList } = await cloud.getTempFileURL({ fileList: fileIDs });
  const items = fileList || [];
  const urls = [];
  for (let i = 0; i < fileIDs.length; i += 1) {
    const item = items[i];
    if (!item || item.status !== 0 || !item.tempFileURL) {
      console.error('[agnesImageWorker] getTempFileURL 失败：', item);
      return null;
    }
    urls.push(item.tempFileURL);
  }
  return urls;
}

/** 收集垫图，输出 Agnes 需要的 HTTPS URL 或 data URI 数组（顺序即参考顺序） */
async function resolveInputImages(event) {
  const urls = Array.isArray(event.imageUrls)
    ? event.imageUrls.filter(Boolean).map(String)
    : [];
  if (urls.length) return urls.slice(0, MAX_INPUT_IMAGES);

  const raws = Array.isArray(event.images) ? event.images.filter(Boolean).map(String) : [];
  if (raws.length) {
    return raws.slice(0, MAX_INPUT_IMAGES).map((item) => {
      if (/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(item)) return item;
      const bare = item.replace(/^data:image\/\w+;base64,/, '');
      return `data:image/png;base64,${bare}`;
    });
  }

  const fileIDs = Array.isArray(event.fileIDs)
    ? event.fileIDs.filter(Boolean).map(String).slice(0, MAX_INPUT_IMAGES)
    : [];
  if (!fileIDs.length && event.fileID) fileIDs.push(String(event.fileID));
  if (fileIDs.length) {
    const tempUrls = await fileIdsToUrls(fileIDs);
    if (!tempUrls) throw new Error('垫图读取失败，请重新选择图片后重试');
    return tempUrls;
  }

  return [];
}

// ---------------- 主流程 ----------------

exports.main = async (event = {}) => {
  const startedAt = Date.now();
  const deadline = startedAt + TOTAL_BUDGET_MS;
  const taskId = String(event.taskId || '');

  if (!taskId) return { ok: false, error: '缺少 taskId' };

  await patchTask(taskId, { status: 'running' });

  try {
    if (!API_KEY) {
      throw new Error('未配置 Agnes API Key，请在云函数环境变量中设置 AGNES_API_KEY');
    }

    const prompt = String(event.prompt || '').trim();
    if (!prompt) throw new Error('请输入提示词');
    if (prompt.length > MAX_PROMPT_LENGTH) {
      throw new Error(`提示词最多 ${MAX_PROMPT_LENGTH} 字`);
    }

    const { size, tiered } = normalizeSize(event.size);
    const body = {
      model: MODEL,
      prompt,
      size,
      // response_format 必须放 extra_body，放顶层会被忽略（官方明确说明）
      extra_body: { response_format: 'url' },
    };
    if (tiered) body.ratio = normalizeRatio(event.ratio);

    const inputs = await resolveInputImages(event);
    if (inputs.length) body.extra_body.image = inputs;

    const result = await callAgnes(body, deadline);
    const url = result.data[0].url;
    if (!url) throw new Error('模型未返回图片地址，请稍后重试');

    // Agnes 的 COS 链接会过期，必须转存云存储；文件URL不能进业务表
    let fileID = '';
    try {
      const budget = Math.max(deadline - Date.now(), 10000);
      const buffer = await downloadImage(url, budget);
      const uploadRes = await cloud.uploadFile({
        cloudPath: `ai-images/agnes/${randomSuffix()}.${pickSuffix(url)}`,
        fileContent: buffer,
      });
      fileID = uploadRes.fileID;
    } catch (err) {
      // 转存失败不阻断：仍把官方链接写进任务，前端可以用它兜底显示
      console.error('[agnesImageWorker] 转存云存储失败：', err);
    }

    const elapsed = Date.now() - startedAt;
    await patchTask(taskId, {
      status: 'done',
      fileID,
      stored: !!fileID,
      url,
      size,
      imageCount: inputs.length,
      elapsed,
      finishedAt: Date.now(),
    });

    return { ok: true, fileID, url, size, imageCount: inputs.length, elapsed };
  } catch (err) {
    const message = (err && err.message) || '生成失败，请稍后重试';
    console.error('[agnesImageWorker] 生成失败：', message);
    await patchTask(taskId, {
      status: 'failed',
      error: message,
      elapsed: Date.now() - startedAt,
      finishedAt: Date.now(),
    });
    return { ok: false, error: message };
  }
};
