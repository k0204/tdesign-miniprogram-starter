/**
 * AI 修图提示词配置：加载 / 校验 / 热替换
 *
 * 配置的模型是「因素库」而不是「修图套餐」：
 *   分类（取景 / 影调）× 因素维度 × 取值，每个取值带一句可以直接进提示词的中文短语（phrase）；
 *   另有一组「锁定」开关（人物 / 场景 / 服装造型 / 姿势表情），默认锁人物与场景。
 *   AI 生成时按 order 拼因素短语，再把锁定的约束拼在最后一段。
 *
 * 三条来源，按「能用就用更可信的」排序：
 *   1. 内置默认  config/prompts/aiImage.factors.js —— 打进包里，冷启动/离线/云端没配好时兜底
 *   2. 本地缓存  storage `aiimage_prompt_cfg_v2` —— 上次从云端拿到的版本，省一次下载
 *   3. 云端     云存储 prompts/aiImage.factors.json —— 带 version，只在比当前新时替换
 *
 * 为什么不在启动时阻塞等云端：下载是网络操作，卡住首屏等于用一个可选优化拖垮必用流程。
 * 所以页面先用内置默认渲染出来，云端到了再重建菜单（见 index.js 的 syncPromptConfig）。
 *
 * 为什么配置要校验：配置是会被改的，一旦某次上传少了 options，页面会直接白屏。
 * 这里做全量结构校验，任何一项不合规就整份丢弃 + console.error，绝不「部分应用」——
 * 半套配置比旧配置危险得多。
 */
import DEFAULTS from '~/config/prompts/aiImage.factors';

/** 云存储里的路径。换环境要同步改 CLOUD_FILE_ID 的环境前缀 */
export const PROMPT_CLOUD_PATH = 'prompts/aiImage.factors.json';

/**
 * 完整 fileID。云存储下载只认这个形式，不能只给路径。
 * 前缀 = `cloud://<env>.<bucket>-<uin>/`，可从任意一张 ai-images 图的 fileID 里抄（换环境只改这一段）。
 */
const CLOUD_FILE_ID =
  'cloud://cloud1-d4g48z822d1300a77.636c-cloud1-d4g48z822d1300a77-1512321434/prompts/aiImage.factors.json';

const CACHE_KEY = 'aiimage_prompt_cfg_v2';
const SCHEMA = 'aiImage.factors';

/** 当前生效的配置。初始是内置默认，load 成功后可能被换成云端版本 */
let current = DEFAULTS;
/** builtin | cache | cloud，用于界面上标一句「这份提示词从哪来」 */
let source = 'builtin';
/** 同一个进程内只跑一次下载，页面反复进出不重复请求 */
let inflight = null;

export function getPromptConfig() {
  return current;
}

export function getPromptVersion() {
  return current.version || 0;
}

export function getPromptSource() {
  return source;
}

/** 两端固定文案：开头的生成意图 / 结尾的质量底线 */
export function getCopy() {
  return current.copy || {};
}

/** 「锁定不换」的说明与候选项（文案在页面上可编辑） */
export function getLockConfig() {
  return current.locks || {};
}

export function getLocks() {
  const locks = current.locks || {};
  return Array.isArray(locks.items) ? locks.items : [];
}

/** 一级分类（取景 / 影调），数组顺序 = 界面 tab 顺序 */
export function getCategories() {
  return current.categories || [];
}

/** 全部因素维度 */
export function getFactors() {
  return current.dims || {};
}

export function getFactor(key) {
  return (current.dims || {})[key] || null;
}

/** 拼装顺序 */
export function getOrder() {
  return current.order || [];
}

export function getDefault(key) {
  return (current.defaults || {})[key] || 'auto';
}

/** 某个分类下要显示的维度 key 列表 */
export function getCategoryDims(categoryId) {
  const hit = getCategories().find((item) => item.id === categoryId);
  return hit ? hit.dims || [] : [];
}

/* ---------------- 校验 ---------------- */

const isText = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * 全量结构校验。返回 `{ ok, reason }`。
 * 宁可拒掉一份「看起来差不多」的配置，也不要在用户手机上跑出半个菜单。
 */
export function validateConfig(raw) {
  const bad = (reason) => ({ ok: false, reason });

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('配置不是对象');
  if (raw.schema !== SCHEMA) return bad(`schema 不是 ${SCHEMA}`);
  if (!Number.isInteger(raw.version) || raw.version <= 0) return bad('version 必须是正整数');

  const copy = raw.copy || {};
  for (const key of ['lead', 'tail']) {
    if (!isText(copy[key])) return bad(`copy.${key} 缺失`);
  }

  // 锁定项是提示词最后一段硬约束，也是用户在界面上唯一能改文案的地方。
  // 结构坏了宁可不应用——半套锁比没有锁更危险（用户以为锁住了，实际没拼进去）。
  const lockItems = (raw.locks && raw.locks.items) || [];
  if (!Array.isArray(lockItems) || lockItems.length < 2) return bad('locks.items 少于两项');
  const lockIds = new Set();
  for (const item of lockItems) {
    if (!item || typeof item !== 'object') return bad('locks.items 项不是对象');
    if (!isText(item.id) || !isText(item.name) || !isText(item.phrase)) {
      return bad('locks.items 有项缺 id/name/phrase');
    }
    if (typeof item.defaultOn !== 'boolean') return bad(`locks.${item.id}.defaultOn 不是布尔`);
    if (item.phrase.includes('。')) return bad(`locks.${item.id}.phrase 里出现句号（会打断拼装）`);
    if (item.phrase.length > 200) return bad(`locks.${item.id}.phrase 超过 200 字`);
    if (lockIds.has(item.id)) return bad(`locks.${item.id} 重复`);
    lockIds.add(item.id);
  }

  const dims = raw.dims || {};
  const dimKeys = Object.keys(dims);
  if (!dimKeys.length) return bad('dims 为空');
  for (const [key, dim] of Object.entries(dims)) {
    if (!dim || typeof dim !== 'object') return bad(`dims.${key} 不是对象`);
    if (!isText(dim.name)) return bad(`dims.${key} 缺 name`);
    if (!Array.isArray(dim.options) || dim.options.length < 2) return bad(`dims.${key}.options 少于两项`);
    if (dim.options[0].id !== 'auto') return bad(`dims.${key} 的第一项必须是 auto`);
    const seen = new Set();
    for (const opt of dim.options) {
      if (!isText(opt.id) || !isText(opt.label)) return bad(`dims.${key} 有取值缺 id/label`);
      if (typeof opt.phrase !== 'string') return bad(`dims.${key}.${opt.id} 的 phrase 不是字符串`);
      if (seen.has(opt.id)) return bad(`dims.${key}.${opt.id} 重复`);
      seen.add(opt.id);
    }
  }

  if (!Array.isArray(raw.order) || !raw.order.length) return bad('order 为空');
  for (const key of raw.order) {
    if (!dims[key]) return bad(`order 引用了不存在的维度 ${key}`);
  }
  // 不允许有维度没进 order：那就永远拼不到提示词里，界面上选了等于白选
  for (const key of dimKeys) {
    if (raw.order.indexOf(key) === -1) return bad(`维度 ${key} 没有出现在 order 里`);
  }

  const cats = raw.categories || [];
  if (!Array.isArray(cats) || !cats.length) return bad('categories 为空');
  const catIds = new Set();
  for (const cat of cats) {
    if (!isText(cat.id) || !isText(cat.name) || !isText(cat.icon)) return bad('categories 项缺 id/name/icon');
    if (catIds.has(cat.id)) return bad(`categories.${cat.id} 重复`);
    catIds.add(cat.id);
    if (!Array.isArray(cat.dims) || !cat.dims.length) return bad(`categories.${cat.id}.dims 为空`);
    for (const key of cat.dims) {
      if (!dims[key]) return bad(`categories.${cat.id} 引用了不存在的维度 ${key}`);
    }
  }

  const defaults = raw.defaults || {};
  for (const key of dimKeys) {
    const value = defaults[key];
    if (value === undefined) return bad(`defaults.${key} 缺失`);
    const ids = dims[key].options.map((o) => o.id);
    if (ids.indexOf(value) === -1) return bad(`defaults.${key} 的值 ${value} 不存在`);
  }

  return { ok: true, reason: '' };
}

/**
 * 应用一份配置。返回是否真的换掉了。
 * force=true 时允许「同版本覆盖」，只在开发自测时用（正常流程版本必须递增）。
 */
export function applyPromptConfig(raw, { force = false, from = 'cloud' } = {}) {
  // 先做版本门禁：旧版本（比如云端还是 v6）连校验都不必跑，
  // 否则每次启动都会因为「缺 locks」打一条误导性的校验失败日志。
  if (!force && raw && Number.isInteger(raw.version) && raw.version <= current.version) return false;

  const check = validateConfig(raw);
  if (!check.ok) {
    console.error('[promptConfig] 配置校验失败，已忽略:', check.reason);
    return false;
  }
  current = raw;
  source = from;
  return true;
}

/* ---------------- 缓存 ---------------- */

function readCache() {
  try {
    const hit = wx.getStorageSync(CACHE_KEY);
    if (!hit || typeof hit !== 'object') return null;
    if (!hit.config || !Number.isInteger(hit.version)) return null;
    return hit;
  } catch (err) {
    return null;
  }
}

function writeCache(raw) {
  try {
    wx.setStorageSync(CACHE_KEY, { version: raw.version, savedAt: Date.now(), config: raw });
  } catch (err) {
    // 存不下不影响这次生效，只是下次要重新下载
    console.warn('[promptConfig] 缓存写入失败', err);
  }
}

/* ---------------- 下载 ---------------- */

function downloadRemote(timeout) {
  return new Promise((resolve, reject) => {
    if (!wx.cloud || typeof wx.cloud.downloadFile !== 'function') {
      reject(new Error('当前基础库不支持云存储下载'));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('下载超时'));
    }, timeout);

    wx.cloud.downloadFile({
      fileID: CLOUD_FILE_ID,
      success: (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          const text = wx.getFileSystemManager().readFileSync(res.tempFilePath, 'utf8');
          resolve(JSON.parse(text));
        } catch (err) {
          reject(err);
        }
      },
      fail: (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    });
  });
}

/**
 * 加载提示词配置。永远 resolve，不会因为网络失败把页面拖下水。
 * 返回 `{ changed, version, source }`，changed=true 表示页面需要重建菜单。
 *
 * 顺序上先看本地缓存、再下载：缓存命中就不必等网络，但云端仍要拉一次——
 * 否则用户装的是 3 天前的包，缓存里也只有 3 天前的版本，热更新永远到不了。
 */
export function loadPromptConfig({ timeout = 8000, force = false } = {}) {
  if (inflight) return inflight;

  inflight = (async () => {
    let changed = false;

    const cached = readCache();
    if (cached && applyPromptConfig(cached.config, { force, from: 'cache' })) {
      changed = true;
    }

    try {
      const remote = await downloadRemote(timeout);
      if (applyPromptConfig(remote, { force, from: 'cloud' })) {
        writeCache(remote);
        changed = true;
      } else if (remote && remote.version && remote.version < getPromptVersion()) {
        console.warn('[promptConfig] 云端版本比本地旧，已忽略', remote.version);
      }
    } catch (err) {
      // 首次安装 + 离线 + 云端没传，都会走到这里，属于正常路径，不打扰用户
      console.warn('[promptConfig] 云端配置未取到，沿用', source, err && err.errMsg ? err.errMsg : err);
    }

    return { changed, version: getPromptVersion(), source };
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}

/** 调试用：把当前配置的版本信息打出来 */
export function describePromptSource() {
  const label = source === 'cloud' ? '云端' : source === 'cache' ? '本地缓存' : '内置';
  return `提示词 v${getPromptVersion()} · ${label}`;
}
