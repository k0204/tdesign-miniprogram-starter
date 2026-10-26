/**
 * 上传提示词配置到云存储
 *
 *   node .workbuddy/scripts/build-prompt-config.mjs   # 先生成
 *   node .workbuddy/scripts/upload-prompt-config.mjs  # 再上传
 *
 * 走微信开发者工具 MCP 的 cloud_manage_storage（底层是 IDE 的云开发通道），
 * 不需要腾讯云密钥，但**要求 IDE 处于登录状态**。IDE 掉登录会直接报
 * `{"code":"APPID_ERROR","error":"需要重新登录"}`，这时先打开开发者工具扫码登录。
 *
 * 上传后会读回来比对 version/contentHash，避免「以为传上去了、其实是旧文件」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { connect } from './wechat-mcp.mjs';

const APPID = 'wx16f3362b82c554fd';
const ENV = 'cloud1-d4g48z822d1300a77';
/** 与 pages/aiImage/promptConfig.js 的 PROMPT_CLOUD_PATH 必须一致 */
const CLOUD_PATH = 'prompts/aiImage.factors.json';

const root = path.resolve(import.meta.dirname, '../..');
const LOCAL = path.join(root, '.workbuddy/out/aiImage.factors.json');

if (!fs.existsSync(LOCAL)) {
  console.error(`❌ 找不到 ${path.relative(root, LOCAL)}，先跑 build-prompt-config.mjs`);
  process.exit(1);
}

const payload = JSON.parse(fs.readFileSync(LOCAL, 'utf8'));
const { version, contentHash } = payload;

console.log(`准备上传 v${version}（${contentHash}，${(fs.statSync(LOCAL).size / 1024).toFixed(1)} KB）`);
console.log(`目标 cloud://${ENV}/${CLOUD_PATH}`);

const mcp = await connect();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 写操作在 IDE 侧会先弹一个确认框，MCP 返回 `status:'pending'` + taskId。
 * 不处理这一步的话，看到 success:true 会误以为传上去了（实际还在等人点确认）。
 */
async function callWithConfirm(tool, params, timeout, { waitMs = 120000 } = {}) {
  let res = await mcp.call(tool, params, timeout);
  if (res && res.taskId && res.status === 'pending') {
    console.log('IDE 已弹出确认框，等待你点「确认」…（最多等 2 分钟）');
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await sleep(2000);
      const polled = await mcp.call('polling_task_result', { taskId: res.taskId }, 30000);
      if (polled && polled.status && polled.status !== 'pending') {
        res = polled;
        break;
      }
    }
  }
  return unwrap(res);
}

/** 业务结果可能直接在顶层，也可能被包在 result.content[0].text 的 JSON 里 */
function unwrap(res) {
  const content = res && res.result && res.result.content;
  const text = Array.isArray(content) && content[0] && content[0].text;
  if (typeof text === 'string') {
    try {
      return JSON.parse(text);
    } catch (err) {
      return res;
    }
  }
  return res;
}

try {
  const up = await callWithConfirm(
    'cloud_manage_storage',
    { appid: APPID, env: ENV, action: 'upload', cloudPath: CLOUD_PATH, localPath: LOCAL },
    180000,
  );
  console.log('upload →', JSON.stringify(up));
  if (!up || up.success === false) {
    console.error(`\n❌ 上传失败：${(up && (up.message || up.error)) || '未知原因'}`);
    console.error('   若提示「需要重新登录」，先打开微信开发者工具扫码登录，再重跑本脚本。');
    process.exitCode = 1;
  } else {
    // 读回来验证：云端内容必须就是刚传的这份
    const back = await callWithConfirm(
      'cloud_query_storage',
      { appid: APPID, env: ENV, action: 'read', cloudPath: CLOUD_PATH },
      60000,
    );
    const text = typeof back === 'string' ? back : back && (back.content || back.text || back.data);
    let remote = null;
    try {
      remote = typeof text === 'string' ? JSON.parse(text) : text;
    } catch (err) {
      remote = null;
    }

    if (remote && remote.version === version && remote.contentHash === contentHash) {
      console.log(`\n✅ 已上线：云存储 v${version}（${contentHash}）与本地一致`);
      console.log('   云端版本只有在比内置版本更大时才会被客户端采用；同版本会继续显示「内置」（预期）。');
    } else if (remote && remote.version) {
      console.error(`\n⚠️ 云端内容与本地不一致：云端 v${remote.version} / ${remote.contentHash}`);
      process.exitCode = 1;
    } else {
      const msg = (back && (back.message || back.error)) || '';
      console.warn(`\n⚠️ 上传返回成功，但读回校验没完成${msg ? `：${msg}` : '（可能是 CDN 尚未刷新）'}`);
      console.warn('   原始返回：', JSON.stringify(back).slice(0, 300));
    }
  }
} catch (err) {
  console.error('\n❌ 调用失败：', err && err.message ? err.message : err);
  if (String(err && err.message).includes('登录')) {
    console.error('   打开微信开发者工具扫码登录后重试。');
  }
  process.exitCode = 1;
} finally {
  mcp.close();
}
