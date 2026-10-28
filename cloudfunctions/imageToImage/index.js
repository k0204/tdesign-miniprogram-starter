/**
 * 混元「图生图」云函数
 *
 * 文档：https://docs.cloudbase.net/ai/image-model/wx-server-sdk
 * 模型：HY-Image-v3.0-I2I-ToB-v1.0.1（在文生图参数基础上传入垫图）
 *
 * 入参（event）：
 *   prompt     {string}  必填，提示词
 *   size       {string}  出图尺寸 "宽x高"，宽高 [512,2048]、面积 ≤ 1024x1024，默认 1024x1024
 *   fileID     {string}  垫图：云存储 fileID（小程序端主路径，最长边即原图分辨率）
 *   images     {string[]} 垫图：base64 列表，最多 1 张（备用，受 callFunction 约 1MB 入参限制）
 *   imageUrls  {string[]} 垫图：公网可访问 URL 列表，最多 1 张（外部调用时使用）
 *
 * 垫图优先级：imageUrls > images > fileID（客户端每次只传其中一种，不会冲突）。
 *
 * 注意：本函数固定关闭提示词改写（revise: false），不接受外部传入。
 * 理由：修图场景的提示词是精确的局部编辑指令，交给模型改写会变成泛化的画面描述，
 * 直接破坏「只改一处、其余不变」的约束。代价是失去改写带来的画面丰富度，这是有意为之。
 *
 * 水印：混元出图默认在右下角打「图片由 AI 生成」，关不掉（合规要求），
 * 只能通过 footnote 换文案，统一由下方 WATERMARK_TEXT 常量控制。
 *
 * 出参：
 *   { ok: true, fileID, url }
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

/**
 * 出图右下角水印文案，替换混元默认的「图片由 AI 生成」。
 *
 * 通过 CloudBase AI SDK 的 footnote 参数下发，服务端在生图时同步叠加，不额外增加耗时。
 * 水印本身关不掉（合规要求，SDK 不开放 LogoAdd=0），只能改文案，所以这里是唯一的调节点。
 */
const WATERMARK_TEXT = '空谷';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 垫图上限 10MB
const ALLOWED_SUFFIX = ['jpg', 'jpeg', 'png'];

/** 出图尺寸约束（官方 ImageModel 文档）：宽高各自 [512, 2048]，面积不超过 1024x1024 */
const DEFAULT_SIZE = '1024x1024';
const SIZE_PATTERN = /^(\d{3,4})x(\d{3,4})$/;
const MIN_SIDE = 512;
const MAX_SIDE = 2048;
const MAX_AREA = 1024 * 1024;

/** 统一失败返回 */
function fail(error) {
  return { ok: false, error };
}

/**
 * 校验并归一化出图尺寸。
 * 不传或越界时回落 1024x1024——不静默截断，避免客户端算错比例后画面被拉伸。
 */
function normalizeSize(raw) {
  const matched = SIZE_PATTERN.exec(String(raw || ''));
  if (!matched) return DEFAULT_SIZE;
  const width = Number(matched[1]);
  const height = Number(matched[2]);
  if (width < MIN_SIDE || width > MAX_SIDE || height < MIN_SIDE || height > MAX_SIDE) {
    return DEFAULT_SIZE;
  }
  if (width * height > MAX_AREA) return DEFAULT_SIZE;
  return `${width}x${height}`;
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

  // ---------- 2. 垫图归一：image_urls（URL）或 images（base64），二选一非空 ----------
  let imageUrls = Array.isArray(event.imageUrls) ? event.imageUrls.filter(Boolean).slice(0, 1) : [];
  let images = Array.isArray(event.images) ? event.images.filter(Boolean).slice(0, 1) : [];

  // 外部传入的链接先自己取一遍。混元侧取不到图只会回一个笼统的 400，
  // 用户完全看不出是「链接失效 / 私有桶签名过期」，所以可达性由我们这边先判定。
  // 注意只查调用方传入的 URL：fileID 那条路径的临时链接是刚签出来的，没必要白下一次。
  if (imageUrls.length) {
    try {
      const probe = await downloadImage(imageUrls[0]);
      if (probe.length > MAX_IMAGE_BYTES) return fail('垫图大小不能超过 10MB');
    } catch (err) {
      console.error('[imageToImage] 垫图链接不可用：', { url: imageUrls[0], err });
      return fail('垫图链接打不开，请换一张图重试');
    }
  }

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
  const size = normalizeSize(event.size);
  let generated;
  try {
    const imageModel = cloud.ai().createImageModel('hunyuan-image');
    const res = await imageModel.generateImage({
      model: I2I_MODEL,
      prompt,
      size, // 不传就默认 1024x1024，这是「所有结果都是方图」的根因
      ...(imageUrls.length ? { image_urls: imageUrls } : { images }),
      revise: { value: false }, // 固定关闭提示词改写，见文件头部说明
      footnote: WATERMARK_TEXT, // 水印文案：不传就是默认的「图片由 AI 生成」
    });
    generated = (res && res.data && res.data[0]) || {};
  } catch (err) {
    // 上游 400/403 的真实原因只在响应体里，别只打一句 status code
    console.error('[imageToImage] 生图失败：', {
      message: err && err.message,
      status: err && err.response && err.response.status,
      detail: err && err.response && err.response.data,
    });
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
  };
};
