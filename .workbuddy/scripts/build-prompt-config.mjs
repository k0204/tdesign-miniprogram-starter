/**
 * 生成待上传的提示词配置 JSON
 *
 *   node .workbuddy/scripts/build-prompt-config.mjs
 *
 * 输入  config/prompts/aiImage.factors.js（唯一手写来源，由 build-factors-config.mjs 从 docs 语料生成）
 * 输出  .workbuddy/out/aiImage.factors.json（加 contentHash / builtAt，供上传）
 *
 * 为什么要有这个中间文件，而不是直接传 .js：
 *   小程序端读云端文件是用 JSON.parse 解析下载下来的文本，传 js 过去会解析失败。
 *
 * 为什么强制校验版本号：
 *   云端按 version 决定要不要替换本地配置。如果改了提示词却没 +1，
 *   传上去等于石沉大海（客户端认为「不比我新」直接忽略），而且没有任何报错。
 *   所以这里比对新旧内容 hash：内容变了但版本没升，直接失败退出。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const SRC = path.join(root, 'config/prompts/aiImage.factors.js');
const OUT_DIR = path.join(root, '.workbuddy/out');
const OUT = path.join(OUT_DIR, 'aiImage.factors.json');

function fail(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

const source = fs.readFileSync(SRC, 'utf8');
const marker = 'export default ';
const at = source.indexOf(marker);
if (at === -1) fail(`${SRC} 里找不到 "export default"`);

let config;
try {
  // 去掉结尾的分号，剩下的必须是一段合法 JSON（default.js 就是 JSON 本体）
  const raw = source.slice(at + marker.length).trim().replace(/;\s*$/, '');
  config = JSON.parse(raw);
} catch (err) {
  fail(`配置不是合法 JSON（factors.js 的 export default 必须是纯 JSON 字面量）: ${err.message}`);
}

/* ---------- 结构快检：和客户端 validateConfig 同一套底线 ---------- */
const problems = [];
if (config.schema !== 'aiImage.factors') problems.push('schema 必须是 aiImage.factors');
if (!Number.isInteger(config.version) || config.version <= 0) problems.push('version 必须是正整数');
const copy = config.copy || {};
['lead', 'tail'].forEach((k) => {
  if (typeof copy[k] !== 'string' || !copy[k].trim()) problems.push(`copy.${k} 缺失`);
});

const lockItems = (config.locks && config.locks.items) || [];
if (!Array.isArray(lockItems) || lockItems.length < 2) problems.push('locks.items 少于两项');
else {
  const lockIds = new Set();
  lockItems.forEach((item) => {
    if (!item || !item.id || !item.name || !item.phrase) problems.push('locks.items 有项缺 id/name/phrase');
    if (typeof item.defaultOn !== 'boolean') problems.push(`locks.${(item && item.id) || '?'}.defaultOn 不是布尔`);
      if (item && item.mandatory !== undefined && typeof item.mandatory !== 'boolean') {
        problems.push(`locks.${item.id || '?'}.mandatory 不是布尔`);
      }
      if (item && item.mandatory && !item.defaultOn) problems.push(`必选锁 ${item.id || '?'} 必须默认开启`);
    if (item && typeof item.phrase === 'string' && item.phrase.includes('。')) {
      problems.push(`locks.${item.id}.phrase 里出现句号（会打断拼装）`);
    }
    if (item && item.id) {
      if (lockIds.has(item.id)) problems.push(`locks.${item.id} 重复`);
      lockIds.add(item.id);
    }
  });
  const featuresLock = lockItems.find((item) => item && item.id === 'features');
  if (!featuresLock || !featuresLock.mandatory || !featuresLock.defaultOn) {
    problems.push('五官锁必须存在并设为必选');
  }
}

const dims = config.dims || {};
const dimKeys = Object.keys(dims);
if (!dimKeys.length) problems.push('dims 为空');
Object.entries(dims).forEach(([key, dim]) => {
  if (!dim.name) problems.push(`dims.${key} 缺 name`);
  if (!Array.isArray(dim.options) || dim.options.length < 2) problems.push(`dims.${key}.options 少于两项`);
  else {
    if (dim.options[0].id !== 'auto') problems.push(`dims.${key} 的第一项必须是 auto`);
    dim.options.forEach((o) => {
      if (!o.id || !o.label) problems.push(`dims.${key} 有取值缺 id/label`);
      if (typeof o.phrase !== 'string') problems.push(`dims.${key}.${o.id}.phrase 不是字符串`);
    });
  }
});

const order = config.order || [];
if (!order.length) problems.push('order 为空');
order.forEach((key) => {
  if (!dims[key]) problems.push(`order 引用了不存在的维度 ${key}`);
});
dimKeys.forEach((key) => {
  if (order.indexOf(key) === -1) problems.push(`维度 ${key} 没有出现在 order 里`);
});

const cats = config.categories || [];
if (!cats.length) problems.push('categories 为空');
cats.forEach((cat) => {
  if (!cat.id || !cat.name || !cat.icon) problems.push('categories 项缺 id/name/icon');
  if (!Array.isArray(cat.dims) || !cat.dims.length) problems.push(`categories.${cat.id}.dims 为空`);
  else cat.dims.forEach((key) => {
    if (!dims[key]) problems.push(`categories.${cat.id} 引用了不存在的维度 ${key}`);
  });
});

const defaults = config.defaults || {};
dimKeys.forEach((key) => {
  const value = defaults[key];
  if (value === undefined) problems.push(`defaults.${key} 缺失`);
  else if ((dims[key].options || []).every((o) => o.id !== value)) {
    problems.push(`defaults.${key} 的值 ${value} 不存在`);
  }
});

if (problems.length) fail('配置结构有问题：\n  - ' + problems.join('\n  - '));

/* ---------- 内容 hash：把「改了内容」和「改了版本号」分开看 ---------- */
const hashOf = (cfg) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify({ ...cfg, updatedAt: undefined, contentHash: undefined, builtAt: undefined }))
    .digest('hex')
    .slice(0, 16);

const contentHash = hashOf(config);

let previous = null;
if (fs.existsSync(OUT)) {
  try {
    previous = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  } catch (err) {
    previous = null;
  }
}

if (previous && previous.contentHash === contentHash) {
  console.log(`配置内容未变（v${config.version} / ${contentHash}），仍会重新生成上传包。`);
} else if (previous && config.version <= (previous.version || 0)) {
  fail(
    `提示词内容改过了，但 version 没有升：旧 v${previous.version} → 新 v${config.version}。\n` +
      `   客户端只认版本更大的配置，直接上传会被静默忽略。\n` +
      `   请先把 config/prompts/aiImage.factors.js 的 version 改成 ${(previous.version || 0) + 1}。`,
  );
}

const output = {
  ...config,
  contentHash,
  builtAt: new Date().toISOString(),
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

const bytes = Buffer.byteLength(fs.readFileSync(OUT));
const optionCount = Object.values(dims).reduce((n, d) => n + d.options.length, 0);
console.log(`✅ 已生成 ${path.relative(root, OUT)}`);
console.log(
  `   v${config.version} · ${contentHash} · ${(bytes / 1024).toFixed(1)} KB · ` +
    `${cats.length} 个分类 / ${dimKeys.length} 个维度 / ${optionCount} 个取值 / ${lockItems.length} 个锁`,
);
console.log('   下一步：node .workbuddy/scripts/upload-prompt-config.mjs');
