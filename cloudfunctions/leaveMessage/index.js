/**
 * 留言板云函数
 *
 * 一个函数按 action 分派，避免为「列表 / 发送 / 删除」建三个函数：
 *   - unlock  校验 4 位口令（打开留言板的前置动作）
 *   - list    拉一页留言（按时间倒序，游标式分页）
 *   - create  发一条留言（文字 + 最多 3 张图）
 *   - remove  删自己的留言（顺带清理云存储里的图）
 *
 * 数据存在 `leave_messages`，首次调用时自动建集合，无需手工建表。
 * 图片不落数据库二进制，只存云存储 fileID —— `<image src="cloud://...">`
 * 和 `wx.previewImage` 都原生支持 fileID，省掉换临时链接的往返，
 * 也不会出现「临时链接过期后老留言全是裂图」的问题。
 *
 * ============ 部署要求 ============
 *   1) 无需环境变量（不依赖任何外部 API Key）
 *   2) 执行超时保持默认 3s 即可：本函数只读写数据库，不调外部服务
 *   3) 集合 `leave_messages` 自动创建；如需自定义权限，请到控制台改成
 *      「仅创建者可写、所有人可读」，客户端从未直连数据库，改权限不影响本函数
 *
 * 入参（event）：
 *   action    {string}   'unlock' | 'list'（默认）| 'create' | 'remove'
 *
 *   —— unlock ——
 *   pin       {string}   必填，4 位数字口令（默认 3402，可用环境变量 BOARD_PIN 覆盖）
 *
 *   —— list ——
 *   page      {number}   页码，从 0 开始
 *   pageSize  {number}   每页条数，默认 10，上限 20
 *
 *   —— create ——
 *   content   {string}   文字。新版是客户端密文 `v1.<base64>`（≤4096 字符，服务端不解密）；
 *                        没有 v1. 前缀的按历史明文处理，≤500 字
 *   images    {string[]} 云存储 fileID，最多 3 张
 *   nickname  {string}   昵称。同理：密文原样存，明文按 ≤12 字清洗，缺省「微信用户」
 *   encrypted {number}   1 = 客户端已加密（仅作标记，服务端不依赖它判断）
 *
 *   —— remove ——
 *   id        {string}   留言 _id，只能删自己发的
 *
 * 出参：
 *   list   → { ok: true, data: { list: Message[], hasMore: boolean } }
 *   create → { ok: true, data: Message }
 *   remove → { ok: true }
 *   任一失败 → { ok: false, error }   // error 是给人看的一句话，可直接展示
 *
 * Message = { id, content, images, nickname, createdAt, mine }
 *   注意：这里**不返回 _openid**，只返回 mine 布尔值。
 *   把 openid 发给所有人等于泄露用户身份，判断归属放在服务端做。
 */

const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const COLLECTION = 'leave_messages';
const MAX_CONTENT = 500;
const MAX_IMAGES = 3;
const MAX_NICKNAME = 12;
const DEFAULT_NICKNAME = '微信用户';
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 20;
/** 同一用户两条留言的最小间隔，防连点刷屏 */
const POST_INTERVAL_MS = 2000;
const FILE_ID_PREFIX = 'cloud://';

/**
 * 留言内容和昵称都是客户端加密后上传的：`v1.<base64(iv||密文||MAC)>`。
 * 云函数只做长度校验，不碰密钥，也就不可能解密 —— 数据库里存的是密文。
 */
const CIPHER_PREFIX = 'v1.';
/** 500 汉字 ≈ 1500 字节 → base64 约 2.1KB，这里留一倍余量 */
const MAX_CIPHER_LEN = 4096;
const MAX_CIPHER_NICK_LEN = 1024;

/**
 * 打开留言板的口令（4 位数字）。
 *
 * 放在云函数里而不是小程序端：客户端代码是能被反编译的，写在前端等于公开。
 * 想换口令有两条路——改这个常量重新部署，或在 CloudBase 控制台给本函数配
 * 环境变量 `BOARD_PIN`（改名不用重新部署）。
 */
const DEFAULT_PIN = '3402';
const PIN_PATTERN = /^\d{4}$/;
/** 同一个 openid 每分钟最多试 10 次，挡一下暴力穷举（4 位数只有一万种） */
const PIN_MAX_TRIES = 10;
const PIN_WINDOW_MS = 60 * 1000;
const pinTries = new Map();

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
          console.warn('[leaveMessage] 建集合返回异常（忽略）：', text);
        }
      });
  }
  return collectionReady;
}

function fail(error) {
  return { ok: false, error };
}

/** 时间字段统一成毫秒时间戳：Date / number / ISO 字符串都要吃得下 */
function toMs(value) {
  if (!value) return 0;
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** 昵称清洗：去首尾空白、砍掉换行等控制字符、按字符（非字节）截断 */
function normalizeNickname(raw) {
  const text = String(raw || '')
    .replace(/[\r\n\t]/g, ' ')
    .trim();
  if (!text) return DEFAULT_NICKNAME;
  return Array.from(text).slice(0, MAX_NICKNAME).join('');
}

/**
 * 内容归一化。
 *
 * 新版客户端传来的是密文（`v1.<base64>`），服务端看不懂、也不需要看懂，
 * 只卡长度；密文长度按「500 汉字 ≈ 1500 字节 → base64 ≈ 2.1KB」留一倍余量。
 * 没有 v1. 前缀的按历史明文处理（旧版客户端），沿用字符数上限。
 *
 * @returns {string|null} null 表示超限
 */
function normalizeContent(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (text.startsWith(CIPHER_PREFIX)) {
    return text.length > MAX_CIPHER_LEN ? null : text;
  }
  const chars = Array.from(text);
  if (chars.length > MAX_CONTENT) return null;
  return chars.join('');
}

/** 昵称：密文原样存（客户端解密后显示），明文走清洗逻辑 */
function normalizeNicknameField(raw) {
  const text = String(raw || '').trim();
  if (text.startsWith(CIPHER_PREFIX)) {
    return text.length > MAX_CIPHER_NICK_LEN ? DEFAULT_NICKNAME : text;
  }
  return normalizeNickname(text);
}

/** 数据库文档 -> 客户端结构（不含 _openid） */
function toMessage(doc, openid) {
  return {
    id: doc._id,
    content: String(doc.content || ''),
    images: Array.isArray(doc.images) ? doc.images.filter(Boolean).map(String) : [],
    nickname: doc.nickname || DEFAULT_NICKNAME,
    createdAt: toMs(doc.createdAt) || toMs(doc.createTime),
    mine: Boolean(openid) && doc._openid === openid,
  };
}

// ---------------- 口令 ----------------

/**
 * 校验 4 位口令。
 *
 * 只是「打开留言板」这道门，不是权限系统：list/create 本身没有加密，
 * 真要防住得走内容安全/权限那一套。这里的目标是挡住随手点进来的人。
 *
 * 失败一律回同一句「功能未开放」——不告诉对方这里有密码、也不区分是格式错、
 * 超限还是密码错。真实原因只打云函数日志（控制台/日志里能查）。
 */
const UNLOCK_DENY = '功能未开放';

async function unlock(event) {
  const { OPENID } = cloud.getWXContext();
  const pin = String(event.pin || '').trim();
  if (!PIN_PATTERN.test(pin)) {
    console.warn('[leaveMessage] unlock 拒绝：格式不是 4 位数字');
    return fail(UNLOCK_DENY);
  }

  const now = Date.now();
  const key = OPENID || 'anonymous';
  const record = pinTries.get(key);
  // 窗口过期就重新计数；Map 只存窗口内的记录，顺手清掉过期的防内存膨胀
  if (!record || now > record.resetAt) {
    if (pinTries.size > 500) pinTries.clear();
    pinTries.set(key, { count: 1, resetAt: now + PIN_WINDOW_MS });
  } else {
    if (record.count >= PIN_MAX_TRIES) {
      console.warn('[leaveMessage] unlock 拒绝：同一 openid 尝试超限', key);
      return fail(UNLOCK_DENY);
    }
    record.count += 1;
  }

  const expected = String(process.env.BOARD_PIN || DEFAULT_PIN);
  if (pin !== expected) {
    console.warn('[leaveMessage] unlock 拒绝：口令不正确，openid=', key);
    return fail(UNLOCK_DENY);
  }

  pinTries.delete(key);
  return { ok: true, data: { unlocked: true } };
}

// ---------------- 列表 ----------------

/**
 * 列表 / 增量拉取。
 *
 * 传 since（毫秒时间戳）时只回比它更新的留言，用于页面的实时刷新兜底轮询：
 * 每次只回新消息，代价和流量都比整页重拉小得多，也不会打断已加载的分页。
 */
async function list(event) {
  const page = Math.max(0, Number(event.page) || 0);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(event.pageSize) || DEFAULT_PAGE_SIZE));
  const since = Math.max(0, Number(event.since) || 0);

  const db = cloud.database();
  const _ = db.command;

  let query = db.collection(COLLECTION);
  if (since) query = query.where({ createdAt: _.gt(since) });

  const res = await query
    .orderBy('createdAt', 'desc')
    // 增量模式不需要分页：一次最多回一页的量，足够覆盖十几秒内的新增
    .skip(since ? 0 : page * pageSize)
    .limit(since ? MAX_PAGE_SIZE : pageSize)
    .get();

  const { OPENID } = cloud.getWXContext();
  const rows = Array.isArray(res.data) ? res.data : [];

  return {
    ok: true,
    data: {
      list: rows.map((doc) => toMessage(doc, OPENID)),
      // 满页才可能还有下一页，少一条就到底了，省一次空查询
      hasMore: since ? false : rows.length === pageSize,
      // 客户端拿着它判断 watch 推送来的文档是不是自己的，省一次额外查询
      myOpenid: OPENID || '',
    },
  };
}

// ---------------- 发送 ----------------

async function create(event) {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return fail('登录状态已失效，请重新进入小程序');

  const rawContent = String(event.content || '').trim();
  const content = normalizeContent(rawContent);
  if (content === null) return fail(`留言最多 ${MAX_CONTENT} 字`);

  const rawImages = Array.isArray(event.images) ? event.images.filter(Boolean) : [];
  if (rawImages.length > MAX_IMAGES) return fail(`最多上传 ${MAX_IMAGES} 张图片`);
  const images = rawImages.map(String);
  // 只收本环境的云存储 fileID：外链会让前端 <image> 依赖第三方可达性，
  // 也挡住了把任意字符串塞进列表的做法
  if (images.some((id) => !id.startsWith(FILE_ID_PREFIX))) {
    return fail('图片地址无效，请重新选择图片');
  }

  if (!content && !images.length) return fail('说点什么再发送吧');

  const nickname = normalizeNicknameField(event.nickname);

  // 连点保护：查自己最后一条的时间，2s 内直接打回
  const last = await cloud
    .database()
    .collection(COLLECTION)
    .where({ _openid: OPENID })
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get();
  const lastRow = (last.data || [])[0];
  if (lastRow && Date.now() - toMs(lastRow.createdAt) < POST_INTERVAL_MS) {
    return fail('发送太快了，稍等一下');
  }

  const now = Date.now();
  const added = await cloud
    .database()
    .collection(COLLECTION)
    .add({
      data: {
        // 显式写 _openid：云函数写入不会自动带上，归属判断和权限都靠它
        _openid: OPENID,
        content,
        images,
        nickname,
        createdAt: now,
        // 同时留一份服务端时间，便于以后按日期归档
        createTime: cloud.database().serverDate(),
      },
    });

  return {
    ok: true,
    data: {
      id: added._id,
      content,
      images,
      nickname,
      createdAt: now,
      mine: true,
    },
  };
}

// ---------------- 删除 ----------------

async function remove(event) {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return fail('登录状态已失效，请重新进入小程序');

  const id = String(event.id || '').trim();
  if (!id) return fail('缺少要删除的留言 ID');

  const db = cloud.database();
  let doc = null;
  try {
    doc = (await db.collection(COLLECTION).doc(id).get()).data;
  } catch (err) {
    // doc 不存在时 SDK 会抛错，按「已删除」处理，不暴露是否存在
    console.warn('[leaveMessage] 读取待删留言失败：', err && (err.errMsg || err.message));
  }
  if (!doc) return fail('这条留言已经不在了');

  // 归属校验必须在服务端做，客户端传什么都不能信
  if (doc._openid !== OPENID) return fail('只能删除自己的留言');

  await db.collection(COLLECTION).doc(id).remove();

  // 图片清理失败不影响删除结果（数据库里已经没这条了），只记日志。
  // 只删本留言板目录下的文件：fileID 是客户端上传的，但万一以后有功能复用同一张图，
  // 一刀切删掉会把别人的素材删空。
  const images = Array.isArray(doc.images) ? doc.images.filter(Boolean) : [];
  const owned = images.filter((fileID) => String(fileID).includes('/leave-message/'));
  if (owned.length) {
    try {
      await cloud.deleteFile({ fileList: owned });
    } catch (err) {
      console.error('[leaveMessage] 清理留言图片失败：', err);
    }
  }

  return { ok: true };
}

// ---------------- 入口 ----------------

exports.main = async (event = {}) => {
  const action = String(event.action || 'list');
  try {
    await ensureCollection();

    if (action === 'unlock') return await unlock(event);
    if (action === 'list') return await list(event);
    if (action === 'create') return await create(event);
    if (action === 'remove') return await remove(event);
    return fail(`未知操作：${action}`);
  } catch (err) {
    // 原始错误（含堆栈、errMsg）只打日志，返回给用户的是人话
    console.error('[leaveMessage] 执行失败：', { action, err });
    return fail('服务开小差了，请稍后重试');
  }
};
