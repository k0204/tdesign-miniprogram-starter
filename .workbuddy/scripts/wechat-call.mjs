/**
 * 微信开发者工具 MCP 通用调用器（兜底通道）
 *
 * 场景：WorkBuddy 内置的 mcp__wechat-devtools__* 通道挂了（报 `-32603 Bad Request`
 * 或 `Failed to connect to WechatIDE`），但 IDE 本身还活着。
 * 这个脚本直接 spawn `wechatide.cmd mcp`，走 JSON-RPC over stdio，能力与内置通道一致。
 *
 * 用法：
 *   node .workbuddy/scripts/wechat-call.mjs <toolName> '<json-params>'
 *   node .workbuddy/scripts/wechat-call.mjs <toolName> @params.json
 *   node .workbuddy/scripts/wechat-call.mjs cloud_fn_list '{"appid":"wx...","env":"cloud1-..."}'
 *
 * PowerShell 会把内联 JSON 里的双引号吃掉，参数多的时候用 @文件 最稳。
 *
 * 常用工具名：check_wechatide_status / cloud_env_list / cloud_fn_list / cloud_fn_info
 *            cloud_query_storage / cloud_manage_storage / cloud_db_read_doc / cloud_fn_deploy
 */
import fs from 'node:fs';
import { connect } from './wechat-mcp.mjs';

const [tool, paramsRaw] = process.argv.slice(2);
if (!tool) {
  console.error('用法: node wechat-call.mjs <toolName> \'<json-params>\' 或 @params.json');
  process.exit(1);
}

let params = {};
if (paramsRaw) {
  try {
    const text = paramsRaw.startsWith('@') ? fs.readFileSync(paramsRaw.slice(1), 'utf8') : paramsRaw;
    params = JSON.parse(text);
  } catch (err) {
    console.error('参数不是合法 JSON：', err.message);
    process.exit(1);
  }
}

const mcp = await connect();
try {
  const out = await mcp.call(tool, params, 120000);
  console.log(JSON.stringify(out, null, 2));
} catch (err) {
  console.error('调用失败：', err && (err.message || err));
  process.exitCode = 1;
} finally {
  mcp.close();
}
