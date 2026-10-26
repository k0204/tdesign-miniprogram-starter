/**
 * AI 修图「因素菜单」回归检查
 *
 * 跑什么：
 *   1. 配置自检（schema/version/copy/categories/dims/order/defaults）
 *   2. 每个维度的取值结构、默认值、分类覆盖
 *   3. 拼装：顺序对不对、全 auto 时输出什么、全选时多长、有没有重复短语
 *   4. 随机抽样组合（默认 3000 组）跑长度与重复检查
 *   5. selectionKey 稳定性（选择先后不同不该算出两个 key）
 *   6. validateConfig 能否拒掉坏配置（热更新的安全底线）
 *
 *   node .workbuddy/scripts/verify-aiimage-menu.mjs
 *
 * 实现：源文件是 ESM 但后缀 .js，项目没有 type:module，直接 import 会被当 CJS。
 * 复制到系统临时目录改名 .mjs，并把 `~/` 别名和省略扩展名的相对导入改成 Node 能解析的形式
 * （小程序编译器和 Node 的解析规则不同，这一步只为测试）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const here = import.meta.dirname;
const root = path.resolve(here, '../..');
const srcDir = path.join(root, 'pages/aiImage');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'factors-check-'));

function copyToWork(from, to, transform) {
  let text = fs.readFileSync(from, 'utf8');
  if (transform) text = transform(text);
  fs.writeFileSync(path.join(work, to), text, 'utf8');
}

const sub = (t) => t.replace(/from '\.\/promptConfig'/g, "from './promptConfig.mjs'");

copyToWork(path.join(root, 'config/prompts/aiImage.factors.js'), 'factors.mjs');
copyToWork(path.join(srcDir, 'promptConfig.js'), 'promptConfig.mjs', (t) =>
  t.replace("'~/config/prompts/aiImage.factors'", "'./factors.mjs'"),
);
copyToWork(path.join(srcDir, 'dimensions.js'), 'dimensions.mjs', sub);
copyToWork(path.join(srcDir, 'locks.js'), 'locks.mjs', sub);
copyToWork(path.join(srcDir, 'promptOptions.js'), 'promptOptions.mjs',
  (t) => t.replace(/from '\.\/promptConfig'/g, "from './promptConfig.mjs'"));

const toUrl = (name) => pathToFileURL(path.join(work, name)).href;
const cfgMod = await import(toUrl('promptConfig.mjs'));
const dimMod = await import(toUrl('dimensions.mjs'));
const lockMod = await import(toUrl('locks.mjs'));
const promptMod = await import(toUrl('promptOptions.mjs'));

const {
  getPromptConfig, getCategories, getFactors, getOrder, getLocks, validateConfig,
} = cfgMod;
const { buildDimViews, countPicked, defaultSelection, describeSelection, selectionKey } = dimMod;
const {
  defaultLockState, normalizeLockState, buildLockViews, buildLockText, describeLocks,
  detectLockTip, toggleLockState, setLockPhrase, lockKey, sanitizeLockText,
} = lockMod;
const { buildElements, buildPrompt } = promptMod;

const fails = [];
const ok = (cond, msg) => {
  if (!cond) fails.push(msg);
};

/* ---------- 0. 配置 ---------- */
const cfg = getPromptConfig();
const DIMS = getFactors();
const ORDER = getOrder();
const CATS = getCategories();
const LOCKS = getLocks();
const SEL0 = defaultSelection();

ok(cfg.schema === 'aiImage.factors', `schema 非法: ${cfg.schema}`);
ok(Number.isInteger(cfg.version) && cfg.version > 0, `version 非法: ${cfg.version}`);
const check = validateConfig(cfg);
ok(check.ok, `内置默认配置校验失败: ${check.reason}`);

/* ---------- 0.5 锁定 ---------- */
{
  ok(Array.isArray(LOCKS) && LOCKS.length >= 2, '锁定项少于两项');
  const ids = LOCKS.map((item) => item.id);
  ok(new Set(ids).size === ids.length, '锁定项 id 重复');
  LOCKS.forEach((item) => {
    ok(typeof item.name === 'string' && item.name, `锁 ${item.id} 缺 name`);
    ok(typeof item.phrase === 'string' && item.phrase, `锁 ${item.id} 缺 phrase`);
    ok(!item.phrase.includes('。'), `锁 ${item.id} 的 phrase 里出现句号`);
    ok(item.phrase.length <= 200, `锁 ${item.id} 的 phrase 超过 200 字`);
    ok(typeof item.defaultOn === 'boolean', `锁 ${item.id} 的 defaultOn 不是布尔`);
    ok(sanitizeLockText(item.phrase).length > 0, `锁 ${item.id} 清洗后为空`);
  });

  const state = defaultLockState();
  const views = buildLockViews(state);
  ok(views.length === LOCKS.length, '锁定视图数与配置不一致');
  views.forEach((view) => {
    ok(typeof view.cls === 'string' && view.cls.indexOf('lock') === 0, `锁 ${view.id} 的 cls 异常`);
    ok(typeof view.icon === 'string' && view.icon.indexOf('lock-') === 0, `锁 ${view.id} 的 icon 异常`);
    ok(typeof view.edited === 'boolean', `锁 ${view.id} 的 edited 不是布尔`);
    ok(typeof view.hasMark === 'boolean', `锁 ${view.id} 的 hasMark 不是布尔`);
    ok(view.phrase === (view.edited ? state.phrases[view.id] : view.defaultPhrase), `锁 ${view.id} 文案来源不对`);
  });
  const expectedOn = LOCKS.filter((item) => item.defaultOn).map((item) => item.name);
  ok(describeLocks(state) === expectedOn.join('、'), '默认锁定的摘要与 defaultOn 不一致');
  const text = buildLockText(state);
  ok(!text.includes('。'), '锁定段里出现句号');
  if (expectedOn.length) ok(text.length > 0, '默认有锁但拼出的锁定段为空');

  // 自定义文案必须生效、且能被锁 key 区分
  const firstId = LOCKS[0].id;
  const custom = setLockPhrase(state, firstId, '保留脸上的痣，不要磨皮过度');
  ok(buildLockText(custom).includes('保留脸上的痣'), '自定义锁定文案没有生效');
  ok(lockKey(custom) !== lockKey(state), '自定义文案没有反映到缓存 key');

  // 关掉一个默认开着的锁，摘要里应消失
  const offState = toggleLockState(state, firstId);
  ok(!buildLockText(offState).includes(LOCKS[0].phrase), '关掉的锁仍拼进了提示词');

  // 配置升级：失效 id 丢弃、自定义文案保留
  const normalized = normalizeLockState({ on: { nope: true }, phrases: { [firstId]: '保留胎记' } });
  ok(normalized.on.nope === undefined, '已下线的锁没有被丢弃');
  ok(normalized.phrases[firstId] === '保留胎记', '配置升级后自定义文案丢了');

  // 冲突提示只提示、不改选择
  const personId = LOCKS.find((item) => item.id === 'person');
  const sceneId = LOCKS.find((item) => item.id === 'scene');
  if (personId && personId.defaultOn) {
    ok(detectLockTip({ angle: 'back' }, state).includes('背面'), '背面机位没有给出人物锁冲突提示');
  }
  if (sceneId && sceneId.defaultOn) {
    ok(detectLockTip({ dof: 'shallow' }, state).includes('保留环境结构'), '背景虚化没有说明场景锁仍保留环境结构');
    ok(detectLockTip({ dof: 'motion_blur' }, state).includes('拖影'), '动态拖影没有给出场景细节提醒');
  }
  const noneState = { on: {}, phrases: {} };
  ok(detectLockTip({}, noneState).includes('都没锁'), '全不锁时没有风险提示');
}

/* ---------- 1. 结构 ---------- */
for (const [key, dim] of Object.entries(DIMS)) {
  ok(Array.isArray(dim.options) && dim.options.length >= 2, `${key} 取值少于两项`);
  ok(dim.options[0].id === 'auto', `${key} 第一项不是 auto`);
  const ids = dim.options.map((o) => o.id);
  ok(new Set(ids).size === ids.length, `${key} 取值 id 重复`);
  dim.options.forEach((o) => {
    ok(typeof o.label === 'string' && o.label, `${key}/${o.id} 缺 label`);
    ok(typeof o.phrase === 'string', `${key}/${o.id} phrase 不是字符串`);
    ok(!o.phrase.includes('。'), `${key}/${o.id} 的 phrase 里出现句号（会打断整句拼装）`);
    ok(o.group === undefined || typeof o.group === 'string', `${key}/${o.id} 的 group 不是字符串`);
    // 非 auto 的取值必须有自己的 group，否则界面分组会切出一个没有标题的孤儿块
    if (o.id !== 'auto') ok(Boolean(o.group), `${key}/${o.id} 没有 group，界面分组会错位`);
  });
}

for (const cat of CATS) {
  ok(cat.dims.length > 0, `分类 ${cat.id} 没有维度`);
  cat.dims.forEach((key) => ok(DIMS[key], `分类 ${cat.id} 引用了不存在的维度 ${key}`));
}
const covered = new Set(CATS.flatMap((c) => c.dims));
Object.keys(DIMS).forEach((key) => ok(covered.has(key), `维度 ${key} 没挂在任何分类下，界面上选不到`));
ORDER.forEach((key) => ok(DIMS[key], `order 引用不存在的维度 ${key}`));
Object.keys(DIMS).forEach((key) => ok(ORDER.indexOf(key) !== -1, `维度 ${key} 不在 order 里，永远拼不进提示词`));

/* ---------- 2. 拼装 ---------- */
const copy = cfg.copy;

// 零选择：必须什么都不拼。产品前提是「不选也能生图」，如果这里还冒出指令，
// 就等于用户没选却被塞了东西。
const autoElements = buildElements(SEL0);
ok(autoElements === '', `全 auto 应该什么都不拼，实际拼出「${autoElements}」`);
const defaultLockStateForPrompt = defaultLockState();
const defaultLockText = buildLockText(defaultLockStateForPrompt);
const zeroPrompt = buildPrompt({ elements: autoElements, locks: defaultLockText, extra: '', reference: '' });
ok(zeroPrompt.length > 0, '零选择的整段提示词是空的（只剩骨架也该有 lead/locks/tail）');
ok(zeroPrompt.startsWith(copy.lead) && zeroPrompt.includes(copy.tail), '零选择的提示词缺骨架段');
ok(
  zeroPrompt === [copy.lead, defaultLockText, copy.tail].filter(Boolean).join('。'),
  '零选择时出现了骨架与锁定之外的指令',
);
const noLockPrompt = buildPrompt({ elements: autoElements, locks: '', extra: '', reference: '' });
ok(noLockPrompt === [copy.lead, copy.tail].join('。'), '关掉全部锁后仍然拼进了锁定段');

// 锁定段必须排在用户描述之后、质量底线之前（越靠后越不容易被前面的长句冲淡）
const orderPrompt = buildPrompt({
  elements: '全景',
  locks: '保持原图人物的身份不变',
  extra: '更亮一点',
  reference: '参考图说明',
});
ok(orderPrompt.indexOf('更亮一点') < orderPrompt.indexOf('保持原图人物的身份不变'), '锁定段没有排在用户描述之后');
ok(orderPrompt.indexOf('保持原图人物的身份不变') < orderPrompt.indexOf(copy.tail), '锁定段没有排在质量底线之前');

// 顺序：景别要出现在光位前面（前 20 字定构图），场景要在影调之前
const full = {};
Object.keys(DIMS).forEach((key) => {
  const opt = DIMS[key].options.reduce((a, b) => ((b.share || 0) > (a.share || 0) && b.id !== 'auto' ? b : a), DIMS[key].options[1]);
  full[key] = opt.id;
});
const fullElements = buildElements(full);
const pos = (dimKey) => {
  const opt = DIMS[dimKey].options.find((o) => o.id === full[dimKey]);
  return opt && opt.phrase ? fullElements.indexOf(opt.phrase) : -1;
};
ok(pos('shot') < pos('lightDir'), '景别没有排在光位之前（前 20 字要定构图）');
ok(pos('dof') < pos('lightDir'), '景深没有排在光位之前（取景组要连在一起）');
ok(pos('lightDir') < pos('grade'), '光位没有排在后期之前');
ok(pos('shot') >= 0, '全选时景别没有拼进提示词');

// 全选时不能有完全重复的短语（同一句话说两遍）
const fullSplit = fullElements.split('，').map((s) => s.trim());
ok(fullSplit.every((s) => s), '全选时出现空短语');
const dup = fullSplit.filter((s, i) => fullSplit.indexOf(s) !== i);
ok(dup.length === 0, `全选时出现重复短语: ${JSON.stringify([...new Set(dup)])}`);

// 整段提示词长度（Agnes / Nexus 上限 1900，混元 8100）
const fullPrompt = buildPrompt({ elements: fullElements, locks: defaultLockText, extra: '', reference: '' });
ok(fullPrompt.length < 1900, `全选时整段 ${fullPrompt.length} 字，超过 Agnes/Nexus 的 1900 上限`);
ok(fullPrompt.startsWith(copy.lead), '提示词没有以 copy.lead 开头');
ok(fullPrompt.trim().endsWith(copy.tail.replace(/[。\s]+$/, '')), '提示词没有以 copy.tail 结尾');
if (defaultLockText) ok(fullPrompt.includes(defaultLockText), '提示词里没有默认锁定段');

/* ---------- 3. 随机抽样 ---------- */
let worst = 0;
let worstCase = null;
for (let i = 0; i < 3000; i += 1) {
  const sel = {};
  Object.keys(DIMS).forEach((key) => {
    const opts = DIMS[key].options;
    // 一半概率留 auto，一半随机选一个
    sel[key] = Math.random() < 0.5 ? 'auto' : opts[Math.floor(Math.random() * opts.length)].id;
  });
  const elements = buildElements(sel);
  ok(!elements.includes('，，'), `随机组合拼出空段: ${JSON.stringify(sel)}`);
  const text = buildPrompt({ elements, locks: defaultLockText });
  if (text.length > worst) {
    worst = text.length;
    worstCase = sel;
  }
  ok(text.length < 1900, `随机组合超长 ${text.length}: ${JSON.stringify(sel)}`);
}

/* ---------- 4. 稳定 key ---------- */
{
  const a = { shot: 'full', lightDir: 'right' };
  const b = { lightDir: 'right', shot: 'full' };
  ok(selectionKey(a) === selectionKey(b), 'selectionKey 受选择顺序影响');
  ok(selectionKey(a).split('|').length === ORDER.length, 'selectionKey 没有覆盖全部维度');
}

/* ---------- 5. 视图 ---------- */
{
  const views = buildDimViews(CATS[0].id, { ...SEL0, [CATS[0].dims[0]]: DIMS[CATS[0].dims[0]].options[1].id });
  ok(views.length === CATS[0].dims.length, '视图维度数与分类配置不一致');
  views.forEach((v) => {
    ok(v.options.every((o) => typeof o.cls === 'string' && o.cls.startsWith('dchip')), `${v.key} 的 cls 异常`);
    ok(v.options.filter((o) => o.selected).length === 1, `${v.key} 选中项不是恰好 1 个`);
    ok(typeof v.pickedDesc === 'string' && v.pickedDesc, `${v.key} 缺 pickedDesc`);

    // 精简态只露出常用项，但当前选中项绝不能因为收起而消失。
    ok(Array.isArray(v.groups) && v.groups.length > 0, `${v.key} 缺分组`);
    const flat = (v.groups || []).flatMap((g) => g.options);
    ok(flat.length <= v.options.length, `${v.key} 精简态取值数异常`);
    ok(flat.some((o) => o.selected), `${v.key} 精简态隐藏了当前选中项`);
    ok(flat.every((o) => typeof o.cls === 'string' && o.cls.startsWith('dchip')), `${v.key} 分组内的 cls 异常`);
    ok((v.groups || []).every((g) => typeof g.showName === 'boolean'), `${v.key} 分组的 showName 不是布尔`);

    // 展开后必须一个不少地恢复完整列表，否则冷门项会永远选不到。
    const expandedView = buildDimViews(CATS[0].id, SEL0, { [v.key]: true }).find((item) => item.key === v.key);
    const expandedFlat = (expandedView.groups || []).flatMap((g) => g.options);
    ok(expandedFlat.length === v.options.length, `${v.key} 展开后没有恢复全部取值`);
    ok(expandedView.moreText === '收起', `${v.key} 展开后的操作文案不对`);
  });
  ok(countPicked(CATS[0].id, SEL0) === 0, 'defaultSelection 不算「已选」却有计数');
  const one = { ...SEL0, [CATS[0].dims[0]]: DIMS[CATS[0].dims[0]].options[1].id };
  ok(countPicked(CATS[0].id, one) === 1, '选了一项但计数不是 1');
  ok(describeSelection(one).includes('：'), 'describeSelection 格式不对');
}

/* ---------- 6. 坏配置必须被拒 ---------- */
{
  const clone = () => JSON.parse(JSON.stringify(cfg));
  // 用 order 里真实存在的维度名构造「漏维度」的坏配置，别写死某个维度：
  // 维度一旦下线，写死的那条会变成「配置其实没坏」，检查悄悄失效。
  const lastKey = ORDER[ORDER.length - 1];
  const broken = [
    ['不是对象', null],
    ['schema 错', (() => { const c = clone(); c.schema = 'x'; return c; })()],
    ['版本非正整数', (() => { const c = clone(); c.version = 0; return c; })()],
    ['copy 缺字段', (() => { const c = clone(); delete c.copy.lead; return c; })()],
    ['锁少于两项', (() => { const c = clone(); c.locks.items = c.locks.items.slice(0, 1); return c; })()],
    ['锁重复 id', (() => { const c = clone(); c.locks.items[1].id = c.locks.items[0].id; return c; })()],
    ['锁 defaultOn 非布尔', (() => { const c = clone(); c.locks.items[0].defaultOn = 'yes'; return c; })()],
    ['锁文案带句号', (() => { const c = clone(); c.locks.items[0].phrase += '。'; return c; })()],
    ['锁文案超长', (() => { const c = clone(); c.locks.items[0].phrase = '保'.repeat(201); return c; })()],
    ['维度缺 options', (() => { const c = clone(); delete c.dims.shot.options; return c; })()],
    ['第一项不是 auto', (() => { const c = clone(); c.dims.shot.options.shift(); return c; })()],
    ['order 漏维度', (() => { const c = clone(); c.order = c.order.filter((k) => k !== lastKey); return c; })()],
    ['order 引用不存在维度', (() => { const c = clone(); c.order.push('nope'); return c; })()],
    ['分类引用不存在维度', (() => { const c = clone(); c.categories[0].dims.push('nope'); return c; })()],
    ['默认值不存在', (() => { const c = clone(); c.defaults.shot = 'nope'; return c; })()],
    ['默认值缺失', (() => { const c = clone(); delete c.defaults[lastKey]; return c; })()],
  ];
  broken.forEach(([label, bad]) => {
    ok(validateConfig(bad).ok === false, `坏配置未被拦住: ${label}`);
  });
  ok(validateConfig(clone()).ok === true, '健康配置被误判为坏');
}

/* ---------- 7. 版本择优（热更新的核心：只升不降、同版本不重复应用） ---------- */
{
  const next = JSON.parse(JSON.stringify(cfg));
  next.version = cfg.version + 1;
  ok(cfgMod.applyPromptConfig(next, { from: 'test' }) === true, '更高版本没有生效');
  ok(cfgMod.getPromptVersion() === cfg.version + 1, '应用后版本号未更新');
  ok(cfgMod.applyPromptConfig(next, { from: 'test' }) === false, '同版本应被忽略（否则每次启动都重建菜单）');
  ok(cfgMod.applyPromptConfig(JSON.parse(JSON.stringify(cfg)), { from: 'test' }) === false, '低版本回滚应被拒绝');
  ok(
    cfgMod.applyPromptConfig({ ...next, version: 99, copy: {} }, { from: 'test' }) === false,
    '版本更高但结构坏的配置不该被接受',
  );
  ok(cfgMod.getPromptVersion() === cfg.version + 1, '被拒的配置污染了当前版本');
}

/* ---------- 输出 ---------- */
const optionCount = ORDER.reduce((n, k) => n + DIMS[k].options.length, 0);
console.log(`配置 v${cfg.version} · ${CATS.length} 分类 / ${ORDER.length} 维度 / ${optionCount} 取值 / ${LOCKS.length} 锁`);
CATS.forEach((c) => console.log(`  ${c.name}: ${c.dims.map((k) => `${DIMS[k].name}(${DIMS[k].options.length})`).join(' ')}`));
console.log(`锁: ${LOCKS.map((item) => `${item.name}(${item.defaultOn ? '开' : '关'})`).join(' · ')}`);
console.log(`默认锁定段: 「${defaultLockText}」`);
console.log(`全 auto 拼装: 「${autoElements}」`);
console.log(`全选拼装长度: ${fullElements.length} 字 / 整段 ${fullPrompt.length} 字`);
console.log(`随机 3000 组最长: ${worst} 字`);
console.log(fails.length ? `❌ ${fails.length} 项失败:\n` + fails.slice(0, 20).join('\n') : '✅ 全部通过');

try {
  fs.rmSync(work, { recursive: true, force: true });
} catch (err) {
  // 临时目录删不掉不影响结果
}

process.exit(fails.length ? 1 : 0);
