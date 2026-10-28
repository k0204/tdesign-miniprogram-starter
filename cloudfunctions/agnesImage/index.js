/**
 * Agnes 生图 · 派发侧
 *
 * 为什么拆成两个函数：
 *   `wx.cloud.callFunction` 有 **60s 客户端硬上限**，`app.json` 的
 *   `networkTimeout.request` 管不了它（那个配置只作用于 wx.request 等常规网络 API），
 *   超时报 `-501002 resource server timeout | ESOCKETTIMEDOUT`。
 *   而 Agnes 图生图实测 85-96s，同步等必然被客户端掐断。
 *
 * 所以本函数只做三件事，保证 < 1s 返回：
 *   1) 往 `ai_image_tasks` 写一条任务记录（status: queued）
 *   2) **不 await** 地触发 `agnesImageWorker`（服务端互调不受 60s 限制）
 *   3) 立刻回 taskId，客户端改为轮询 `action: 'status'`
 *
 * ============ 部署要求 ============
 *   1) 环境变量 AGNES_API_KEY（本函数不直接用，但 worker 用；两个函数分别要配）
 *   2) `agnesImageWorker` 执行超时必须在腾讯云 CloudBase 控制台调到 240s
 *   3) `ai_image_tasks` 集合首次调用时自动创建，无需手工建表
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
 *   size       {string}   '1K'|'2K'|'3K'|'4K'（默认 1K）或精确尺寸
 *   ratio      {string}   档位式 size 时的比例，默认 1:1
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

const WORKER = 'agnesImageWorker';
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
          console.warn('[agnesImage] 建集合返回异常（忽略）：', text);
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
    console.error('[agnesImage] 标记任务失败时出错：', err);
  }
}

/**
 * 只记一笔「派发疑似失败」，**绝不改 status**。
 * 最终状态只能由 worker 写：云函数互调的 promise 会在 ~15s 就先返回失败，
 * 而 worker 那时可能才刚开始调模型（实测 93s 才出图）。
 * 如果在这里判死，用户会在 17s 看到失败、而图 90s 后其实出好了。
 * 前端看到「status 仍是 queued 且带 dispatchError」超过 60s 才认定任务没起来。
 */
async function noteDispatchError(taskId) {
  try {
    await cloud
      .database()
      .collection(COLLECTION)
      .doc(taskId)
      .update({ data: { dispatchError: '任务派发异常，请稍后重试', updatedAt: Date.now() } });
  } catch (err) {
    console.error('[agnesImage] 记录派发异常时出错：', err);
  }
}

/**
 * 只读诊断：把「派发侧 + worker 侧」的接口地址与密钥指纹一起报出来。
 *
 * 为什么两边都要报：云函数的环境变量是**每个函数独立配置**的，
 * 而 Agnes 国内站（api.agnes-ai.cn）与国际站（apihub.agnes-ai.com）各自计费与限流。
 * 一边配 .com、一边配 .cn，或者 key 配成没买 plan 的那把，
 * 表现都是「image queue is full」——不是 401，所以从错误文案根本看不出打错站。
 *
 * key 只回前缀 + 长度，不落库、不打日志全量。
 */
async function readConfig() {
  const dispatcher = {
    hasKey: Boolean(process.env.AGNES_API_KEY),
    keyPrefix: process.env.AGNES_API_KEY
      ? `${process.env.AGNES_API_KEY.slice(0, 8)}…(${process.env.AGNES_API_KEY.length})`
      : '',
    host: process.env.AGNES_API_HOST || '(未配置，worker 缺省 api.agnes-ai.cn)',
  };

  let worker = null;
  try {
    const res = await cloud.callFunction({ name: WORKER, data: { action: 'config' } });
    worker = (res && res.result) || null;
  } catch (err) {
    worker = { ok: false, error: String((err && err.message) || err) };
  }

  return { ok: true, dispatcher, worker };
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
    size: String(event.size || '1K'),
    ratio: String(event.ratio || '1:1'),
  };
  // 兼容旧调用方的单张 fileID
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
        status: 'queued',
        prompt,
        imageCount,
        size: payload.size,
        ratio: payload.ratio,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    });
    taskId = added._id;
  } catch (err) {
    console.error('[agnesImage] 任务落库失败：', err);
    return fail('任务创建失败，请稍后重试');
  }

  try {
    // 关键：不 await。派发函数必须秒回，worker 在服务端自己跑满 200s。
    // 这里的 then/catch 只用来打日志和记录派发异常，不决定任务成败。
    cloud
      .callFunction({ name: WORKER, data: { taskId, ...payload } })
      .then((res) => {
        const r = (res && res.result) || {};
        if (!r.ok) console.warn('[agnesImage] worker 返回失败：', r.error);
      })
      .catch((err) => {
        console.error('[agnesImage] worker 调用返回失败（任务仍在执行，不判死）：', err);
        return noteDispatchError(taskId);
      });
  } catch (err) {
    // 同步抛出说明连调用都没发出去，这种才是真的没派发成功
    console.error('[agnesImage] 触发 worker 同步失败：', err);
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
  if (action === 'config') return readConfig();
  if (action === 'submit') return submit(event);
  return fail(`不支持的操作：${action}`);
};
