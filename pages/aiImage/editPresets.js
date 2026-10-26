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
  { id: 'natural', name: '自然清透', desc: '窗侧柔光 · 背景清晰 · 提亮不爆白', selection: { dof: 'deep', lightDir: 'window', lightQuality: 'soft', grade: 'clean' } },
  { id: 'skinBalance', name: '自然匀肤', desc: '明暗轻柔调匀 · 局部偏色校正 · 保留皮肤纹理', selection: { dof: 'deep', lightQuality: 'soft', grade: 'skin_balance' } },
  { id: 'clearGlow', name: '清透发光', desc: '中高光轻提 · 亮部留细节 · 肤色不泛灰', selection: { dof: 'deep', lightQuality: 'soft', grade: 'clean_glow' } },
  { id: 'backlitFill', name: '逆光补脸', desc: '脸部局部提亮 · 发丝亮边保留 · 背景高光不爆白', selection: { dof: 'medium', lightDir: 'back', lightQuality: 'soft', grade: 'clean' } },
  { id: 'backlitGlow', name: '逆光发光', desc: '发丝柔和亮边 · 局部光晕 · 眼睛清楚不糊脸', selection: { dof: 'medium', lightDir: 'back', lightQuality: 'soft', grade: 'soft_focus' } },
  { id: 'creamyBokeh', name: '奶油虚化', desc: '窗边柔光 · 背景化开 · 肤质留纹理', selection: { dof: 'shallow', lightDir: 'window', lightQuality: 'very_soft', grade: 'commercial' } },
  { id: 'nightFlash', name: '夜景直闪', desc: '人物明亮 · 夜色保留 · 复古闪光感', selection: { dof: 'medium', lightQuality: 'flash', grade: 'polaroid' } },
  { id: 'neonTrail', name: '霓虹拖影', desc: '背景光轨 · 人物清晰 · 冷青夜色', selection: { dof: 'motion_blur', lightQuality: 'neon', grade: 'cinema_cool' } },
  { id: 'warmFilm', name: '暖调胶片', desc: '柔和暖光 · 轻微虚化 · 暖色与细颗粒', selection: { dof: 'medium', lightDir: 'window', lightQuality: 'soft', grade: 'film_warm' } },
  { id: 'lowSat', name: '低饱和清冷', desc: '柔和侧光 · 背景可辨 · 收色但保留肤色', selection: { dof: 'medium', lightDir: 'side', lightQuality: 'soft', grade: 'muted' } },
  { id: 'darkMood', name: '暗调情绪', desc: '侧光塑形 · 暗部保留层次 · 高光收住', selection: { dof: 'medium', lightDir: 'side', lightQuality: 'low_key', grade: 'dark' } },
  { id: 'hongkong', name: '复古港风', desc: '室内侧光 · 背景轻虚化 · 暖黄褪色颗粒', selection: { dof: 'medium', lightDir: 'side', lightQuality: 'soft', grade: 'hk_retro' } },
  { id: 'vivid', name: '浓郁旅拍', desc: '自然硬光 · 环境清晰 · 鲜艳但肤色自然', selection: { dof: 'deep', lightDir: 'front', lightQuality: 'hard', grade: 'vivid' } },
  { id: 'coolClean', name: '冷调高级', desc: '干净侧光 · 背景清晰 · 冷色克制不染肤', selection: { dof: 'deep', lightDir: 'side', lightQuality: 'soft', grade: 'cool_clean' } },
  { id: 'mono', name: '黑白银盐', desc: '侧光明暗 · 环境清晰 · 黑白层次与颗粒', selection: { dof: 'deep', lightDir: 'side', lightQuality: 'hard', grade: 'mono_silver' } },
  { id: 'japanese', name: '日系胶片', desc: '树荫散射光 · 轻微虚化 · 低反差细颗粒', selection: { dof: 'medium', lightDir: 'diffuse', lightQuality: 'overcast', grade: 'jp_clean' } },
  { id: 'cinematic', name: '青橙电影', desc: '侧光塑形 · 暗部青 · 高光暖金', selection: { dof: 'medium', lightDir: 'side', lightQuality: 'low_key', grade: 'cinematic' } },
  { id: 'suspense', name: '冷青悬疑', desc: '硬侧光 · 深青暗部 · 暖肤色单独保留', selection: { dof: 'deep', lightDir: 'side', lightQuality: 'hard', grade: 'cinema_cool' } },
  { id: 'periodFilm', name: '暖褐年代', desc: '旧金高光 · 蓝青暗部 · 肤色不染黄', selection: { dof: 'medium', lightDir: 'top_side', lightQuality: 'golden', grade: 'cinema_warm' } },
  { id: 'bleach', name: '银漂高反差', desc: '硬侧光 · 饱和度压低 · 黑位厚实亮部坚实', selection: { dof: 'medium', lightDir: 'side', lightQuality: 'hard', grade: 'bleach_bypass' } },
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
