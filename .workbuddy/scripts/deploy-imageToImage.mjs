/**
 * 部署 imageToImage 云函数（走开发者工具 MCP），并在前后打印超时状态。
 *
 * 运行：node .workbuddy/scripts/deploy-imageToImage.mjs
 *
 * 坑：
 * - cloud_fn_deploy 是异步的，返回 {success, taskId, status:'pending', message:'Waiting for user confirmation.'}，
 *   必须在开发者工具弹窗里点确认，再用 polling_task_result 轮询（实测 15-20s）。
 * - **成功响应里没有 "success" 字样**，长这样：{"imageToImage":{"filesCount":2,"packSize":"4.1 KB"}}，
 *   判据是「出现 filesCount」或「status 不再是 pending」。早前按 /success/ 判断会白等满 90s。
 * - taskId 只在本次进程有效，必须同一脚本内接力。
 * - 部署不会重置执行超时，前后各查一次 cloud_fn_info 确认仍是 240s。
 */
import { resolve } from 'node:path';
import { connect, deep } from './wechat-mcp.mjs';

const APPID = 'wx16f3362b82c554fd';
const ENV = 'cloud1-d4g48z822d1300a77';
const FN_DIR = resolve('cloudfunctions/imageToImage');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mcp = await connect();
try {
  const before = await mcp.call('cloud_fn_info', { appid: APPID, env: ENV, names: 'imageToImage' }, 30000);
  console.log('部署前:', JSON.stringify(before));

  const task = await mcp.call(
    'cloud_fn_deploy',
    { appid: APPID, env: ENV, path: FN_DIR, 'remote-npm-install': true },
    120000,
  );
  console.log('派发结果:', JSON.stringify(task));

  const taskId = task?.taskId;
  if (!taskId) throw new Error('没有拿到 taskId，部署可能没发起');

  let last = null;
  let done = false;
  for (let i = 0; i < 40; i += 1) {
    await sleep(3000);
    last = deep(await mcp.call('polling_task_result', { taskId }, 30000));
    const s = typeof last === 'string' ? last : JSON.stringify(last);
    console.log(`轮询 ${i + 1}:`, s.slice(0, 400));
    // 成功：{"imageToImage":{"filesCount":2,"packSize":"4.1 KB"}} —— 没有 success 字样
    if (/filesCount/.test(s) || /"status":"(?!pending)/.test(s)) {
      done = true;
      break;
    }
    if (/fail|error/i.test(s)) break;
  }
  if (!done) console.log('⚠️ 未在 120s 内拿到部署结果，去控制台核对 filesCount / 代码版本');

  const after = await mcp.call('cloud_fn_info', { appid: APPID, env: ENV, names: 'imageToImage' }, 30000);
  console.log('部署后:', JSON.stringify(after));
} finally {
  mcp.close();
}
