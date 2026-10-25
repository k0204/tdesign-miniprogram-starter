import { EDIT_TYPES, ANCHOR_PHOTO, CONSTRAINT_TAIL, buildPrompt } from './promptOptions';
import {
  DIMENSIONS,
  CAPABILITY_GROUPS,
  CAPABILITY_DEFAULTS,
  buildDimensionView,
  buildMods,
} from './dimensions';

export const CAPABILITIES = EDIT_TYPES;

export {
  DIMENSIONS,
  CAPABILITY_GROUPS,
  CAPABILITY_DEFAULTS,
  buildDimensionView,
  buildMods,
};

export function findCapability(id) {
  return CAPABILITIES.find((item) => item.id === id) || null;
}

/**
 * 取某个功能的默认选择。
 * 必须深拷贝：texture 是数组，直接返回常量会让两个功能共用同一个引用，
 * 一个改了另一个也跟着变。
 */
export function defaultSelection(capabilityId) {
  const preset = CAPABILITY_DEFAULTS[capabilityId] || {};
  return JSON.parse(JSON.stringify(preset));
}

/**
 * 这组选择能不能出图。
 * 判据是「拼出来有没有内容」而不是「选了几项」——
 * 比如光位选了「保持原光位」，那就是没有指令，不该允许点生成。
 */
export function selectionReady(capabilityId, selection) {
  return Boolean(String(buildMods(selection, capabilityId) || '').trim());
}

export function buildEditPrompt({ selection, capability, extra = '', reference = '' } = {}) {
  return buildPrompt({
    item: { prompt: buildMods(selection, capability && capability.id) },
    keepHint: capability && capability.keepHint,
    extra,
    reference,
  });
}

/** 给「AI 建议」描述这次允许改的范围，替代原来的「功能·选项」拼接 */
export function describeSelection(capabilityId, selection) {
  return buildDimensionView(capabilityId, selection)
    .map((group) => group.pickedLabel)
    .filter(Boolean)
    .join(' · ');
}

/**
 * 选择结果的稳定字符串，用作缓存 key。
 * 必须按维度组的固定顺序拼，且多选排序——
 * 否则「先点颗粒再点褪色」和「先点褪色再点颗粒」会算成两个不同的 key，
 * 同一组选择反复烧两次模型调用。
 */
export function selectionKey(capabilityId, selection = {}) {
  const groups = CAPABILITY_GROUPS[capabilityId] || [];
  return groups
    .map((key) => {
      const value = selection[key];
      const text = Array.isArray(value)
        ? value.slice().sort().join(',')
        : String(value || '');
      return `${key}:${text}`;
    })
    .join('|');
}

export { ANCHOR_PHOTO, CONSTRAINT_TAIL };
