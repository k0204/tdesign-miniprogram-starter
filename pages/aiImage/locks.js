/**
 * 「锁定不换」的视图与本地偏好
 *
 * 为什么要有这一层：图生图最常见的翻车不是调得不好看，而是 AI 顺着提示词把
 * 人物和背景一起重画了。6 个因素只管「怎么拍」，没有任何一条负责「拍的东西别动」，
 * 所以锁定是独立的一组开关，而不是第 7 个因素维度。
 *
 * 三个约束：
 *  1. 锁的候选与默认文案来自配置（可云端热更新），用户改过的文案存在本地，
 *     配置升级时按 id 保留，新增的锁自动取配置默认值。
 *  2. 锁定文案拼在用户描述之后、质量底线之前——越靠后越不容易被前面的长句冲淡。
 *  3. class / icon / 颜色全部在这里算好：模板里对 wx:for 做判断在当前基础库不可靠。
 */
import { getLocks } from './promptConfig';

const STORAGE_KEY = 'aiimage_lock_prefs_v1';

/** 单条锁定文案的长度上限，页面上限与这里保持一致 */
export const LOCK_PHRASE_MAX = 200;

/**
 * 清洗用户编辑的锁定文案。
 * 整段提示词用「。」分段、段内用「，」连接，所以文案里的句号必须换成逗号，
 * 否则一条锁会把后面的质量底线切成两段。首尾的标点也去掉，避免拼出「，，」。
 */
export function sanitizeLockText(text) {
  return String(text || '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/。/g, '，')
    .replace(/，{2,}/g, '，')
    .replace(/^[，、；\s]+|[，、；\s]+$/g, '')
    .trim()
    .slice(0, LOCK_PHRASE_MAX);
}

/** 默认状态：每个锁取配置里的 defaultOn，没有自定义文案 */
export function defaultLockState() {
  return normalizeLockState(null);
}

/**
 * 把「本地存的 / 旧版本留下的」状态对齐到当前配置：
 *  - 配置里已删除的锁直接丢弃，避免 selection 式残留
 *  - 新增的锁按 defaultOn 补上
 *  - 自定义文案必须非空且与默认值不同，否则视为没有改过
 */
export function normalizeLockState(raw) {
  const state = { on: {}, phrases: {} };
  const savedOn = (raw && raw.on) || {};
  const savedPhrases = (raw && raw.phrases) || {};

  getLocks().forEach((item) => {
    state.on[item.id] =
      typeof savedOn[item.id] === 'boolean' ? savedOn[item.id] : Boolean(item.defaultOn);

    const custom = sanitizeLockText(savedPhrases[item.id]);
    const fallback = sanitizeLockText(item.phrase);
    if (custom && custom !== fallback) state.phrases[item.id] = custom;
  });

  return state;
}

export function readLockState() {
  try {
    return normalizeLockState(wx.getStorageSync(STORAGE_KEY));
  } catch (err) {
    // 存储读失败不影响本次使用，只是回到配置默认值
    return defaultLockState();
  }
}

export function saveLockState(state) {
  try {
    wx.setStorageSync(STORAGE_KEY, { on: state.on, phrases: state.phrases });
  } catch (err) {
    // 存不下只影响下次进来是否记住，不能打断当前流程
    console.warn('[aiImage] 锁定偏好写入失败', err);
  }
}

export function isLockOn(state, id) {
  return Boolean(state && state.on && state.on[id]);
}

/** 不可变地切换一个锁，页面用完直接替换 this.lockState */
export function toggleLockState(state, id) {
  return {
    ...state,
    on: { ...state.on, [id]: !isLockOn(state, id) },
  };
}

/** 不可变地改一条锁定文案；改回默认值时删除覆盖，恢复跟随配置 */
export function setLockPhrase(state, id, text) {
  const def = getLocks().find((item) => item.id === id);
  const next = sanitizeLockText(text);
  const fallback = def ? sanitizeLockText(def.phrase) : '';
  const phrases = { ...state.phrases };

  if (next && next !== fallback) phrases[id] = next;
  else delete phrases[id];

  return { ...state, phrases };
}

/** 某条锁的默认文案，用于「恢复默认」 */
export function getLockDefaultPhrase(id) {
  const def = getLocks().find((item) => item.id === id);
  return def ? def.phrase || '' : '';
}

/**
 * 展开成界面能直接渲染的数据。
 * icon / iconColor / cls 都在这里确定，模板只插值。
 */
export function buildLockViews(state) {
  return getLocks().map((item) => {
    const on = isLockOn(state, item.id);
    const custom = (state.phrases && state.phrases[item.id]) || '';
    return {
      id: item.id,
      name: item.name,
      desc: item.desc || '',
      phrase: custom || item.phrase || '',
      defaultPhrase: item.phrase || '',
      on,
      edited: Boolean(custom),
      icon: on ? 'lock-on' : 'lock-off',
      iconColor: on ? '#0052d9' : 'rgba(0,0,0,0.32)',
      cls: on ? 'lock lock--on' : 'lock',
      mark: custom ? '改' : '',
      // wx:for 里对字符串做 wx:if 在当前基础库不可靠，布尔字段在 JS 侧算好
      hasMark: Boolean(custom),
    };
  });
}

/** 当前所有锁定的名字，用于摘要条 */
export function describeLocks(state) {
  return buildLockViews(state)
    .filter((item) => item.on)
    .map((item) => item.name)
    .join('、');
}

/** 决定这次拼进提示词最后一段的正文；一个锁都没开时返回空字符串 */
export function buildLockText(state) {
  return buildLockViews(state)
    .filter((item) => item.on)
    .map((item) => item.phrase)
    .filter(Boolean)
    .join('，');
}

/** 缓存 key 的一部分：锁变了（开关或文案），AI 建议的边界也变了，不该复用旧候选 */
export function lockKey(state) {
  return buildLockViews(state)
    .map((item) => `${item.id}:${item.on ? '1' : '0'}:${hashText(item.phrase)}`)
    .join('|');
}

/** 短 hash：把锁定文案压成 7 位以内，避免本地缓存 key 过长 */
function hashText(text) {
  const raw = String(text || '');
  let hash = 0;
  for (let i = 0; i < raw.length; i += 1) {
    hash = (hash * 31 + raw.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/**
 * 锁与已选因素之间的冲突提示。
 *
 * 这里只提示、不替用户改选择：锁是用户的明确意图，因素也是。
 * 真正矛盾时，模型会按更靠后的锁定文案执行，所以提前说清楚比事后怪 AI 好。
 */
export function detectLockTip(selection = {}, state) {
  const tips = [];
  const person = isLockOn(state, 'person');
  const scene = isLockOn(state, 'scene');

  if (person) {
    if (selection.angle === 'back') tips.push('背面机位看不到五官，人物锁定会打折');
    if (selection.lightDir === 'silhouette') tips.push('剪影只剩轮廓，人物锁定会失效');
    if (['extreme_wide', 'wide', 'env'].indexOf(selection.shot) !== -1) {
      tips.push('人物占比太小，人物锁定会打折');
    }
    if (selection.shot === 'detail') tips.push('局部特写看不到脸，人物锁定没有意义');
  }
  if (scene) {
    if (['razor', 'shallow', 'bokeh', 'motion_blur'].indexOf(selection.dof) !== -1) {
      tips.push('背景虚化或拖影会降低细节，场景锁仍要求保留环境结构');
    }
    if (selection.shot === 'detail') tips.push('局部特写里没有环境，场景锁定没有意义');
  }
  if (!person && !scene) tips.push('人物和场景都没锁，AI 可能把整张图重画');

  return tips.join('；');
}
