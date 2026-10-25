/**
 * 微信开发者工具 MCP 直连工具库
 *
 * 会话里没挂载 wechat-devtools MCP 时，用这个模块直接 spawn `wechatide.cmd mcp`
 * 走 JSON-RPC over stdio，与 wechat-e2e.mjs 同一套通道。
 *
 * 用法（其它脚本 import）：
 *   import { connect } from './wechat-mcp.mjs';
 *   const mcp = await connect();
 *   await mcp.call('cloud_fn_list', { env });
 *   mcp.close();
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const EXE = 'C:\\Program Files (x86)\\Tencent\\微信web开发者工具\\wechatide.cmd';

/** 从 ~/.workbuddy/mcp.json 取 token，避免脚本里硬编码 */
function readToken() {
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), '.workbuddy', 'mcp.json'), 'utf8'));
    const args = cfg?.mcpServers?.['wechat-devtools']?.args || [];
    const i = args.indexOf('--token');
    return i >= 0 ? args[i + 1] : '';
  } catch {
    return '';
  }
}

/** {result:{result:"<json>"}} / {success,data} / 裸值 三种都收敛成实际值 */
export function deep(raw) {
  let v = raw;
  for (let n = 0; n < 6; n += 1) {
    if (typeof v === 'string') {
      const t = v.trim();
      if (!t) return '';
      try {
        v = JSON.parse(t);
      } catch {
        return t;
      }
      continue;
    }
    if (v && typeof v === 'object') {
      if ('result' in v) {
        v = v.result;
        continue;
      }
      if ('data' in v) {
        v = v.data;
        continue;
      }
      return v;
    }
    return v;
  }
  return v;
}

export async function connect({ clientName = 'probe' } = {}) {
  const token = readToken();
  if (!token) throw new Error('未在 ~/.workbuddy/mcp.json 找到 wechat-devtools 的 --token');

  const child = spawn('cmd.exe', ['/c', EXE, 'mcp', '--token', token], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let buf = '';
  const pending = new Map();
  let seq = 1;

  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
      }
    }
  });

  const rpc = (method, params, timeout = 60000) =>
    new Promise((res, rej) => {
      const id = seq++;
      pending.set(id, { res, rej });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => pending.has(id) && (pending.delete(id), rej(new Error(`timeout ${method}`))), timeout);
    });

  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: clientName, version: '1' },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

  /** 调工具，返回原始文本 */
  const raw = async (name, args, timeout) => {
    const r = await rpc('tools/call', { name, arguments: args }, timeout);
    if (r && r.isError) throw new Error(`${name}: ${(r.content || []).map((c) => c.text).join('')}`);
    return (r?.content || []).map((c) => c.text || '').join('\n');
  };

  /** 调工具，返回拆包后的 JSON */
  const call = async (name, args, timeout) => deep(await raw(name, args, timeout));

  return { raw, call, listTools: () => rpc('tools/list', {}), close: () => child.kill() };
}
