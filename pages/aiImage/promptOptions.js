/**
 * 修图的拼装模板与保留约束。
 *
 * 历史：这里原来放着 20 个固定套餐（5 类 × 4 个选项），用户只能整选一个。
 * 现已改由 dimensions.js 的多维度选择生成「改动描述」，套餐文本不再使用。
 * 留下的只有：能力元信息（名称/图标/保留边界）+ 拼装顺序 + 三段固定文案。
 */

/** 整图 AI 修图能力。每个选项是一套完整成片方案，不要求用户理解摄影参数。 */
export const ANCHOR_PHOTO =
  '基于输入照片进行专业AI摄影后期，先识别人物、主体、场景与现有光线，再执行所选的一键处理';

export const KEEP_PHOTO =
  '严格保持原图人物身份、五官、表情、姿态、服装、物体、文字、背景、构图、裁切范围和空间位置不变';
export const KEEP_PORTRAIT =
  '严格保持人物身份、五官比例、脸型、表情、发型、身材、姿态、服装与个人皮肤特征不变，不做网红脸';
export const KEEP_SCENE =
  '严格保持原有主体、景物结构、建筑透视、文字、构图、裁切范围和全部场景内容不变';

export const CONSTRAINT_TAIL =
  '结果必须是同一张照片的自然后期版本；不扩图、不裁切、不移动、增加、删除或替换任何内容，不改变天气与时段，不虚构被遮挡细节，无文字变化、重影、畸变、塑料皮肤或多余肢体';

/**
 * 能力列表。只保留元信息，具体怎么改由维度决定（见 dimensions.js 的 CAPABILITY_GROUPS）。
 * keepHint 是这一功能的边界：人像类不许动脸，场景类不许动结构，通用类只要求整体不变。
 */
export const EDIT_TYPES = [
  {
    id: 'enhance',
    name: '智能增强',
    icon: 'adjustment',
    desc: 'AI自动判断照片问题',
    keepHint: KEEP_PHOTO,
  },
  {
    id: 'portrait',
    name: '人像成片',
    icon: 'user',
    desc: '以人物状态和质感为重点',
    keepHint: KEEP_PORTRAIT,
  },
  {
    id: 'relight',
    name: '光影重塑',
    icon: 'brightness',
    desc: '重新平衡人物与环境光线',
    keepHint: KEEP_PHOTO,
  },
  {
    id: 'style',
    name: '风格转换',
    icon: 'palette',
    desc: '一键统一整张照片的质感',
    keepHint: KEEP_PHOTO,
  },
  {
    id: 'scene',
    name: '场景出片',
    icon: 'image',
    desc: 'AI按拍摄内容针对性优化',
    keepHint: KEEP_SCENE,
  },
];

/**
 * 拼装顺序：主体锚 → 改动项 → 用户补充 → 多图参考说明 → 保持不变 → 约束行。
 * 主体锚必须最前（前 40 字权重最高）；约束行必须最后，否则容易被后半段的
 * 「参考图说明」冲淡。
 */
export function buildPrompt({
  anchor = ANCHOR_PHOTO,
  item,
  keepHint = KEEP_PHOTO,
  extra = '',
  reference = '',
} = {}) {
  const userText = String(extra || '').trim();
  return [anchor, item && item.prompt, userText, reference, keepHint, CONSTRAINT_TAIL]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('。');
}
