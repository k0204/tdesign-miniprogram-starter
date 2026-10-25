/**
 * 「提示词顾问」云函数（DeepSeek 官方 API · 图片理解）
 *
 * 职责很窄：看一眼原图 + 听一句用户的白话需求，产出
 *   1. analysis   一句话诊断（这张图现在最该改什么）
 *   2. candidates 3 条「改动描述」候选，按改动强度递进
 *
 * 为什么直连官方 API 而不是云开发托管的模型组：
 * 托管通道的模型清单、别名与开通状态都由平台侧维护（同一个 Flash 在不同入口叫
 * deepseek-v4.1-flash / deepseek-flash 都可能成立），出问题时很难判断是「没开通」
 * 还是「名字不对」。直连 api.deepseek.com 只有一个变量：API Key 有没有配。
 * 代价是要自己管 Key（环境变量 DEEPSEEK_API_KEY）和请求细节。
 *
 * 为什么只用一次多模态调用、不串两个模型：
 * 能同时吃图 + 文本的模型，一次调用就把「理解需求」和「分析图片」都做完了，
 * 比「文本模型整理需求 -> 视觉模型看图」两次串行更便宜、更快，
 * 也不会在第一次的转述里丢掉用户原话里的细节。
 *
 * 为什么只给「改动」段，不给整段提示词：
 * 生图侧的 buildPrompt 是「锚点 -> 改动 -> 用户补充 -> 参考说明 -> 保持不变 -> 约束行」的
 * 固定拼装，约束行必须最后一句。让模型吐整段，它会把画面描述泛化、把「保持不变」稀释掉，
 * 正好是 imageToImage 里 revise:{value:false} 当初要避开的问题。
 * 所以这里只补最需要语言能力的那一段，锚点与约束仍由模板收口。
 *
 * 入参（event）：
 *   fileID     {string} 必填，主图的云存储 fileID
 *   demand     {string} 用户白话需求，可为空（空则让模型自己看图判断）
 *   scope      {string} 本次允许改动的方向（当前选中的效果说明）
 *   keepHint   {string} 不得触碰的内容清单，只作为边界约束喂给模型，不要求它复述
 *   engineName {string} 仅用于日志
 *
 * 出参：
 *   { ok: true, analysis, candidates: [{ label, text }], model, elapsed }
 *   { ok: false, error }
 */

const http = require('http');
const https = require('https');
const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
  timeout: 55000, // 单次模型调用可能远超默认 ~15s
});

const API_HOST = 'api.deepseek.com';
const API_PATH = '/chat/completions';
/** Key 只从环境变量读，绝不写进代码或返回给客户端 */
const API_KEY_ENV = 'DEEPSEEK_API_KEY';

/**
 * 实测结论（2026-10-25，真图探活两次）：
 * 1. **官方 API 只认 `deepseek-flash`**，传云开发托管侧的名字 `deepseek-v4.1-flash` 会 400
 *    （模型不存在），自动回退后才成功。所以可用名放第一位，第二个留作兜底。
 * 2. **耗时由输出长度决定，不是请求次数**：候选各 ~35 字时 3.3s，各 ~75 字时 5.5s
 *    （按 30-80 字的要求，模型倾向取上限）。想压时间就压字数，别去优化模型名顺序 ——
 *    那次 400 往返在总耗时里是噪声级。
 */
const MODEL_CANDIDATES = ['deepseek-flash', 'deepseek-v4.1-flash'];
/** 主请求预算，占总预算大头 */
const MODEL_TIMEOUT_MS = 20000;
/** 图片 URL 取不到时改用 base64 内联重试，这一轮给更短的预算，避免撞 callFunction 的 60s */
const RETRY_TIMEOUT_MS = 15000;

const MAX_DEMAND_LENGTH = 300;
const MAX_ANALYSIS_LENGTH = 100;
const MAX_CANDIDATES = 3;
/** 候选要写进底部输入框，且总提示词还有 500 字硬限，单条压到 120 */
const CANDIDATE_MAX_LENGTH = 120;
/** 单图上限 32MiB（官方限制），本项目前端已卡 9.5MB，base64 膨胀后仍在 48MiB 请求体预算内 */
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const ALLOWED_SUFFIX = ['jpg', 'jpeg', 'png', 'webp', 'gif'];

/** 三条候选按改动强度递增，label 直接展示给用户 */
const CANDIDATE_LABELS = ['稳妥', '对症', '明显'];

/**
 * system prompt 是全篇最要紧的资产，改动前先想清楚后果：
 *  - 规则 3 禁掉「保持不变」类表述，否则会和模板的约束行重复，还可能盖过后面的 CONSTRAINT_TAIL
 *  - 规则 6 的黑名单来自本页的产品边界（修图不是创作），漏一条就可能在成片里换脸换背景
 *  - 规则 8 让第 2 条优先治技术缺陷，这是「AI 建议」相对静态模板的增量价值所在
 *
 * 注意：DeepSeek 只允许 user 消息带图，system 里放图会 400，所以这里只能是纯文本。
 */
const SYSTEM_PROMPT = [
  '你是摄影后期提示词工程师。用户会给你一张照片和一句白话需求，你为这张照片写图像编辑指令。',
  '',
  '输出规则（必须全部遵守）：',
  '1. 只输出 JSON，不要 markdown 代码块、不要任何解释文字。格式严格为：',
  '{"analysis":"一句话","candidates":["指令一","指令二","指令三"]}',
  '2. candidates 固定 3 条，每条 30-80 个汉字。',
  '3. 只写「要改什么」。绝对不要出现「保持不变」「不要改变」「保持原图」「不修改」这类表述——这部分程序会统一追加，你写了会重复。',
  '4. 每条都是可直接执行的编辑指令，不要出现「建议」「可以」「请」「试试」这类对话口吻，不要写序号。',
  '5. 所有描述必须基于图片里真实存在的内容（人物、物体、场景、光线、色调），禁止虚构画面里没有的东西。',
  '6. 严禁涉及：更换或重绘背景、换脸、改变人物身份或身材、更换服装、添加文字或物体、扩图、裁切、改变构图。',
  '7. 三条要有梯度：第 1 条最保守，最小改动即可见效；第 2 条针对你在图里看到的具体问题；第 3 条效果最强，但仍在原图范围内。',
  '8. 如果画面存在明显技术缺陷（灰雾、欠曝、过曝、偏色、噪点、失焦、硬光、反光、色温错乱），第 2 条必须优先解决它。',
  '9. analysis 不超过 40 个汉字，直接指出问题，不要复述用户需求，不要评价用户的照片。',
].join('\n');

function fail(error) {
  return { ok: false, error };
}

/** 日志里不带 Key，只带它的长度，方便判断「配了但配错」还是「压根没配」 */
function maskKey(key) {
  if (!key) return '(未配置)';
  return `${key.slice(0, 4)}***${key.slice(-2)} · len=${key.length}`;
}

/* ---------------- HTTP ---------------- */

/** 统一 POST JSON，返回 { status, json, text }；网络层错误直接 reject */
function postJson({ hostname, path, body, headers, timeout }) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const request = https.request(
      {
        hostname,
        path,
        method: 'POST',
        headers: Object.assign(
          {
            'Content-Type': 'application/json',
            'Content-Length': payload.length,
          },
          headers
        ),
        timeout,
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
            // 保留 text，错误分支里要看原文才知道上游到底说了什么
          }
          resolve({ status: response.statusCode, json, text });
        });
      }
    );
    request.on('timeout', () => {
      request.destroy(new Error(`请求超时（${timeout}ms）`));
    });
    request.on('error', reject);
    request.write(payload);
    request.end();
  });
}

/** 下载图片为 Buffer（云存储临时链接是 https，这里兼容 http 只为兜底） */
function downloadImage(url) {
  return new Promise((resolve, reject) => {
    const client = String(url).startsWith('http://') ? http : https;
    const request = client.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        downloadImage(response.headers.location).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`下载原图失败，HTTP ${response.statusCode}`));
        return;
      }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });
    // 图片可能有几 MB，别用默认的短超时
    request.setTimeout(15000, () => request.destroy(new Error('下载原图超时')));
    request.on('error', reject);
  });
}

function pickMime(url, suffix) {
  const ext = String(suffix || '').toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return 'image/jpeg';
}

/** 云存储 fileID -> 临时 HTTPS 链接 */
async function fileIdToUrl(fileID) {
  const { fileList } = await cloud.getTempFileURL({ fileList: [fileID] });
  const item = (fileList || [])[0];
  if (!item || item.status !== 0 || !item.tempFileURL) {
    console.error('[promptAdvisor] getTempFileURL 失败：', item);
    throw new Error('原图读取失败，请重新选择图片');
  }
  return item.tempFileURL;
}

/* ---------------- 消息与解析 ---------------- */

/** 用户消息：把「允许改的方向」「不许碰的东西」「他自己的要求」三段分清楚 */
function buildUserText({ demand, scope, keepHint }) {
  const lines = [];
  if (scope) lines.push(`【本次允许改动的方向】${scope}`);
  if (keepHint) lines.push(`【不得建议改动的部分】（仅供你判断边界，不要在输出里复述）${keepHint}`);
  lines.push(
    demand
      ? `【用户需求】${demand}`
      : '【用户需求】（用户没有额外要求，你自己看这张图最需要改什么）'
  );
  lines.push('请按要求输出 JSON。');
  return lines.join('\n');
}

/**
 * 组装 user 的 content 块。
 * 图在前：模型对靠前的图注意力更完整，文字是给图的补充说明。
 * detail 固定 high：单图 token 上限只有 1024，用 low 缩到 512x512 省不了多少，
 * 却正好把「噪点 / 油光 / 轻微失焦」这类要诊断的细节抹平。
 */
function buildUserContent({ imageUrl, dataUrl, demand, scope, keepHint }) {
  const imageBlock = dataUrl
    ? { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } }
    : { type: 'image_url', image_url: { url: imageUrl, detail: 'high' } };
  return [imageBlock, { type: 'text', text: buildUserText({ demand, scope, keepHint }) }];
}

/** 从可能夹着解释文字 / 代码块的文本里抠出第一个完整 JSON 对象 */
function extractJsonObject(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  if (start === -1) return '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return '';
}

/** 单条清洗：去序号、去包裹引号、去句尾标点、压平换行 */
function normalizeText(raw) {
  return String(raw || '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/^\s*(?:\d+\s*[.、)）]|[-*•])\s*/, '')
    .replace(/^[「『"'“]+|[」』"'”]+$/g, '')
    .replace(/[。；;，,]\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function normalizeCandidates(list) {
  const out = [];
  (Array.isArray(list) ? list : []).forEach((item) => {
    if (out.length >= MAX_CANDIDATES) return;
    const text = normalizeText(
      typeof item === 'string' ? item : (item && (item.text || item.prompt)) || ''
    );
    if (!text) return;
    if (text.length < 6) return; // 太短的肯定是模型没听话，丢掉
    out.push({
      label: CANDIDATE_LABELS[out.length] || `方案${out.length + 1}`,
      text: text.slice(0, CANDIDATE_MAX_LENGTH),
    });
  });
  return out;
}

/**
 * 三级兜底：先抠 JSON 解析；失败再按行切；按行切出来的可能混入 analysis，一并滤掉。
 * 不走 response_format 是有意的——官方 vision 文档没承诺这个组合，
 * 万一不认会整个 400，反而不如自己兜住。
 */
function parseAdvice(text) {
  const raw = String(text || '').trim();
  if (!raw) return { analysis: '', candidates: [] };

  const jsonText = extractJsonObject(raw) || raw.replace(/^```(?:json)?/i, '').replace(/```$/, '');
  try {
    const parsed = JSON.parse(jsonText);
    return {
      analysis: normalizeText(parsed.analysis).slice(0, MAX_ANALYSIS_LENGTH),
      candidates: normalizeCandidates(parsed.candidates),
    };
  } catch (err) {
    console.warn('[promptAdvisor] JSON 解析失败，按行兜底：', raw.slice(0, 200));
    const lines = raw
      .split('\n')
      .map((line) => normalizeText(line))
      .filter((line) => line.length >= 10 && !/^analysis|^\{|^\}|^```/.test(line));
    return { analysis: '', candidates: normalizeCandidates(lines) };
  }
}

/* ---------------- 错误翻译 ---------------- */

/** 原始错误只进日志，给用户的一句话必须能懂 */
function friendlyError(err) {
  const msg = String((err && (err.message || err.errMsg)) || err || '');
  const status = err && err.status;
  console.error('[promptAdvisor] 调用失败：', { message: msg, status, detail: err && err.detail });

  if (/请求超时|timeout|ETIMEDOUT/i.test(msg)) return 'AI 看图超时了，稍后再试';
  if (status === 401 || status === 403 || /api ?key|unauthorized/i.test(msg)) {
    return 'AI 建议服务未配置密钥，请联系管理员';
  }
  if (status === 402 || /insufficient|balance|quota/i.test(msg)) return 'AI 服务额度不足，请联系管理员';
  if (status === 429 || /rate ?limit|too many|503/i.test(msg)) return 'AI 忙不过来，缓一下再试';
  if (status === 400 && /model/i.test(msg)) return 'AI 模型名不可用，请联系管理员';
  if (/image|url|download|payload|too large|file/i.test(msg)) return '这张图 AI 读不了，换一张试试';
  return 'AI 没能给出建议，稍后再试';
}

/** 模型名不存在时值得换下一个候选名重试，其它 400 不值得。404/422 一并算上，各网关归一方式不同 */
function isModelNameError(status, message) {
  return (status === 400 || status === 404 || status === 422) && /model/i.test(String(message || ''));
}

/** 400 且跟图片有关，说明模型侧取不到那张 URL，改用 base64 内联再试一次 */
function isImageFetchError(status, message) {
  return status === 400 && /image|url|download|fetch/i.test(String(message || ''));
}

/* ---------------- 主流程 ---------------- */

exports.main = async (event = {}) => {
  const startedAt = Date.now();

  // ---------- 1. 入参 ----------
  const fileID = String(event.fileID || '').trim();
  if (!fileID) return fail('缺少原图，请先选一张图片');

  const apiKey = String(process.env[API_KEY_ENV] || '').trim();
  if (!apiKey) {
    // 立刻返回，不浪费一次网络往返，也不会把 Key 状态泄露给客户端以外的地方
    console.error('[promptAdvisor] 缺少环境变量', API_KEY_ENV);
    return fail('AI 建议服务未配置密钥，请联系管理员');
  }

  const demand = String(event.demand || '').trim().slice(0, MAX_DEMAND_LENGTH);
  const scope = String(event.scope || '').trim().slice(0, 200);
  const keepHint = String(event.keepHint || '').trim().slice(0, 200);

  // ---------- 2. 原图取链接 ----------
  let imageUrl = '';
  try {
    imageUrl = await fileIdToUrl(fileID);
  } catch (err) {
    return fail(err.message || '原图读取失败');
  }

  const headers = { Authorization: `Bearer ${apiKey}` };
  const messagesFor = (image) => [
    // 图只能出现在 user 消息里：system / assistant 带图会被 400
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: buildUserContent({
        imageUrl: image.url,
        dataUrl: image.dataUrl,
        demand,
        scope,
        keepHint,
      }),
    },
  ];

  // ---------- 3. 调模型：模型名逐个试，图片取不到就换 base64 ----------
  let content = '';
  let usedModel = '';
  let usedInline = false;
  let lastError = null;

  for (let i = 0; i < MODEL_CANDIDATES.length; i += 1) {
    const model = MODEL_CANDIDATES[i];
    let attempt;
    try {
      attempt = await postJson({
        hostname: API_HOST,
        path: API_PATH,
        headers,
        timeout: MODEL_TIMEOUT_MS,
        body: {
          model,
          messages: messagesFor({ url: imageUrl }),
          temperature: 0.3,
          max_tokens: 1500,
          stream: false,
        },
      });
    } catch (err) {
      lastError = err;
      break; // 网络层错误换模型名也没用
    }

    const errMsg = (attempt.json && attempt.json.error && attempt.json.error.message) || attempt.text;

    if (attempt.status === 200) {
      content = (attempt.json && attempt.json.choices && attempt.json.choices[0]
        && attempt.json.choices[0].message && attempt.json.choices[0].message.content) || '';
      usedModel = model;
      break;
    }

    // 模型认不出来 -> 换下一个名字继续
    if (isModelNameError(attempt.status, errMsg) && i < MODEL_CANDIDATES.length - 1) {
      console.warn(`[promptAdvisor] 模型名 ${model} 不适用，换下一个：`, errMsg);
      lastError = Object.assign(new Error(errMsg), { status: attempt.status, detail: attempt.text });
      continue;
    }

    // 图取不到 -> 下一轮用 base64 内联重试同一个模型
    if (isImageFetchError(attempt.status, errMsg) && !usedInline) {
      console.warn('[promptAdvisor] 模型侧取不到图，改用 base64 重试：', errMsg);
      try {
        const buffer = await downloadImage(imageUrl);
        if (buffer.length > MAX_IMAGE_BYTES) {
          return fail('这张图太大了，AI 读不了，换一张试试');
        }
        const suffix = (/\.([a-zA-Z0-9]+)(?:[?#].*)?$/.exec(imageUrl) || [])[1] || 'jpg';
        if (ALLOWED_SUFFIX.indexOf(String(suffix).toLowerCase()) === -1) {
          return fail('这张图格式 AI 读不了，换一张试试');
        }
        usedInline = true;
        const dataUrl = `data:${pickMime(imageUrl, suffix)};base64,${buffer.toString('base64')}`;
        const retry = await postJson({
          hostname: API_HOST,
          path: API_PATH,
          headers,
          timeout: RETRY_TIMEOUT_MS,
          body: {
            model,
            messages: messagesFor({ dataUrl }),
            temperature: 0.3,
            max_tokens: 1500,
            stream: false,
          },
        });
        if (retry.status === 200) {
          content = (retry.json && retry.json.choices && retry.json.choices[0]
            && retry.json.choices[0].message && retry.json.choices[0].message.content) || '';
          usedModel = model;
          break;
        }
        lastError = Object.assign(new Error(String(retry.text).slice(0, 300)), {
          status: retry.status,
          detail: retry.text,
        });
      } catch (err) {
        lastError = err;
      }
    } else {
      lastError = Object.assign(new Error(errMsg), { status: attempt.status, detail: attempt.text });
    }
    break;
  }

  if (!content) {
    return fail(friendlyError(lastError || new Error('模型没有返回内容')));
  }

  // ---------- 4. 解析 ----------
  const { analysis, candidates } = parseAdvice(content);
  const elapsed = Date.now() - startedAt;

  console.log('[promptAdvisor] 完成', {
    elapsed,
    engine: event.engineName || '',
    model: usedModel,
    inlineImage: usedInline,
    key: maskKey(apiKey),
    demandLength: demand.length,
    candidateCount: candidates.length,
  });

  if (!candidates.length) {
    console.warn('[promptAdvisor] 模型没给出可用候选，原始文本：', String(content).slice(0, 500));
    return fail('AI 没看懂这张图，换个说法或换张图试试');
  }

  return {
    ok: true,
    analysis,
    candidates,
    model: usedModel,
    elapsed,
  };
};
