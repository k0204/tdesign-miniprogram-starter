/**
 * Nexus 生图 · 派发侧
 *
 * 结构与 `agnesImage` 完全同构（客户端只认「提交拿 taskId → 轮询」这一套），
 * 差别只有：worker 名字、上游接口、以及 Nexus 网关的两个硬限制。
 *
 * 为什么要拆两段（和 Agnes 同一个原因）：
 *   `wx.cloud.callFunction` 有 **60s 客户端硬上限**，`app.json` 的
 *   `networkTimeout.request` 管不了它（那个配置只作用于 wx.request 等常规网络 API），
 *   超时报 `-501002 resource server timeout | ESOCKETTIMEDOUT`。
 *   Nexus 走 gpt-image 系列，quality=high 出图常要 40-90s，同步等必然被客户端掐断。
 *
 * 所以本函数只做三件事，保证 < 1s 返回：
 *   1) 往 `ai_image_tasks` 写一条任务记录（status: queued，engine: nexus）
 *   2) **不 await** 地触发 `nexusImageWorker`（服务端互调不受 60s 限制）
 *   3) 立刻回 taskId，客户端改为轮询 `action: 'status'`
 *
 * ============ 部署要求 ============
 *   1) 环境变量 NEXUS_API_KEY（本函数不直接用，但 worker 用；两个函数分别要配）
 *   2) `nexusImageWorker` 执行超时必须在腾讯云 CloudBase 控制台调到 240s
 *   3) `ai_image_tasks` 集合与 Agnes 共用，已存在则自动跳过建表
 *
 * 入参（event）：
 *   action     {string}   'submit'（默认）| 'status'
 *
 *   —— submit ——
 *   prompt     {string}   必填，提示词
 *   fileIDs    {string[]} 垫图云存储 fileID（小程序端主路径，最多 4 张）
 *   fileID     {string}   单张垫图（兼容）
 *   imageUrls  {string[]} 垫图公网 URL
 *   images     {string[]} 垫图 base64 / data URI
 *   size       {string}   已按原图比例算好的「宽x高」（缺省由 worker 按 ratio 兜底）
 *   ratio      {string}   比例档，仅作兜底与对账
 *
 *   —— status ——
 *   taskId     {string}   必填
 *
 * 出参：
 *   submit → { ok: true, taskId, status: 'queued' }
 *   status → { ok: true, taskId, status: 'queued'|'running'|'done'|'failed',
 *              fileID, url, stored, error, elapsed, imageCount }
 *   任一步失败 → { ok: false, error }
 */

const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const WORKER = 'nexusImageWorker';
const COLLECTION = 'ai_image_tasks';
const MAX_INPUT_IMAGES = 4;

/** 建集合只做一次（冷启动内缓存），已存在不算错 */
let collectionReady = null;
function ensureCollection() {
  if (!collectionReady) {
    collectionReady = cloud
      .database()
      .createCollection(COLLECTION)
      .catch((err) => {
        const text = String((err && (err.errMsg || err.message)) || '');
        if (!/exist|存在|-501001|already/i.test(text)) {
          console.warn('[nexusImage] 建集合返回异常（忽略）：', text);
        }
      });
  }
  return collectionReady;
}

function fail(error) {
  return { ok: false, error };
}

function toList(raw) {
  return Array.isArray(raw) ? raw.filter(Boolean).map(String) : [];
}

async function markFailed(taskId, error) {
  try {
    await cloud
      .database()
      .collection(COLLECTION)
      .doc(taskId)
      .update({ data: { status: 'failed', error, updatedAt: Date.now() } });
  } catch (err) {
    console.error('[nexusImage] 标记任务失败时出错：', err);
  }
}

/**
 * 只记一笔「派发疑似失败」，**绝不改 status**。
 * 最终状态只能由 worker 写：云函数互调的 promise 会在 ~15s 就先返回失败，
 * 而 worker 那时可能才刚开始调模型。在前端，只有「status 仍是 queued 且带
 * dispatchError 超过 60s」才认定任务没起来。
 */
async function noteDispatchError(taskId) {
  try {
    await cloud
      .database()
      .collection(COLLECTION)
      .doc(taskId)
      .update({ data: { dispatchError: '任务派发异常，请稍后重试', updatedAt: Date.now() } });
  } catch (err) {
    console.error('[nexusImage] 记录派发异常时出错：', err);
  }
}

// ---------------- 提交 ----------------

async function submit(event) {
  const prompt = String(event.prompt || '').trim();
  if (!prompt) return fail('请输入提示词');

  const payload = {
    prompt,
    fileIDs: toList(event.fileIDs).slice(0, MAX_INPUT_IMAGES),
    imageUrls: toList(event.imageUrls).slice(0, MAX_INPUT_IMAGES),
    images: toList(event.images).slice(0, MAX_INPUT_IMAGES),
    /** 已按原图比例算好的「宽x高」；缺省时 worker 按 ratio 兜底 */
    size: String(event.size || '').trim(),
    ratio: String(event.ratio || '1:1'),
  };
  // 兼容单张 fileID 的调用方
  if (!payload.fileIDs.length && event.fileID) {
    payload.fileIDs = [String(event.fileID)];
  }

  const imageCount = Math.max(
    payload.fileIDs.length,
    payload.imageUrls.length,
    payload.images.length
  );

  let taskId = '';
  try {
    await ensureCollection();
    const { OPENID } = cloud.getWXContext();
    const added = await cloud.database().collection(COLLECTION).add({
      data: {
        // 显式写 _openid：云函数写入不会自动带上，权限规则要靠它判归属
        _openid: OPENID || '',
        engine: 'nexus',
        status: 'queued',
        prompt,
        imageCount,
        ratio: payload.ratio,
        // 请求尺寸（按原图比例算），worker 出图后会再用实际像素覆盖 size
        size: payload.size || '1024x1024',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    });
    taskId = added._id;
  } catch (err) {
    console.error('[nexusImage] 任务落库失败：', err);
    return fail('任务创建失败，请稍后重试');
  }

  try {
    // 关键：不 await。派发函数必须秒回，worker 在服务端自己跑满预算。
    // 这里的 then/catch 只用来打日志和记录派发异常，不决定任务成败。
    cloud
      .callFunction({ name: WORKER, data: { taskId, ...payload } })
      .then((res) => {
        const r = (res && res.result) || {};
        if (!r.ok) console.warn('[nexusImage] worker 返回失败：', r.error);
      })
      .catch((err) => {
        console.error('[nexusImage] worker 调用返回失败（任务仍在执行，不判死）：', err);
        return noteDispatchError(taskId);
      });
  } catch (err) {
    // 同步抛出说明连调用都没发出去，这种才是真的没派发成功
    console.error('[nexusImage] 触发 worker 同步失败：', err);
    await markFailed(taskId, '任务派发失败，请重试');
    return fail('任务派发失败，请重试');
  }

  return { ok: true, taskId, status: 'queued' };
}

// ---------------- 查询 ----------------

async function queryStatus(event) {
  const taskId = String(event.taskId || '').trim();
  if (!taskId) return fail('缺少 taskId');

  let doc = null;
  try {
    const res = await cloud.database().collection(COLLECTION).doc(taskId).get();
    doc = res && res.data;
  } catch (err) {
    return fail('任务不存在或已过期');
  }
  if (!doc) return fail('任务不存在或已过期');

  // 只允许读自己的任务；查不到时和「不存在」给同一个提示，避免探测他人任务
  const { OPENID } = cloud.getWXContext();
  if (doc._openid && OPENID && doc._openid !== OPENID) {
    return fail('任务不存在或已过期');
  }

  return {
    ok: true,
    taskId,
    status: doc.status || 'queued',
    fileID: doc.fileID || '',
    url: doc.url || '',
    stored: !!doc.fileID,
    error: doc.error || '',
    /** 派发异常标记：只有 status 仍是 queued 时才代表任务真的没起来 */
    dispatchError: doc.dispatchError || '',
    elapsed: doc.elapsed || 0,
    imageCount: doc.imageCount || 0,
  };
}

// ---------------- 入口 ----------------

exports.main = async (event = {}) => {
  const action = String(event.action || 'submit').trim();
  if (action === 'status') return queryStatus(event);
  if (action === 'submit') return submit(event);
  return fail(`不支持的操作：${action}`);
};
