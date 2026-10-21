/**
 * 混元「图生图」云函数
 *
 * 文档：https://docs.cloudbase.net/ai/image-model/wx-server-sdk
 * 模型：HY-Image-v3.0-I2I-ToB-v1.0.1（在文生图参数基础上传入垫图）
 *
 * 入参（event）：
 *   prompt     {string}  必填，提示词，最长 500 字
 *   fileID     {string}  垫图：云存储 fileID（推荐，小程序端先 uploadFile）
 *   imageUrls  {string[]} 垫图：公网可访问 URL 列表，最多 1 张
 *   images     {string[]} 垫图：base64 列表，最多 1 张（注意 callFunction 入参体积上限）
 *   revise     {boolean} 是否开启提示词改写，默认 true（约增加 10s）
 *
 * 出参：
 *   { ok: true, fileID, url, revisedPrompt }
 *   { ok: false, error }
 */

const http = require('http');
const https = require('https');
const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
  timeout: 150000, // 单次 HTTP 请求超时 150s，覆盖默认的 ~15s
});

const I2I_MODEL = 'HY-Image-v3.0-I2I-ToB-v1.0.1';
const MAX_PROMPT_LENGTH = 500;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 垫图上限 10MB
const ALLOWED_SUFFIX = ['jpg', 'jpeg', 'png'];

/** 统一失败返回 */
function fail(error) {
  return { ok: false, error };
}

/** 从文件名 / URL 中取小写后缀，非法时回落 jpg */
function pickSuffix(name = '') {
  const matched = /\.([a-zA-Z0-9]+)(?:[?#].*)?$/.exec(String(name));
  const suffix = matched ? matched[1].toLowerCase() : '';
  return ALLOWED_SUFFIX.includes(suffix) ? suffix : 'jpg';
}

/** 校验垫图后缀（URL 走不到后缀时跳过） */
function assertSuffix(name) {
  const matched = /\.([a-zA-Z0-9]+)(?:[?#].*)?$/.exec(String(name));
  if (!matched) return true; // OSS 链接常无后缀，交给模型侧判断
  return ALLOWED_SUFFIX.includes(matched[1].toLowerCase());
}

/** 下载图片为 Buffer（兼容 http / https） */
function downloadImage(url) {
  return new Promise((resolve, reject) => {
    const client = String(url).startsWith('http://') ? http : https;
    const request = client.get(url, (response) => {
      // 处理 3xx 跳转
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        downloadImage(response.headers.location).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`下载垫图失败，HTTP ${response.statusCode}`));
        return;
      }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });
    request.on('error', reject);
  });
}

/** 云存储 fileID -> 临时 HTTPS 访问链接 */
async function fileIdToUrl(fileID) {
  const { fileList } = await cloud.getTempFileURL({ fileList: [fileID] });
  const item = (fileList || [])[0];
  if (!item || item.status !== 0 || !item.tempFileURL) {
    console.error('[imageToImage] getTempFileURL 失败：', item);
    throw new Error('垫图读取失败，请重新选择图片后重试');
  }
  return item.tempFileURL;
}

exports.main = async (event = {}) => {
  // ---------- 1. 提示词校验 ----------
  const prompt = String(event.prompt || '').trim();
  if (!prompt) return fail('请输入提示词');
  if (prompt.length > MAX_PROMPT_LENGTH) return fail(`提示词最多 ${MAX_PROMPT_LENGTH} 字`);

  // ---------- 2. 垫图归一：image_urls（URL）或 images（base64），二选一非空 ----------
  let imageUrls = Array.isArray(event.imageUrls) ? event.imageUrls.filter(Boolean).slice(0, 1) : [];
  let images = Array.isArray(event.images) ? event.images.filter(Boolean).slice(0, 1) : [];

  // 小程序端推荐走 fileID：先上传到云存储，再换取临时链接
  if (!imageUrls.length && !images.length && event.fileID) {
    try {
      imageUrls = [await fileIdToUrl(event.fileID)];
    } catch (err) {
      return fail(err.message || '垫图读取失败');
    }
  }

  if (!imageUrls.length && !images.length) return fail('请先上传 1 张垫图');

  // 大小 / 格式校验
  for (const url of imageUrls) {
    if (!assertSuffix(url)) return fail('垫图仅支持 jpg、jpeg、png 格式');
  }
  if (images.length) {
    // 文档要求 images 为 base64 列表，这里去掉可能带上的 data URI 前缀
    const raw = String(images[0]).replace(/^data:image\/\w+;base64,/, '');
    if (Buffer.byteLength(raw, 'base64') > MAX_IMAGE_BYTES) return fail('垫图大小不能超过 10MB');
    images = [raw];
  }

  // ---------- 3. 调用图生图模型 ----------
  let generated;
  try {
    const imageModel = cloud.ai().createImageModel('hunyuan-image');
    const res = await imageModel.generateImage({
      model: I2I_MODEL,
      prompt,
      ...(imageUrls.length ? { image_urls: imageUrls } : { images }),
      revise: { value: event.revise !== false },
    });
    generated = (res && res.data && res.data[0]) || {};
  } catch (err) {
    return fail(`生图失败：${err.message || err}`);
  }

  const url = generated.url;
  if (!url) return fail('生图未返回图片地址，请稍后重试');

  // ---------- 4. 转存云存储（官方 URL 仅 24h 有效） ----------
  let fileID = '';
  try {
    const buffer = await downloadImage(url);
    const uploadRes = await cloud.uploadFile({
      cloudPath: `ai-images/i2i/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${pickSuffix(url)}`,
      fileContent: buffer,
    });
    fileID = uploadRes.fileID;
  } catch (err) {
    // 转存失败不阻断流程，仍返回官方临时 URL 兜底
    console.error('[imageToImage] 转存云存储失败：', err);
  }

  return {
    ok: true,
    fileID,
    url, // 24 小时有效，仅作兜底
    revisedPrompt: generated.revised_prompt || '',
  };
};
