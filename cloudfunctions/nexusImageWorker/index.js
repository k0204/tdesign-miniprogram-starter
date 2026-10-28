/**
 * Nexus 生图 · 执行侧（worker）
 *
 * 由 `nexusImage`（派发侧）在服务端触发，**不面向客户端直接调用**。
 * 存在意义和 agnesImageWorker 一样：绕过 `wx.cloud.callFunction` 的 60s 客户端上限。
 *
 * ============ 上游接口（对照 TurnaroundViewer/Services/NexusImageGenerator.cs） ============
 *   Base   POST https://sub.ainexusplus.com
 *   文生图  /v1/images/generations   JSON
 *   图生图  /v1/images/edits         JSON（**不是 multipart**）
 *   body   { model, prompt, n:1, size, output_format:'png', quality:'high' }
 *          图生图额外带 images: [{ image_url: 'data:image/png;base64,...' }]
 *   响应   data[0].b64_json 或 data[0].url（也兼容 image_url / result_url）
 *
 * ============ 四个必须保留的适配（都是实测踩过的） ============
 *   1) **必须带浏览器 User-Agent**，否则被 Cloudflare 拦 403（error 1010）
 *   2) images 必须是**对象数组** `[{image_url}]`，直接甩字符串数组会被拒
 *   3) **size 按原图比例算，不要写死 1024x1024**（实测 2026-10-22）：
 *      传 1536x1024 → 出 1536x1024；传 1024x1536 → 出 1024x1536；
 *      传非标准尺寸 1152x864 → 出 1448x1086，**比例仍是 4:3**。
 *      也就是说网关接受任意 size 并按比例出图，只是像素数会被它归一到约 1.57MP。
 *      所以这里只负责「算一个比例正确的尺寸」，不负责猜最终像素。
 *   4) 不要传 `background: 'white'`（C# 那边是给角色三视图用的）：
 *      本页是照片修图，强制白底会毁掉原图背景。
 *
 * ============ 部署要求 ============
 * 1) 本函数执行超时必须在腾讯云 CloudBase 控制台调到 240s（默认 3s，3s 一定失败）
 * 2) 环境变量 NEXUS_API_KEY（与 nexusImage 各配一份，互不共享）
 * 3) 环境变量 NEXUS_API_HOST 可选，缺省 sub.ainexusplus.com
 * 4) 环境变量 NEXUS_MODEL 可选，缺省 gpt-image-2
 *
 * 入参（event）：
 *   taskId     {string}   必填，nexusImage 创建的任务文档 _id
 *   prompt     {string}   提示词
 *   size       {string}   '宽x高'，已按原图比例算好（缺省按 ratio 兜底）
 *   ratio      {string}   比例档，仅在 size 缺失时用来兜底算尺寸
 *   fileIDs    {string[]} 垫图云存储 fileID（小程序端主路径，最多 4 张）
 *   imageUrls  {string[]} 垫图公网 URL
 *   images     {string[]} 垫图 base64 / data URI
 *
 * 出参：{ ok, fileID?, url?, size, imageCount, elapsed } 或 { ok:false, error }
 *       （任务状态以数据库为准，返回值只用于日志）
 */

const https = require('https');
const http = require('http');
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV, timeout: 150000 });

const COLLECTION = 'ai_image_tasks';

/**
 * 接口地址：默认 sub.ainexusplus.com，可用环境变量 NEXUS_API_HOST 覆盖。
 * https.request 的 hostname 不能带协议，环境变量里手写成 `https://sub.ainexusplus.com`
 * 会直接报 ENOTFOUND 却很难看出原因，所以这里统一做一次规范化。
 */
function resolveEndpoint(raw) {
  const DEFAULT_HOST = 'sub.ainexusplus.com';
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

const ENDPOINT = resolveEndpoint(process.env.NEXUS_API_HOST);
const API_HOST = ENDPOINT.hostname;
const API_BASE = ENDPOINT.basePath;
const MODEL = String(process.env.NEXUS_MODEL || 'gpt-image-2').trim();
const API_KEY = process.env.NEXUS_API_KEY || '';

/**
 * 浏览器 UA：Cloudflare 会按 UA 拦非浏览器客户端（403 / error 1010）。
 * 这一行不能删，删了线上直接 403。
 */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** 出图质量：high 更接近成片，代价是慢一些（实测 low 18s / high 40-90s） */
const QUALITY = 'high';

/**
 * 时间预算：gpt-image quality=high 常见 40-90s，留出一次重试 + 转存的余量。
 * 必须小于本函数配置的执行超时（240s）。
 */
const TOTAL_BUDGET_MS = 180 * 1000;
const REQUEST_TIMEOUT_MS = 150 * 1000;
/**
 * 退避照抄 C# 那边（5s × 第几次），只对「没接单」的情况重试：
 * 408 / 425 / 429 / 5xx。模型已经出图后再重试等于白烧一次。
 */
const MAX_ATTEMPTS = 3;

const MAX_INPUT_IMAGES = 4;
const ALLOWED_SUFFIX = ['jpg', 'jpeg', 'png', 'webp'];

/**
 * gpt-image-2 官方尺寸约束（developers.openai.com/api/docs/guides/image-generation）：
 *   - size 支持任意「宽x高」（不是只有 1024x1024/1536x1024/1024x1536 三档）
 *   - 两条边必须都是 **16** 的倍数（注意不是 8）
 *   - 长边 : 短边 ≤ **3:1**
 *   - 总像素 [655,360, 8,294,400]，最大边长 ≤ 3840
 *   - 超过 2560x1440（2K）属实验性能力
 *
 * 客户端已经按这套规则算好 size 传进来；这里再校验一遍，防止旧版客户端/直接调用传错。
 */
const SIZE_ALIGN = 16;
const TARGET_PIXELS = 1536 * 1024;
const MIN_PIXELS = 655360;
const MAX_PIXELS = 8294400;
const MAX_RATIO = 3;

// ---------------- 工具 ----------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickSuffix(name = '') {
  const matched = /\.([a-zA-Z0-9]+)(?:[?#].*)?$/.exec(String(name));
  const suffix = matched ? matched[1].toLowerCase() : '';
  return ALLOWED_SUFFIX.includes(suffix) ? suffix : 'png';
}

function mimeOf(suffix) {
  if (suffix === 'jpg' || suffix === 'jpeg') return 'image/jpeg';
  if (suffix === 'webp') return 'image/webp';
  return 'image/png';
}

function randomSuffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 把任意「宽x高」修成合法请求尺寸：
 * 1) 比例夹进 [1/3, 3]（超过 3:1 官方不接受）
 * 2) 按目标像素反解宽高（保持比例）
 * 3) 两边对齐到 16 的倍数
 * 4) 对齐后若像素越界，按同比例缩放到目标像素再来一次
 */
function fitOfficialSize(width, height) {
  const ratio = Math.min(MAX_RATIO, Math.max(1 / MAX_RATIO, width / height));
  const align16 = (value) => Math.max(SIZE_ALIGN, Math.round(value / SIZE_ALIGN) * SIZE_ALIGN);

  let w = align16(Math.sqrt(TARGET_PIXELS * ratio));
  let h = align16(w / ratio);

  // 对齐取整可能把比例顶过 3:1，这里往上取整收口（2176x720 → 2176x736）
  const longSide = Math.max(w, h);
  const shortSide = Math.min(w, h);
  if (longSide / shortSide > MAX_RATIO) {
    const fixed = Math.ceil(longSide / MAX_RATIO / SIZE_ALIGN) * SIZE_ALIGN;
    if (w >= h) h = fixed;
    else w = fixed;
  }

  const pixels = w * h;
  if (pixels < MIN_PIXELS || pixels > MAX_PIXELS) {
    const scale = Math.sqrt(TARGET_PIXELS / Math.max(pixels, 1));
    w = align16(w * scale);
    h = align16(h * scale);
  }
  return `${w}x${h}`;
}

/** 只接受「宽x高」，否则按 ratio 兜底，最后退回 1024x1024 */
function normalizeSize(raw, ratioText) {
  const value = String(raw || '').trim().toLowerCase().replace(/\s*\*\s*/, 'x');
  const matched = /^(\d{2,5})x(\d{2,5})$/.exec(value);
  if (matched) {
    const w = Number(matched[1]);
    const h = Number(matched[2]);
    if (w >= SIZE_ALIGN && h >= SIZE_ALIGN) return fitOfficialSize(w, h);
  }

  const parts = String(ratioText || '1:1').split(':').map(Number);
  if (parts[0] > 0 && parts[1] > 0) return fitOfficialSize(parts[0], parts[1]);
  return '1024x1024';
}

/**
 * 读图片真实像素（用于把「实际出图尺寸」写进任务表）：
 * 网关会把非标准 size 归一化，前端展示的是请求值，库里记实际值才好对账。
 */
function readImageSize(buffer) {
  try {
    if (!buffer || buffer.length < 26) return '';
    // PNG: 8 字节签名 + 4 字节长度 + 'IHDR' + 宽 + 高
    if (buffer[0] === 0x89 && buffer.toString('ascii', 1, 4) === 'PNG') {
      return `${buffer.readUInt32BE(16)}x${buffer.readUInt32BE(20)}`;
    }
    // JPEG: 逐段找 SOF0/SOF1/SOF2
    if (buffer[0] === 0xff && buffer[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = buffer[offset + 1];
        const length = buffer.readUInt16BE(offset + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return `${buffer.readUInt16BE(offset + 7)}x${buffer.readUInt16BE(offset + 5)}`;
        }
        offset += 2 + length;
      }
    }
  } catch (err) {
    console.error('[nexusImageWorker] 读取图片尺寸失败：', err);
  }
  return '';
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
    console.error('[nexusImageWorker] 回写任务失败：', err);
  }
}

// ---------------- HTTP ----------------

function postJson(path, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const request = https.request(
      {
        hostname: API_HOST,
        path: `${API_BASE}${path}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
          Authorization: `Bearer ${API_KEY}`,
          'User-Agent': BROWSER_UA,
          Accept: 'application/json',
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

/** 从 OpenAI 兼容响应里取图：优先 b64_json，其次 url（兼容 image_url / result_url） */
function readImage(json) {
  if (!json) return { b64: '', url: '' };
  const first = Array.isArray(json.data) ? json.data[0] : null;
  if (first && (first.b64_json || first.url)) {
    return { b64: first.b64_json || '', url: first.url || '' };
  }
  return { b64: '', url: json.image_url || json.result_url || '' };
}

/**
 * 调 Nexus 生图，带「限流 / 网关临时故障」的退避重试。
 * 重试只针对没接单的情况；网络超时不重试（请求可能已经进去并出图了）。
 */
async function callNexus(path, body, deadline) {
  let lastError = '';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining < 10000) throw new Error(lastError || '生成超时，请稍后重试');

    const timeout = Math.min(REQUEST_TIMEOUT_MS, remaining - 5000);

    let res;
    try {
      res = await postJson(path, body, timeout);
    } catch (err) {
      // 超时可能已经出图，不重试直接报
      throw new Error(`生成超时或网络异常：${err.message}，请稍后重试`);
    }

    const image = readImage(res.json);
    if (res.status === 200 && (image.b64 || image.url)) return image;

    const message =
      (res.json && res.json.error && (res.json.error.message || res.json.error)) ||
      res.text.slice(0, 200) ||
      `HTTP ${res.status}`;

    if (res.status === 200) {
      console.error('[nexusImageWorker] 200 但无图：', res.text.slice(0, 400));
      throw new Error('模型未返回图片，请换个提示词重试');
    }
    if (res.status === 401) {
      throw new Error('Nexus 鉴权失败，请检查云函数环境变量 NEXUS_API_KEY');
    }
    if (res.status === 403) {
      // 最常见是 Cloudflare 按 UA 拦（error 1010），其次是 key 没权限
      console.error('[nexusImageWorker] 403 响应：', res.text.slice(0, 300));
      throw new Error('Nexus 拒绝了这次请求（403），请检查 API Key 与网关放行');
    }
    if (res.status === 404) {
      throw new Error(`模型不可用：${message}`);
    }

    const retryable =
      res.status === 408 || res.status === 425 || res.status === 429 || res.status >= 500;
    if (!retryable) throw new Error(String(message));

    lastError = String(message);
    if (attempt === MAX_ATTEMPTS) break;

    const backoff = 5000 * attempt;
    if (Date.now() + backoff > deadline - 30000) break;

    console.warn(`[nexusImageWorker] ${lastError}，${backoff}ms 后重试（第 ${attempt} 次）`);
    await sleep(backoff);
  }

  throw new Error(lastError || '生成失败，请稍后重试');
}

/** 下载图片为 Buffer（兼容 http / https，最多跟随 3 次 3xx） */
function downloadImage(url, timeoutMs, depth = 0) {
  return new Promise((resolve, reject) => {
    const client = String(url).startsWith('http://') ? http : https;
    const onResponse = (response) => {
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
        downloadImage(response.headers.location, timeoutMs, depth + 1).then(resolve, reject);
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
    };
    // 取图链接同样过 Cloudflare，UA 也要带
    const request = client.get(url, { headers: { 'User-Agent': BROWSER_UA } }, onResponse);
    request.on('error', reject);
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('下载生成图超时'));
    });
  });
}

// ---------------- 垫图 ----------------

/** 单次请求的垫图总字节上限：4 张大图 base64 后会膨胀 4/3，超了容易把函数内存打满 */
const MAX_INPUT_BYTES = 15 * 1024 * 1024;

/**
 * 云存储 fileID -> base64 data URI。
 *
 * 为什么不直接把临时链接丢给 Nexus：images[].image_url 虽然也收 URL，
 * 但链接要由网关侧回源拉取，一旦拉不到只会回一个笼统的 400/参数错误，
 * 排查成本极高。data URI 是自包含的，出问题一定是我们的图有问题。
 */
async function fileIdToDataUri(fileID) {
  const res = await cloud.downloadFile({ fileID });
  const buffer = res && res.fileContent;
  if (!buffer || !buffer.length) throw new Error('垫图读取失败，请重新选择图片后重试');
  const suffix = pickSuffix(fileID);
  return {
    dataUri: `data:${mimeOf(suffix)};base64,${buffer.toString('base64')}`,
    bytes: buffer.length,
  };
}

/** 收集垫图，输出 data URI / URL 数组（顺序即参考顺序，最多 4 张） */
async function resolveInputImages(event) {
  const fileIDs = Array.isArray(event.fileIDs)
    ? event.fileIDs.filter(Boolean).map(String).slice(0, MAX_INPUT_IMAGES)
    : [];
  if (!fileIDs.length && event.fileID) fileIDs.push(String(event.fileID));
  if (fileIDs.length) {
    const list = [];
    let total = 0;
    for (let i = 0; i < fileIDs.length; i += 1) {
      const item = await fileIdToDataUri(fileIDs[i]);
      total += item.bytes;
      if (total > MAX_INPUT_BYTES) {
        throw new Error('参考图太大了，换张小一点的图再试（合计 15MB 以内）');
      }
      list.push(item.dataUri);
    }
    return list;
  }

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
      throw new Error('未配置 Nexus API Key，请在云函数环境变量中设置 NEXUS_API_KEY');
    }

    const prompt = String(event.prompt || '').trim();
    if (!prompt) throw new Error('请输入提示词');

    const size = normalizeSize(event.size, event.ratio);
    const body = {
      model: MODEL,
      prompt,
      n: 1,
      size,
      output_format: 'png',
      quality: QUALITY,
    };

    const inputs = await resolveInputImages(event);
    // 有垫图走 edits，纯文生图走 generations
    const path = inputs.length ? '/v1/images/edits' : '/v1/images/generations';
    if (inputs.length) body.images = inputs.map((imageUrl) => ({ image_url: imageUrl }));

    const image = await callNexus(path, body, deadline);

    let buffer = null;
    let sourceUrl = image.url || '';
    if (image.b64) {
      buffer = Buffer.from(image.b64, 'base64');
    } else if (image.url) {
      const budget = Math.max(deadline - Date.now(), 10000);
      buffer = await downloadImage(image.url, budget);
    }
    if (!buffer || !buffer.length) throw new Error('模型未返回图片，请稍后重试');

    // 实际出图尺寸：网关会把非标准 size 归一化，记下来才对得上账
    const actualSize = readImageSize(buffer) || size;

    // Nexus 的链接会过期，必须转存云存储；文件 URL 不能进业务表
    let fileID = '';
    try {
      const suffix = image.url ? pickSuffix(image.url) : 'png';
      const uploadRes = await cloud.uploadFile({
        cloudPath: `ai-images/nexus/${randomSuffix()}.${suffix === 'png' ? 'png' : suffix}`,
        fileContent: buffer,
      });
      fileID = uploadRes.fileID;
    } catch (err) {
      // 转存失败不阻断：前端可以用临时链接兜底显示
      console.error('[nexusImageWorker] 转存云存储失败：', err);
    }

    const elapsed = Date.now() - startedAt;
    await patchTask(taskId, {
      status: 'done',
      fileID,
      stored: !!fileID,
      url: sourceUrl,
      size: actualSize,
      requestSize: size,
      imageCount: inputs.length,
      elapsed,
      finishedAt: Date.now(),
    });

    return { ok: true, fileID, url: sourceUrl, size: actualSize, imageCount: inputs.length, elapsed };
  } catch (err) {
    const message = (err && err.message) || '生成失败，请稍后重试';
    console.error('[nexusImageWorker] 生成失败：', message);
    await patchTask(taskId, {
      status: 'failed',
      error: message,
      elapsed: Date.now() - startedAt,
      finishedAt: Date.now(),
    });
    return { ok: false, error: message };
  }
};
