/**
 * 计算 miniprogram_npm/tdesign-miniprogram 里「真正被用到」的组件闭包。
 * 用法：node .workbuddy/scripts/tdesign-prune.mjs [--apply]
 *
 * 判定方式：
 *  1. 从项目源码（排除 miniprogram_npm）里扫 `tdesign-miniprogram/<dir>/` 得到根集合
 *  2. 对每个保留的组件目录，扫其内部所有文本文件里的 `../<dir>/` 相对引用，递归扩集合
 *  3. 剩下没被引用的目录即为可删（另外 .d.ts / README.md 一律可删）
 */
import { readdirSync, readFileSync, statSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const npmDir = join(root, 'miniprogram_npm/tdesign-miniprogram');
const apply = process.argv.includes('--apply');

const TEXT_EXT = /\.(js|ts|json|wxml|wxss|wxs|less)$/;
const ALWAYS_NEEDED = new Set(['common', 'mixins', 'miniprogram_npm', 'style', '_util']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/* ---------- 1. 根集合：页面 / 组件 / app.json 里出现的组件 ---------- */
const projectFiles = walk(root).filter(
  (f) =>
    !f.includes('miniprogram_npm') &&
    !f.includes('node_modules') &&
    !f.includes('.git') &&
    !f.includes('cloudfunctions') &&
    !f.includes('output') &&
    !f.includes('.workbuddy') &&
    TEXT_EXT.test(f),
);

const roots = new Set();
for (const file of projectFiles) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/tdesign-miniprogram\/([a-z0-9-]+)\//g)) roots.add(m[1]);
}

/* ---------- 2. 组件内部相对引用，递归扩展 ---------- */
const dirs = readdirSync(npmDir).filter((n) => statSync(join(npmDir, n)).isDirectory());
const size = (dir) =>
  walk(join(npmDir, dir)).reduce((sum, f) => sum + statSync(f).size, 0);

const keep = new Set([...ALWAYS_NEEDED, ...roots].filter((d) => dirs.includes(d)));
const queue = [...keep];
while (queue.length) {
  const cur = queue.pop();
  for (const file of walk(join(npmDir, cur))) {
    if (!TEXT_EXT.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\.\.\/([a-z0-9-]+)\//g)) {
      const dep = m[1];
      if (!dirs.includes(dep) || keep.has(dep)) continue;
      keep.add(dep);
      queue.push(dep);
    }
  }
}

const drop = dirs.filter((d) => !keep.has(d));
const dropSize = drop.reduce((s, d) => s + size(d), 0);
const keepSize = [...keep].reduce((s, d) => s + size(d), 0);

console.log(`根组件（源码直接引用）: ${[...roots].sort().join(', ')}`);
console.log(`闭包保留 ${keep.size} 个目录 / ${(keepSize / 1024).toFixed(0)} KB`);
console.log(`可删 ${drop.length} 个目录 / ${(dropSize / 1024).toFixed(0)} KB`);
console.log(`可删目录: ${drop.sort().join(', ')}`);

/* ---------- 3. 文档 / 类型声明：运行时无用，一律删 ---------- */
const docFiles = walk(npmDir).filter((f) => /\.(d\.ts|md)$/.test(f));
const docSize = docFiles.reduce((s, f) => s + statSync(f).size, 0);
console.log(`\n.d.ts + .md: ${docFiles.length} 个 / ${(docSize / 1024).toFixed(0)} KB`);

if (!apply) {
  console.log('\n（预演，未删除。加 --apply 执行）');
  process.exit(0);
}

for (const d of drop) rmSync(join(npmDir, d), { recursive: true, force: true });
for (const f of docFiles) rmSync(f, { force: true });
console.log(`\n已删除 ${drop.length} 个组件目录 + ${docFiles.length} 个文档文件`);
