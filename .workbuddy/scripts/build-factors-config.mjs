/**
 * 从 docs 的因素库生成小程序提示词配置
 *
 *   node .workbuddy/scripts/build-factors-config.mjs
 *
 * 输入（docs 的归一化产物，由 docs/prompt-tool/normalize.py + build_library.py 生成）
 *   docs/prompt-tool/library/packs.json        四个包预设（label/count/share/phrase）
 *   docs/prompt-tool/library/vocab.json        各维度取值 + 频次
 *   docs/prompt-tool/library/render_map.json   取值 -> 中文渲染短语
 *
 * 输出
 *   config/prompts/aiImage.factors.js          小程序内置的提示词配置（唯一手写来源）
 *
 * 什么时候要重跑：docs 的语料更新、重新归一化之后。日常改文案**不要**跑这个脚本，
 * 直接改 aiImage.factors.js —— 否则会被覆盖。
 *
 * ⚠️ v6/v7 之后这份脚本已经落后于手写配置（6 参数收敛、可编辑锁都不在生成逻辑里）。
 * 直接重跑会把线上配置打回旧的 3 分类 21 维结构，所以默认拒绝执行；
 * 确实需要重新生成时显式加 `--force`，并在跑完后手工补回 locks / 6 参数。
 *
 * 只保留三类因素：取景 / 场景 / 影调。
 * 「人物」与「叙事」两类已下线（2026-10-25）：
 *   - 人物：图生图里人物来自原图，改性别/年龄/服装/姿势等于换人，风险大；
 *     身份一致性交给「锁定不换」统一锁住，比让用户逐个选更可靠
 *   - 叙事：13 个预设里 35.7% 都是「自然流露」这种低信息量项，
 *     对成片的影响远不如光影，留在菜单里只是多一行要滑
 *
 * 其余刻意的取舍（都有 docs 里的数据依据）：
 *   - 丢掉所有 generic 取值（scene.generic 61%），那是标注默认填充，不是真实信息；
 *     一律换成「不指定」项，且不带短语
 *   - 丢掉 colorTemp.mono 和 lightQuality.mono：docs §6.7 已证「黑白」是影调不是光型，
 *     混在光线维里会让选黑白时同时拼出「黑白光影」「黑白（无彩色）」「黑白影调」三遍
 *   - 不给「构图」和「画幅」：图生图改构图等于重排画面，画幅会和输出比例逻辑打架
 *     （尺寸是按原图比例算的）
 *   - 所有维度的「不指定」都不写短语：不选＝不加任何指令，这是产品前提
 */
import fs from 'node:fs';
import path from 'node:path';

if (!process.argv.includes('--force')) {
  console.error(
    '\n❌ 这份脚本停留在 v5 之前的结构，重跑会覆盖 config/prompts/aiImage.factors.js 的 6 参数与 locks。\n' +
      '   日常改文案请直接改该文件；确需重新生成请加 --force，并在跑完后手工补回。\n',
  );
  process.exit(1);
}

const root = path.resolve(import.meta.dirname, '../..');
const LIB = path.join(root, 'docs/prompt-tool/library');
const OUT = path.join(root, 'config/prompts/aiImage.factors.js');

const packs = JSON.parse(fs.readFileSync(path.join(LIB, 'packs.json'), 'utf8'));
const vocab = JSON.parse(fs.readFileSync(path.join(LIB, 'vocab.json'), 'utf8'));
const render = JSON.parse(fs.readFileSync(path.join(LIB, 'render_map.json'), 'utf8'));

/** 中文标签。render 是长短语（给模型看），label 是短词（给人看），两者不能混用 */
const LABELS = {
  shot: { full: '全景', medium: '中景', wide: '远景', closeup: '特写', medium_close: '近景' },
  angle: { eye_level: '平视', phone: '手机视角', high: '俯拍', low: '仰拍', selfie: '自拍' },
  dof: { deep: '大景深', shallow: '浅景深', medium: '中等景深' },
  scene: {
    studio_wall: '简洁背景', street: '城市街道', mountain: '山峦', water: '海边',
    indoor: '窗边', nature_green: '花丛', urban: '建筑间', snow: '雪地',
    outdoor: '夏日户外', garden: '园林', dusk_outdoor: '黄昏', night: '夜色',
    mirror: '镜面前', aerial_land: '俯瞰大地', rain: '雨中',
  },
  weather: {
    autumn: '秋季', winter: '雪天', summer: '夏季', night: '夜晚', dusk: '黄昏',
    spring: '春季', fog: '雾天', rain: '雨天', dawn: '清晨', sunny: '晴天',
  },
  foreground: {
    none: '无遮挡', frame: '窗框门框', foliage: '植物枝叶', fabric: '纱帘', mirror: '镜面', rail: '栏杆',
  },
  lightDir: {
    left: '左侧光', right: '右侧光', front: '顺光', top: '顶光', back: '逆光', bottom: '底光', side: '侧光',
  },
  lightQuality: { soft: '自然柔光', hard: '硬光', mixed: '霓虹混合光' },
  colorTemp: { neutral: '中性色温', warm: '暖色温', cool: '冷色温' },
  tone: {
    neutral: '中性自然', warm: '暖调橙黄', high_sat: '浓郁', low_sat: '低饱和', cool: '冷调青蓝', mono: '黑白影调',
  },
  grade: {
    film: '暖调胶片', clean: '自然通透', dark: '暗调压缩', mono: '黑白银盐', tinted: '复古港风', contrast: '高反差剪影',
  },
  mood: {
    natural: '自然真实', warm: '温暖柔和', quiet: '沉静内敛', bright: '明亮轻快',
    nostalgic: '复古怀旧', dramatic: '热烈', distant: '孤独', romantic: '浪漫',
  },
};

const HINTS = {
  shot: '主体占多大、留多少环境',
  angle: '机位高度决定人物气质',
  dof: '背景是清楚还是化掉',
  scene: '在哪拍',
  weather: '季节、天光与天气',
  foreground: '画面边缘要不要东西挡一下',
  lightDir: '主光从哪边来',
  lightQuality: '光的软硬',
  colorTemp: '整体冷暖',
  tone: '色彩与饱和的落点',
  grade: '后期质感',
  mood: '整体情绪',
};

/** 这些取值是标注时的默认填充，不是信息，一律跳过（换成「不指定」项） */
const SKIP = {
  scene: ['generic'],
  colorTemp: ['mono'],
  lightQuality: ['mono'],
};

const DIMS = {
  shot: { name: '景别', src: 'shot' },
  angle: { name: '机位', src: 'angle' },
  dof: { name: '景深', src: 'dof' },
  scene: { name: '地点', src: 'scene' },
  weather: { name: '天气季节', src: 'weather' },
  foreground: { name: '前景', src: 'foreground' },
  lightDir: { name: '光位', src: 'lightDir' },
  lightQuality: { name: '光质', src: 'lightQuality' },
  colorTemp: { name: '色温', src: 'colorTemp' },
  tone: { name: '色调', src: 'tone' },
  grade: { name: '后期', src: 'grade' },
  mood: { name: '情绪', src: 'mood' },
};

/** 一级分类。数组顺序 = 界面 tab 顺序，也决定拼装时的段落顺序 */
const CATEGORIES = [
  { id: 'framing', name: '取景', icon: 'image', desc: '景别 · 机位 · 景深', dims: ['shot', 'angle', 'dof'] },
  { id: 'scene', name: '场景', icon: 'location', desc: '地点 · 天气 · 前景', dims: ['scene', 'weather', 'foreground'] },
  {
    id: 'tone',
    name: '影调',
    icon: 'palette',
    desc: '光 · 色 · 后期 · 情绪',
    dims: ['lightDir', 'lightQuality', 'colorTemp', 'tone', 'grade', 'mood'],
  },
];

/** 拼装顺序：镜头 -> 场景 -> 影调（docs recipe 去掉人物与叙事后的顺序） */
const ORDER = CATEGORIES.flatMap((c) => c.dims);

function optionsOf(key) {
  const src = DIMS[key].src;
  const skip = SKIP[key] || [];
  const values = Array.isArray(vocab[src]) ? vocab[src] : Object.keys(render[src] || {});
  const labels = LABELS[src] || {};
  const map = render[src] || {};

  const options = [{ id: 'auto', label: '不指定', phrase: '', share: 0 }];

  values.forEach((entry) => {
    const id = typeof entry === 'string' ? entry : entry.value;
    if (skip.indexOf(id) !== -1) return;
    const count = typeof entry === 'string' ? 0 : entry.count || 0;
    const phrase = map[id];
    const label = labels[id];
    if (!label) return; // 词表里有、但我们没定义中文标签的取值先不开放
    if (typeof phrase !== 'string') return;
    options.push({ id, label, phrase, share: count });
  });

  return options;
}

/* 缺 label 的取值会被静默跳过，这里先把漏网的打出来，免得某个维度少了一半选项还不知道 */
let missing = 0;
Object.keys(DIMS).forEach((key) => {
  const src = DIMS[key].src;
  const skip = SKIP[key] || [];
  (vocab[src] || []).forEach((entry) => {
    const id = typeof entry === 'string' ? entry : entry.value;
    if (skip.indexOf(id) !== -1) return;
    if (!(LABELS[src] || {})[id]) {
      console.warn(`⚠️ ${src}.${id} 没有中文标签，已跳过`);
      missing += 1;
    }
  });
});

const dims = {};
Object.keys(DIMS).forEach((key) => {
  const options = optionsOf(key);
  const total = options.reduce((n, o) => n + (o.share || 0), 0);
  // share 换成百分比，界面用来标注「库里的主流选择」
  options.forEach((o) => {
    o.share = total ? Math.round((o.share / total) * 1000) / 10 : 0;
  });
  dims[key] = {
    name: DIMS[key].name,
    hint: HINTS[key] || '',
    options,
  };
});

const defaults = {};
ORDER.forEach((key) => {
  defaults[key] = 'auto';
});

const config = {
  schema: 'aiImage.factors',
  version: 5,
  updatedAt: new Date().toISOString(),
  note: 'AI 修图的生成因素库（取景/场景/影调）。改文案直接改本文件；语料重新归一化后跑 build-factors-config.mjs 覆盖。',
  copy: {
    lead: '为这张照片生成一版真实自然的成片',
    // 人物维度已下线，人物一致性全靠这一句，所以写死、写细
    keep: '严格保持原图人物的身份、五官比例、脸型、体型、发型与个人特征不变，不做网红脸、不做医美脸，不改变人物的年龄与性别',
    tail: '成片必须符合真实摄影逻辑，光线方向与阴影一致，皮肤保留真实质感不塑料，画面干净，无文字、水印、边框、重影、畸变或多余肢体',
  },
  categories: CATEGORIES,
  dims,
  order: ORDER,
  defaults,
};

const header = `/**
 * AI 修图提示词 · 生成因素库（内置默认版本）
 *
 * 这份文件由 .workbuddy/scripts/build-factors-config.mjs 从 docs 语料生成，
 * 生成之后就是**唯一手写来源**：改文案直接改这里，别再重跑脚本（会被覆盖）。
 * 语料更新、重新归一化之后才重跑脚本。
 *
 * 结构：
 *   copy       两端固定文案（生成意图 / 质量底线）
 *   locks      「锁定不换」（本脚本不生成，v7 起由手写配置维护）
 *   categories 一级分类，数组顺序 = 界面 tab 顺序，也决定拼装权重的先后
 *   dims       二级因素维度，option.phrase 是真正拼进提示词的正文
 *   order      拼装顺序：取景 -> 场景 -> 影调
 *   defaults   每个维度的默认值（全是 auto）
 *
 * 只保留三类因素：取景 / 场景 / 影调。
 * 「人物」「叙事」两类已下线：人物来自原图（改它等于换人，身份一致性交给「锁定不换」），
 * 叙事预设信息量低（35.7% 都是「自然流露」），对成片影响不如光影。
 *
 * 三条不能破的规矩：
 *   1. option.id 一旦上线不要改，云端配置按 version 择优、旧缓存按 id 对应，改名等于让老版本错位
 *   2. 每个维度的第一项必须是 auto（「不指定」），且短语必须为空——不选就是不加任何指令
 *   3. 不要往 dims 里加回「构图 / 画幅」——图生图改构图就是重排画面，
 *      画幅还会和输出尺寸逻辑（按原图比例算）打架
 *
 * 数据来源：docs/prompt-tool/library/{packs,vocab,render_map}.json，
 * 语料 2253 条（A 库 1450 + B 库 803），详见 docs/提示词组合库-2026-10.md。
 */
`;

const body = `${header}export default ${JSON.stringify(config, null, 2)};\n`;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, body, 'utf8');

const optionCount = ORDER.reduce((n, k) => n + dims[k].options.length, 0);
console.log(`✅ 已生成 ${path.relative(root, OUT)}（${(Buffer.byteLength(body) / 1024).toFixed(1)} KB）`);
console.log(`   v${config.version} · ${CATEGORIES.length} 个分类 / ${ORDER.length} 个维度 / ${optionCount} 个取值${missing ? ` / ⚠️ ${missing} 个取值缺标签被跳过` : ''}`);
CATEGORIES.forEach((c) => {
  const detail = c.dims.map((k) => `${dims[k].name}(${dims[k].options.length})`).join(' ');
  console.log(`   ${c.name}: ${detail}`);
});
