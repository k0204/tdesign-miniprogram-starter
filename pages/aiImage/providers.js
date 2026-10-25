/**
 * 生图引擎抽象层
 *
 * 三个引擎在「能力面」上不是子集关系，差别在垫图数量与尺寸表达方式：
 *   混元 HY-Image-v3.0-I2I —— 1 张垫图，尺寸写死「宽x高」，30s 内同步返回
 *   Agnes agnes-image-2.5-flash —— 最多 4 张垫图（第 1 张主图，其后参考图），
 *                                 尺寸是「档位 + 比例」（1K/2K/3K/4K + 1:1/3:4/...）
 *   Nexus gpt-image-2（OpenAI 兼容网关）—— 最多 4 张垫图，尺寸是「宽x高」
 *                                 但由网关按比例归一像素，需要两段式轮询
 *
 * 页面只认这张表，不再出现 if (引擎 === xxx) 的散落判断：
 *   sizeMode 决定尺寸怎么算/怎么展示/怎么传，asyncTask 决定同步还是两段式。
 */

/** 混元 ImageModel 出图尺寸规则：宽高各自 [512,2048]，面积 ≤ 1024x1024 */
const MAX_AREA = 1024 * 1024;
const MIN_SIDE = 512;
const MAX_SIDE = 2048;
const ALIGN = 8;
/** 极端长图/宽图把比例夹在这个范围内，否则短边会顶到 512 导致比例失真 */
const MIN_RATIO = 0.25;
const MAX_RATIO = 4;

/**
 * 按原图宽高比反推一个「面积吃满、比例尽量不变」的尺寸。
 * 对齐用向下取整到 8 的倍数：向上/四舍五入会在 4:3 这类比例上顶破面积上限
 * （1184x896 = 1060864 > 1048576），取整反而更安全。
 *
 * 只用于混元。Nexus 的规则完全不同，见 pickNexusSize。
 */
export function pickExactSize(width, height) {
  const w0 = Number(width) || 0;
  const h0 = Number(height) || 0;
  if (!w0 || !h0) return '1024x1024';

  const ratio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, w0 / h0));
  const alignDown = (value) =>
    Math.max(MIN_SIDE, Math.min(MAX_SIDE, Math.floor(value / ALIGN) * ALIGN));

  // 由 area = w*h 且 w/h = ratio 反解：w = sqrt(area * ratio)
  const w = alignDown(Math.sqrt(MAX_AREA * ratio));
  const h = alignDown(w / ratio);

  return `${w}x${h}`;
}

/**
 * gpt-image-2 官方尺寸规则（developers.openai.com/api/docs/guides/image-generation）：
 *   - size 支持任意「宽x高」，不是只有 1024x1024 / 1536x1024 / 1024x1536 三档
 *   - **两条边必须都是 16 的倍数**
 *   - 长边 : 短边 ≤ **3:1**
 *   - 总像素必须在 655,360 ~ 8,294,400 之间
 *   - 最大边长 ≤ 3840；超过 2560x1440（2K）属实验性能力
 *
 * 所以这里按目标预算 1536x1024 ≈ 1.57MP 反解：远高于下限、又稳稳低于 2K，
 * 并按原图比例分配宽高。注意对齐单位是 16（不是混元的 8）。
 */
const NEXUS_ALIGN = 16;
const NEXUS_TARGET_PIXELS = 1536 * 1024;
const NEXUS_MIN_PIXELS = 655360;
const NEXUS_MAX_PIXELS = 8294400;
const NEXUS_MAX_RATIO = 3;

export function pickNexusSize(width, height) {
  const w0 = Number(width) || 0;
  const h0 = Number(height) || 0;
  if (!w0 || !h0) return '1024x1024';

  // 官方限制长边不超过短边的 3 倍，超了会被拒/被裁
  const ratio = Math.min(NEXUS_MAX_RATIO, Math.max(1 / NEXUS_MAX_RATIO, w0 / h0));
  const align16 = (value) => Math.max(NEXUS_ALIGN, Math.round(value / NEXUS_ALIGN) * NEXUS_ALIGN);

  let w = align16(Math.sqrt(NEXUS_TARGET_PIXELS * ratio));
  let h = align16(w / ratio);

  // 对齐取整可能把比例顶过 3:1，这里往上取整收口
  const longSide = Math.max(w, h);
  if (longSide / Math.min(w, h) > NEXUS_MAX_RATIO) {
    const fixed = Math.ceil(longSide / NEXUS_MAX_RATIO / NEXUS_ALIGN) * NEXUS_ALIGN;
    if (w >= h) h = fixed;
    else w = fixed;
  }

  // 兜底：像素越界时按同一个比例缩放回去（正常情况下不会走到）
  const pixels = w * h;
  if (pixels < NEXUS_MIN_PIXELS || pixels > NEXUS_MAX_PIXELS) {
    const scale = Math.sqrt(NEXUS_TARGET_PIXELS / Math.max(pixels, 1));
    w = align16(w * scale);
    h = align16(h * scale);
  }

  return `${w}x${h}`;
}

/** Agnes 支持的固定比例档（不在这张表里的比例会被服务端忽略） */
export const AGNES_RATIOS = ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9'];

/**
 * 把任意宽高比吸附到最近的 Agnes 比例档。
 * 用对数距离而不是线性差：232:100 到 2:1 与 1:1 的「视觉差距」不是算术差能表达的。
 */
export function pickAgnesRatio(width, height, fallback = '1:1') {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (!w || !h) return fallback;

  const target = Math.log(w / h);
  let best = fallback;
  let bestDiff = Infinity;
  AGNES_RATIOS.forEach((item) => {
    const [a, b] = item.split(':').map(Number);
    if (!a || !b) return;
    const diff = Math.abs(Math.log(a / b) - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = item;
    }
  });
  return best;
}

/**
 * 多图时补的说明。混元只有 1 张垫图用不到；Agnes 多图如果不说明主次，
 * 模型容易把参考图里的人/物也画进成片。
 */
export const MULTI_IMAGE_HINT =
  '第 1 张是要修改的原图，第 2 张起仅作为风格、光线与色调参考，不复制参考图中的人物、物体和文字';

/** 多图引擎才需要插「第 1 张是原图」的说明 */
const MULTI_IMAGE_ENGINES = ['agnes', 'nexus'];

export function referenceHint(engineId, imageCount) {
  return MULTI_IMAGE_ENGINES.indexOf(engineId) !== -1 && Number(imageCount) > 1
    ? MULTI_IMAGE_HINT
    : '';
}

export const ENGINES = [
  {
    id: 'hunyuan',
    name: '混元',
    desc: '单图精修',
    tip: '约 30s',
    emptyTip: '原图直传，最大 10MB',
    waitText: 'AI处理中，约 30s',
    loadingTitle: 'AI处理中',
    cloudFn: 'imageToImage',
    maxImages: 1,
    /** 本页是修图流程，所有引擎都至少需要 1 张原图；改成 0 即可放出纯文生图 */
    minImages: 1,
    maxPromptLength: 480, // 云函数硬限 500，提前 20 字拦
    sizeMode: 'exact',
    /** 混元约 30s，一次 callFunction 等得回来 */
    asyncTask: false,
  },
  {
    id: 'agnes',
    name: 'Agnes',
    desc: '可加参考图',
    tip: '1-4 张 · 约 90s',
    emptyTip: '主图 + 最多 3 张参考图',
    waitText: 'Agnes 生成中，约 90s',
    loadingTitle: 'Agnes 生成中',
    cloudFn: 'agnesImage',
    maxImages: 4,
    minImages: 1,
    maxPromptLength: 1900, // 云函数硬限 2000
    sizeMode: 'tier',
    /** 档位式尺寸：1K 时图生图实测 85-96s */
    tier: '1K',
    /**
     * 图生图 85-96s 超过 callFunction 的 60s 客户端上限，必须走
     * 「提交拿 taskId → 轮询数据库」两段式，不能同步等。
     */
    asyncTask: true,
    pollIntervalMs: 3000,
    /** 前端愿意等多久（云函数侧预算是 200s，这里留一点余量） */
    maxWaitMs: 210000,
  },
  {
    id: 'nexus',
    name: 'Nexus',
    desc: '多图参考',
    tip: '1-4 张 · 约 60s',
    emptyTip: '主图 + 最多 3 张参考图',
    waitText: 'Nexus 生成中，约 60s',
    loadingTitle: 'Nexus 生成中',
    cloudFn: 'nexusImage',
    maxImages: 4,
    minImages: 1,
    maxPromptLength: 1900, // 云函数硬限 2000
    /**
     * exact：尺寸传「宽x高」，但**按 gpt-image-2 官方规则算**
     * （16 的倍数、比例 ≤3:1、像素 655K-8.29M），由 pickNexusSize 负责。
     */
    sizeMode: 'exact',
    pickSize: pickNexusSize,
    /**
     * quality=high 实测 40-90s，超过 callFunction 的 60s 客户端上限，
     * 和 Agnes 一样走「提交拿 taskId → 轮询数据库」。
     */
    asyncTask: true,
    pollIntervalMs: 3000,
    /** 前端愿意等多久（云函数侧预算是 180s） */
    maxWaitMs: 200000,
  },
];

export function findEngine(id) {
  return ENGINES.find((item) => item.id === id) || ENGINES[0];
}

/** 素材位标签：单图引擎不摆角色；多图引擎才区分主图/参考图 */
export function slotLabel(engine, index) {
  if (!engine || engine.maxImages <= 1) return '';
  return index === 0 ? '主图' : `参考 ${index}`;
}

/** 预览区右上角的输出规格文案 */
export function outputLabel(engine, { size = '1024x1024', ratio = '1:1' } = {}) {
  if (engine && engine.sizeMode === 'tier') return `${engine.tier} · ${ratio}`;
  return size;
}

/**
 * 组装云函数入参。
 * images 顺序即参考顺序，单图引擎只取第 1 张（超出部分已在页面侧截断）。
 */
export function buildPayload(engine, { prompt, images = [], size = '1024x1024', ratio = '1:1' }) {
  const fileIDs = images.map((item) => item && item.fileID).filter(Boolean);

  if (engine.sizeMode === 'tier') {
    return {
      prompt,
      fileIDs,
      size: engine.tier || '1K',
      ratio,
    };
  }

  // 多图 + 精确尺寸（nexus）：size 是按主图比例算好的「宽x高」
  if (engine.maxImages > 1) {
    return { prompt, fileIDs, size };
  }

  return { prompt, fileID: fileIDs[0] || '', size };
}
