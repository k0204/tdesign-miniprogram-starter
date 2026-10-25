import { connect } from './.workbuddy/scripts/wechat-mcp.mjs';
const mcp = await connect();
try {
  const out = await mcp.call('open_project_window', { project: 'H:/tdesign-miniprogram-starter' }, 300000);
  console.log(JSON.stringify(out, null, 2));
} catch (e) {
  console.error('失败:', e.message);
} finally { mcp.close(); }
