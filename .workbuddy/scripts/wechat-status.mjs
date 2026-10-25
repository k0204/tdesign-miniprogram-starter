/**
 * 只读体检：开发者工具状态 + 云环境 + imageToImage 函数信息
 * 运行：node .workbuddy/scripts/wechat-status.mjs
 */
import { connect } from './wechat-mcp.mjs';

const APPID = 'wx16f3362b82c554fd';
const mcp = await connect();
try {
  const status = await mcp.call('check_wechatide_status', {}, 20000);
  console.log('IDE 状态:', JSON.stringify(status));

  const envs = await mcp.call('cloud_env_list', { appid: APPID }, 30000);
  console.log('云环境:', JSON.stringify(envs));

  const list = await mcp.call('cloud_fn_list', { appid: APPID, env: 'cloud1-d4g48z822d1300a77' }, 30000);
  console.log('函数列表:', JSON.stringify(list));

  const info = await mcp.call(
    'cloud_fn_info',
    { appid: APPID, env: 'cloud1-d4g48z822d1300a77', names: 'imageToImage,agnesImage,agnesImageWorker' },
    30000,
  );
  console.log('函数详情:', JSON.stringify(info, null, 2));
} finally {
  mcp.close();
}
