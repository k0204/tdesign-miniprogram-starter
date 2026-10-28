/**
 * 页面用的「因素」门面
 *
 * 提示词配置来自 promptConfig（内置默认 + 云端热更新），所以这里不导出常量，
 * 一律走 getter——热更新换掉配置后，页面重新调用一次就能拿到新数据。
 *
 * 不要把这些 getter 的结果缓存成模块级常量：那样热更新对它不起作用，
 * 会变成「云端已经是 v3，界面还按 v1 在拼」。
 */
import { buildElements, buildPrompt } from './promptOptions';
import {
  buildDimViews,
  countPicked,
  defaultSelection,
  describeSelection,
  selectionKey,
} from './dimensions';
import {
  describePromptSource,
  getCategories,
  getCopy,
  getDefault,
  getFactor,
  getFactors,
  getLockConfig,
  getLocks,
  getOrder,
  getPromptVersion,
  loadPromptConfig,
} from './promptConfig';

/** 完整效果配方：一键填入因素，之后仍可逐项微调。 */
export const EFFECT_RECOMMENDATIONS = [
  { id: 'natural', name: '自然清透', desc: '背景清晰 · 柔和光线 · 肤色自然', selection: { dof: 'deep', light: 'soft', grade: 'clean' } },
  { id: 'skinRefine', name: '自然修肤', desc: '淡化临时瑕疵 · 肤质保留纹理', selection: { skin: 'blemish' } },
  { id: 'faceRefine', name: '脸部精修', desc: '面部光影均匀 · 五官清晰自然', selection: { skin: 'tone_balance', face: 'even_light', light: 'soft' } },
  { id: 'backlitFill', name: '逆光补脸', desc: '面部自然补亮 · 发丝轮廓清晰', selection: { dof: 'medium', light: 'back', grade: 'clean' } },
  { id: 'creamyBokeh', name: '奶油虚化', desc: '背景柔和虚化 · 人物保持清晰', selection: { dof: 'shallow', light: 'soft', grade: 'clean' } },
  { id: 'warmFilm', name: '暖调胶片', desc: '暖色调 · 柔和反差 · 细腻颗粒', selection: { dof: 'medium', light: 'soft', grade: 'film_warm' } },
  { id: 'lowSat', name: '低饱和清冷', desc: '低饱和色彩 · 保留自然肤色', selection: { dof: 'medium', light: 'side', grade: 'muted' } },
  { id: 'coolClean', name: '冷调清透', desc: '冷调清透 · 肤色干净 · 细节清晰', selection: { dof: 'deep', light: 'soft', grade: 'cool_clean' } },
  { id: 'japanese', name: '日系清爽', desc: '明亮柔和 · 低反差 · 清新色彩', selection: { dof: 'medium', light: 'soft', grade: 'jp_clean' } },
  { id: 'cinematic', name: '青橙电影', desc: '暖色高光 · 冷色暗部 · 电影氛围', selection: { dof: 'medium', light: 'side', grade: 'cinematic' } },
  { id: 'mono', name: '黑白银盐', desc: '黑白影调 · 明暗层次 · 细腻颗粒', selection: { dof: 'deep', light: 'side', grade: 'mono_silver' } },
];

export function applyEffectRecommendation(id, currentSelection) {
  const effect = EFFECT_RECOMMENDATIONS.find((item) => item.id === id);
  if (!effect) return null;
  return { ...defaultSelection(), ...(currentSelection || {}), ...effect.selection };
}

export {
  buildDimViews,
  buildElements,
  buildPrompt,
  countPicked,
  defaultSelection,
  describeSelection,
  selectionKey,
  describePromptSource,
  getCategories,
  getCopy,
  getDefault,
  getFactor,
  getFactors,
  getLockConfig,
  getLocks,
  getOrder,
  getPromptVersion,
  loadPromptConfig,
};

export function findCategory(id) {
  return getCategories().find((item) => item.id === id) || null;
}

/** 拼整整段提示词；selection 里没有的维度按配置默认值补齐，lockText 由 locks.js 生成 */
export function buildEditPrompt({ selection, extra = '', reference = '', lockText = '' } = {}) {
  return buildPrompt({
    elements: buildElements(selection),
    locks: lockText,
    extra,
    reference,
  });
}
