/**
 * 只读体检：提示词配置 / 页面代码 / 云函数 三者是否同步
 *
 *   node .workbuddy/scripts/check-sync.mjs
 *
 * 检查项：
 *   1. 本地 factors.js 是否能构建、版本与 hash（走 build 的同一套校验）
 *   2. 云存储 prompts/aiImage.factors.json 的 version / contentHash
 *   3. 各云函数云端 updateTime vs 本地最新文件 mtime
 *
 * 全程只读，不弹 IDE 确认框。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { connect } from './wechat-mcp.mjs';

const APPID = 'wx16f3362b82c554fd';
const ENV = 'cloud1-d4g48z822d1300a77';
const CLOUD_PATH = 'prompts/aiImage.factors.json';

const root = path.resolve(import.meta.dirname, '../..');
const SRC = path.join(root, 'config/prompts/aiImage.factors.js');
const OUT = path.join(root, '.workbuddy/out/aiImage.factors.json');

function hashOf(cfg) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ ...cfg, updatedAt: undefined, contentHash: undefined, builtAt: undefined }))
    .digest('hex')
    .slice(0, 16);
}

/* ---------- 本地 ---------- */
const source = fs.readFileSync(SRC, 'utf8');
const marker = 'export default ';
const localCfg = JSON.parse(source.slice(source.indexOf(marker) + marker.length).trim().replace(/;\s*$/, ''));
const localHash = hashOf(localCfg);

let outCfg = null;
if (fs.existsSync(OUT)) {
  try {
    outCfg = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  } catch {
    outCfg = null;
  }
}

const optCount = Object.values(localCfg.dims || {}).reduce((n, d) => n + d.options.length, 0);

console.log('==== 本地 ====');
console.log(`factors.js      v${localCfg.version} / ${localHash} / ${optCount} 取值 / ${(localCfg.locks?.items || []).length} 锁`);
if (outCfg) {
  const same = outCfg.contentHash === localHash && outCfg.version === localCfg.version;
  console.log(`上传包 out.json  v${outCfg.version} / ${outCfg.contentHash} ${same ? '✅ 与源码一致' : '❌ 与源码不一致，需要重新 build'}`);
} else {
  console.log('上传包 out.json  缺失，需要 build');
}

/* ---------- 云端 ---------- */
function unwrap(res) {
  const content = res && res.result && res.result.content;
  const text = Array.isArray(content) && content[0] && content[0].text;
  if (typeof text === 'string') {
    try {
      return JSON.parse(text);
    } catch {
      return res;
    }
  }
  return res;
}

const mcp = await connect();

try {
  console.log('\n==== 云存储 ====');
  let remote = null;
  try {
    const back = await mcp.call(
      'cloud_query_storage',
      { appid: APPID, env: ENV, action: 'read', cloudPath: CLOUD_PATH },
      60000,
    );
    const payload = unwrap(back);
    const text = typeof payload === 'string' ? payload : payload && (payload.content || payload.text || payload.data);
    remote = typeof text === 'string' ? JSON.parse(text) : text;
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.log(`读取失败：${msg.slice(0, 200)}`);
  }

  if (remote && remote.version) {
    const remoteHash = remote.contentHash || hashOf(remote);
    const same = remoteHash === localHash && remote.version === localCfg.version;
    const rOpt = Object.values(remote.dims || {}).reduce((n, d) => n + d.options.length, 0);
    console.log(`云存储          v${remote.version} / ${remoteHash} / ${rOpt} 取值 ${same ? '✅ 与本地一致' : '❌ 与本地不一致'}`);
    if (!same) {
      console.log(`   云端 dims: ${Object.keys(remote.dims || {}).join(',')}`);
      console.log(`   本地 dims: ${Object.keys(localCfg.dims || {}).join(',')}`);
    }
  } else if (remote === null) {
    console.log('云存储          未能读取（见上）');
  } else {
    console.log(`云存储          返回内容不可解析：${JSON.stringify(remote).slice(0, 200)}`);
  }

  /* ---------- 云函数 ---------- */
  console.log('\n==== 云函数 ====');
  let list = null;
  try {
    list = await mcp.call('cloud_fn_list', { appid: APPID, env: ENV }, 60000);
  } catch (err) {
    console.log(`列出失败：${(err && err.message ? err.message : String(err)).slice(0, 200)}`);
  }

  const flat = [];
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      if (v.name && (v.updateTime || v.modTime || v.lastUpdateTime)) flat.push(v);
      else Object.values(v).forEach(walk);
    }
  };
  walk(list);

  const dirs = fs
    .readdirSync(path.join(root, 'cloudfunctions'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const newestLocal = (dir) => {
    let newest = 0;
    const walkDir = (p) => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const full = path.join(p, e.name);
        if (e.isDirectory()) {
          if (e.name === 'node_modules' || e.name === '.git') continue;
          walkDir(full);
        } else {
          const t = fs.statSync(full).mtimeMs;
          if (t > newest) newest = t;
        }
      }
    };
    walkDir(path.join(root, 'cloudfunctions', dir));
    return newest;
  };

  const fmt = (t) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 19) : '未知');

  if (!flat.length) {
    console.log('未解析到云函数列表，原始返回：', JSON.stringify(list).slice(0, 500));
  }

  for (const dir of dirs) {
    const hit = flat.find((f) => f.name === dir || f.functionName === dir || f.FunctionName === dir);
    const lt = newestLocal(dir);
    if (!hit) {
      console.log(`${dir.padEnd(20)} 云端未找到（本地有）⚠️`);
      continue;
    }
    const rtRaw = hit.updateTime || hit.modTime || hit.lastUpdateTime;
    const rt = typeof rtRaw === 'number' ? rtRaw : Date.parse(rtRaw);
    const flag = rt && lt > rt + 60 * 1000 ? '❌ 本地更新晚于云端，可能未部署' : '✅';
    console.log(`${dir.padEnd(20)} 云端 ${fmt(rt)}  本地 ${fmt(lt)}  ${flag}`);
  }
} finally {
  mcp.close();
}
