/**
 * AI 建议（提示词顾问）的客户端侧
 *
 * 只做三件事：组缓存 key、调云函数、把结果归一成页面能直接渲染的形状。
 * 判断「要不要调、什么时候调」留在页面里，这里不做业务决策。
 *
 * 为什么要缓存：一次建议调用是视觉模型（图片输入 + 数百字输出），
 * 用户经常在「点开看看 / 关掉 / 再点开」之间反复，没有缓存就等于重复烧钱。
 */

const CACHE_KEY = 'ai_advice_cache_v3';
/** 本地最多留 24 条，按写入时间淘汰最旧的；单条只有几百字节 */
const CACHE_MAX = 24;

/**
 * 缓存 key 必须含 demand：同一张图、同一个效果，用户补了「重点是脸」和
 * 「重点是背景」，该给的建议是不同的。
 */
export function buildAdviceKey({ fileID, mode, capId, optionId, currentPrompt, demand } = {}) {
  return [
    fileID || '',
    mode || 'effect',
    capId || '',
    optionId || '',
    String(currentPrompt || '').trim(),
    String(demand || '').trim(),
  ].join('|');
}

function readMap() {
  try {
    const raw = wx.getStorageSync(CACHE_KEY);
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch (err) {
    return {};
  }
}

function writeMap(map) {
  try {
    wx.setStorageSync(CACHE_KEY, map);
  } catch (err) {
    // 存储写失败（空间满）不影响主流程，只是下次不命中缓存
    console.warn('[aiImage] 建议缓存写入失败', err);
  }
}

export function readCachedAdvice(key) {
  const hit = readMap()[key];
  if (!hit || !Array.isArray(hit.candidates) || !hit.candidates.length) return null;
  return hit;
}

export function cacheAdvice(key, advice) {
  const map = readMap();
  map[key] = {
    analysis: advice.analysis || '',
    candidates: advice.candidates || [],
    savedAt: Date.now(),
  };
  const keys = Object.keys(map);
  if (keys.length > CACHE_MAX) {
    keys
      .sort((a, b) => (map[a].savedAt || 0) - (map[b].savedAt || 0))
      .slice(0, keys.length - CACHE_MAX)
      .forEach((oldKey) => delete map[oldKey]);
  }
  writeMap(map);
}

/** 换图时把这张图的所有建议清掉，免得旧图候选串到新图上 */
export function clearAdviceCache(fileID) {
  if (!fileID) return;
  const map = readMap();
  const prefix = `${fileID}|`;
  let dirty = false;
  Object.keys(map).forEach((key) => {
    if (key.indexOf(prefix) === 0) {
      delete map[key];
      dirty = true;
    }
  });
  if (dirty) writeMap(map);
}

/**
 * 调云函数拿建议。云函数侧预算 20s，远低于 callFunction 的 60s 硬限，
 * 所以这里同步等，不需要两段式。
 */
export function requestAdvice({
  fileID,
  mode,
  currentPrompt,
  effectOptions,
  demand,
  scope,
  keepHint,
  engineName,
} = {}) {
  return wx.cloud
    .callFunction({
      name: 'promptAdvisor',
      data: { fileID, mode, currentPrompt, effectOptions, demand, scope, keepHint, engineName },
    })
    .then((res) => {
      const result = (res && res.result) || {};
      if (!result.ok) {
        // 云函数返回的 error 已经是人话，页面侧不要再二次翻译
        const error = new Error(result.error || 'AI 没能给出建议');
        error.fromServer = true;
        throw error;
      }

      const candidates = (result.candidates || [])
        .filter((item) => item && item.text)
        .map((item, index) => ({
          label: item.label || `方案${index + 1}`,
          text: String(item.text),
          effectId: String(item.effectId || ''),
        }));
      if (!candidates.length) {
        const error = new Error('AI 没给出可用建议，换张图或改一下需求试试');
        error.fromServer = true;
        throw error;
      }

      return {
        analysis: result.analysis || '',
        candidates,
        elapsed: result.elapsed || 0,
      };
    });
}
