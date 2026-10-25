/**
 * 打印云函数相关 MCP 工具的参数结构（只读，不部署）
 */
import { connect } from './wechat-mcp.mjs';

const mcp = await connect();
try {
  const list = await mcp.listTools();
  const tools = list.tools || [];
  const hit = tools.filter((t) => /cloud_|polling/i.test(t.name));
  for (const t of hit) {
    const props = t.inputSchema?.properties || {};
    console.log(`\n### ${t.name}`);
    console.log('  required:', JSON.stringify(t.inputSchema?.required || []));
    for (const [k, v] of Object.entries(props)) {
      console.log(`  - ${k}: ${v.type || JSON.stringify(v)} ${v.description ? '// ' + String(v.description).slice(0, 90) : ''}`);
    }
  }
  if (!hit.length) console.log('无匹配工具，全部工具名：', tools.map((t) => t.name).join(', '));
} finally {
  mcp.close();
}
