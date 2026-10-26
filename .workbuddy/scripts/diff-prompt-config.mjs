/**
 * 对比云端存量配置 vs 本地 factors.js，输出逐项差异
 *   node .workbuddy/scripts/diff-prompt-config.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { connect } from './wechat-mcp.mjs';

const APPID = 'wx16f3362b82c554fd';
const ENV = 'cloud1-d4g48z822d1300a77';
const CLOUD_PATH = 'prompts/aiImage.factors.json';
const root = path.resolve(import.meta.dirname, '../..');

const src = fs.readFileSync(path.join(root, 'config/prompts/aiImage.factors.js'), 'utf8');
const local = JSON.parse(src.slice(src.indexOf('export default ') + 15).trim().replace(/;\s*$/, ''));

const mcp = await connect();
let remote = null;
try {
  const back = await mcp.call(
    'cloud_query_storage',
    { appid: APPID, env: ENV, action: 'read', cloudPath: CLOUD_PATH },
    60000,
  );
  const content = back && back.result && back.result.content;
  const text = Array.isArray(content) && content[0] && content[0].text;
  let payload = back;
  if (typeof text === 'string') {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = back;
    }
  }
  const body = typeof payload === 'string' ? payload : payload && (payload.content || payload.text || payload.data);
  remote = typeof body === 'string' ? JSON.parse(body) : body;
} finally {
  mcp.close();
}

if (!remote || !remote.version) {
  console.log('云端配置读取失败或为空');
  process.exit(1);
}

fs.mkdirSync(path.join(root, '.workbuddy/out'), { recursive: true });
fs.writeFileSync(
  path.join(root, `.workbuddy/out/cloud-v${remote.version}.json`),
  JSON.stringify(remote, null, 2),
  'utf8',
);

console.log(`云端 v${remote.version} → 本地 v${local.version}\n`);

if (remote.copy?.lead !== local.copy?.lead) console.log(`copy.lead\n  - ${remote.copy?.lead}\n  + ${local.copy?.lead}`);
if (remote.copy?.tail !== local.copy?.tail) console.log(`copy.tail\n  - ${remote.copy?.tail}\n  + ${local.copy?.tail}`);

const rLocks = (remote.locks?.items || []).map((i) => i.id);
const lLocks = (local.locks?.items || []).map((i) => i.id);
if (rLocks.join() !== lLocks.join()) console.log(`锁项：云端 [${rLocks}] → 本地 [${lLocks}]`);
for (const item of local.locks?.items || []) {
  const old = (remote.locks?.items || []).find((i) => i.id === item.id);
  if (old && old.phrase !== item.phrase) console.log(`锁 ${item.id} phrase\n  - ${old.phrase}\n  + ${item.phrase}`);
}

const dimKeys = new Set([...Object.keys(remote.dims || {}), ...Object.keys(local.dims || {})]);
for (const key of dimKeys) {
  const a = remote.dims?.[key];
  const b = local.dims?.[key];
  if (!a) {
    console.log(`\n[新增维度] ${key} ${b.name}（${b.options.length} 项）`);
    continue;
  }
  if (!b) {
    console.log(`\n[删除维度] ${key} ${a.name}`);
    continue;
  }
  const aIds = a.options.map((o) => o.id);
  const bIds = b.options.map((o) => o.id);
  const added = bIds.filter((id) => !aIds.includes(id));
  const removed = aIds.filter((id) => !bIds.includes(id));
  const changed = [];
  for (const opt of b.options) {
    const old = a.options.find((o) => o.id === opt.id);
    if (!old) continue;
    if (old.label !== opt.label || old.phrase !== opt.phrase) changed.push({ id: opt.id, old, now: opt });
  }
  if (!added.length && !removed.length && !changed.length && aIds.join() === bIds.join()) continue;
  console.log(`\n[维度] ${key} ${b.name}  ${a.options.length} → ${b.options.length} 项`);
  if (added.length) console.log(`  新增取值: ${added.join(', ')}`);
  if (removed.length) console.log(`  删除取值: ${removed.join(', ')}`);
  if (aIds.join() !== bIds.join() && !added.length && !removed.length) console.log('  顺序有变');
  for (const c of changed) {
    if (c.old.label !== c.now.label) console.log(`  ${c.id} 名称: ${c.old.label} → ${c.now.label}`);
    if (c.old.phrase !== c.now.phrase) console.log(`  ${c.id} 短语:\n      - ${c.old.phrase}\n      + ${c.now.phrase}`);
  }
}
