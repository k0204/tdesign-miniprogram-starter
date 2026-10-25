/**
 * 微信开发者工具 MCP 自测脚本（AI 修图页回归 · 支持跨轴叠加）
 *
 * 不依赖 npm 包，直接以 JSON-RPC over stdio 连 wechatide 的 MCP 服务，
 * 用真实点击跑：单轴 32 个选项、跨轴叠加顺序、同轴替换、清单撤销、清空。
 *
 * 运行：
 *   node .workbuddy/scripts/wechat-e2e.mjs
 *   node .workbuddy/scripts/wechat-e2e.mjs --shots   # 额外输出每张卡截图
 *
 * 已知坑（工具版本 0.3.11）：
 * - automation_page_action 的 callMethod 会报 "No context found for objectId"，
 *   必须在页面上下文里用 automation_evaluate 调 handler。
 * - 选择器引擎忽略 :nth-child，永远命中第一个；精确定位用 [data-id="..."]。
 * - getData 带 dataPath 返回裸值、不带时返回 {success,data}；evaluate 返回
 *   {result:{result:"<json 字符串>"}}，需要递归拆包。
 * - 大 payload 会被截断，断言写在页面里、只回传短状态。
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PROJECT = resolve(process.cwd());
const SHOTS = process.argv.includes('--shots');
const EXE = 'C:\\Program Files (x86)\\Tencent\\微信web开发者工具\\wechatide.cmd';

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

const TOKEN = readToken();
if (!TOKEN) {
  console.error('未在 ~/.workbuddy/mcp.json 找到 wechat-devtools 的 --token');
  process.exit(1);
}

const child = spawn('cmd.exe', ['/c', EXE, 'mcp', '--token', TOKEN], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
let buf = '';
const pending = new Map();
let seq = 1;

const rpc = (method, params, timeout = 60000) =>
  new Promise((res, rej) => {
    const id = seq++;
    pending.set(id, { res, rej });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => pending.has(id) && (pending.delete(id), rej(new Error(`timeout ${method}`))), timeout);
  });

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

/** {result:{result:"<json>"}} / {success,data} / 裸值 三种都收敛成实际值 */
function deep(raw) {
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

const tool = async (name, args, timeout) => {
  const r = await rpc('tools/call', { name, arguments: args }, timeout);
  return (r.content || []).map((c) => c.text || '').join('\n');
};
const ev = async (body) =>
  deep(await tool('automation_evaluate', { project: PROJECT, action: 'evaluate', fnSource: `function(){${body}}` }, 60000));
const tap = (selector) => tool('automation_element_action', { project: PROJECT, action: 'tap', selector, wait: 0.25 }, 60000);
const shot = (name) => tool('simulator_screenshot', { project: PROJECT, path: join(tmpdir(), name), wait: 0.8 });

/**
 * 单轴断言（与文案无关：锚和约束都从页面数据里取，改文案不会让脚本失效）
 */
const CHECK_ONE = `var p=getCurrentPages().pop();
var c=p.data.activeCap;var s=p.data.picked;
if(!c) return 'nocard';
if(s.length!==1) return 'picked='+JSON.stringify(s);
var o=null;for(var i=0;i<c.options.length;i++){if(c.options[i].id===s[0])o=c.options[i];}
if(!o) return 'noopt';
var t=p.data.promptPreview||'';
var parts=p.data.promptParts||[];
var anchor=parts.length?parts[0].text:'';
var tail=parts.length?parts[parts.length-1].text:'';
if(t.indexOf(o.prompt)<0) return 'noitem';
if(anchor && t.indexOf(anchor)!==0) return 'anchor';
if(tail && t.slice(t.length-tail.length)!==tail) return 'tail';
if(c.keepHint && t.indexOf(c.keepHint)<0) return 'nokeep';
if(t.length>480) return 'long='+t.length;
return 'ok:'+t.length;`;

await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'probe', version: '1' }, // probe 已持久授权，换名会 pending
});
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

const status = deep(await tool('check_wechatide_status', { 'skill-version': '1.0.0' }, 30000));
if (status && status.loginExpired) {
  console.error('开发者工具未登录，请先在 IDE 里扫码');
  child.kill();
  process.exit(1);
}

await tool('open_project_window', { project: PROJECT, windowMode: 'liteMode' }, 240000);
await tool('automation_navigate', { project: PROJECT, action: 'reLaunch', url: '/pages/aiImage/index', wait: 3 }, 90000);

const problems = [];
const meta = [];
for (const id of ['composition', 'lighting', 'exposure', 'tone']) {
  const m = await ev(
    `var p=getCurrentPages().pop();p.chooseCap({currentTarget:{dataset:{id:'${id}'}}});
     var c=p.data.activeCap;return JSON.stringify({id:c.id,name:c.name,opts:c.options.map(function(o){return {id:o.id,label:o.label};})});`,
  );
  if (m && m.id) meta.push(m);
}
console.log('能力卡：' + meta.map((m) => `${m.name}(${m.opts.length})`).join(' '));

/* ---------- ① 单轴逐项：每次先清空，保证断言环境干净 ---------- */
let tapped = 0;
for (const cap of meta) {
  await ev('var p=getCurrentPages().pop();p.clearAll();return 1;');
  await ev(`var p=getCurrentPages().pop();p.chooseCap({currentTarget:{dataset:{id:'${cap.id}'}}});return 1;`);
  const cells = [];
  for (const opt of cap.opts) {
    await tap(`.chip[data-id="${opt.id}"]`);
    const r = String(await ev(CHECK_ONE));
    tapped += 1;
    if (!r.startsWith('ok:')) problems.push(`${cap.name}/${opt.label} → ${r}`);
    cells.push(`${opt.label}:${r.replace('ok:', '')}`);
  }
  console.log(`[${cap.name}] ${cells.join('  ')}`);
  if (SHOTS) await shot(`ai-${cap.id}.jpg`);
}

/* ---------- ② 跨轴叠加：顺序必须固定为 构图→光位→曝光→影调 ---------- */
await ev('var p=getCurrentPages().pop();p.clearAll();return 1;');
const pickOrder = [
  ['tone', 'tn-mono'], // 故意倒序点：先影调，最后构图
  ['exposure', 'ex-plus1'],
  ['lighting', 'ld-window'],
  ['composition', 'cp-thirds'],
];
for (const [capId, optId] of pickOrder) {
  await ev(`var p=getCurrentPages().pop();p.chooseCap({currentTarget:{dataset:{id:'${capId}'}}});return 1;`);
  await tap(`.chip[data-id="${optId}"]`);
}
const stacked = await ev(
  `var p=getCurrentPages().pop();var t=p.data.promptPreview;var caps=p.data.caps;var ids=p.data.picked;
   var order=[];
   ['composition','lighting','exposure','tone'].forEach(function(cid){
     var cap=null;for(var i=0;i<caps.length;i++){if(caps[i].id===cid)cap=caps[i];}
     if(!cap) return;
     var txt=null;for(var j=0;j<cap.options.length;j++){if(ids.indexOf(cap.options[j].id)>-1)txt=cap.options[j].prompt;}
     if(txt) order.push(t.indexOf(txt));
   });
   return JSON.stringify({picked:ids,list:p.data.pickedList.map(function(x){return x.capName+'·'+x.label;}),
   dots:Object.keys(p.data.pickMap).length,len:t.length,order:order});`,
);
console.log('\n[叠加] ' + stacked.list.join(' ｜ ') + `  → ${stacked.len} 字`);
const order = stacked.order;
const increasing = order.every((v, i) => v > -1 && (i === 0 || v > order[i - 1]));
if (stacked.list.length !== 4) problems.push(`叠加条数 ${stacked.list.length}`);
if (stacked.dots !== 4) problems.push(`分段圆点 ${stacked.dots}`);
if (!increasing) problems.push(`拼装顺序错乱 ${JSON.stringify(order)}`);
if (stacked.len > 480) problems.push(`叠加后 ${stacked.len} 字超限`);
if (SHOTS) await shot('ai-stacked.jpg');

/* ---------- ③ 同轴替换：换构图项不应增加条数 ---------- */
await tap('.chip[data-id="cp-center"]');
const replaced = await ev(
  `var p=getCurrentPages().pop();return JSON.stringify({n:p.data.picked.length,first:p.data.picked[0],hasOld:p.data.picked.indexOf('cp-thirds')});`,
);
console.log(`[同轴替换] ${replaced.n} 项，首项 ${replaced.first}，旧项残留=${replaced.hasOld}`);
if (replaced.n !== 4 || replaced.hasOld !== -1) problems.push(`同轴替换异常 ${JSON.stringify(replaced)}`);

/* ---------- ④ 点清单撤销一项 ---------- */
await tap('.stack__chip[data-id="ld-window"]');
const removed = await ev('var p=getCurrentPages().pop();return JSON.stringify({n:p.data.picked.length,hasLd:p.data.picked.indexOf("ld-window")});');
console.log(`[清单撤销] ${removed.n} 项，ld-window 还在=${removed.hasLd}`);
if (removed.n !== 3 || removed.hasLd !== -1) problems.push(`清单撤销异常 ${JSON.stringify(removed)}`);

/* ---------- ⑤ 清空 ---------- */
await tap('.stack__clear');
const cleared = await ev('var p=getCurrentPages().pop();return JSON.stringify({n:p.data.picked.length,preview:p.data.promptPreview.length,dots:Object.keys(p.data.pickMap).length});');
console.log(`[清空] ${cleared.n} 项，指令 ${cleared.preview} 字，圆点 ${cleared.dots}`);
if (cleared.n || cleared.preview || cleared.dots) problems.push(`清空未生效 ${JSON.stringify(cleared)}`);

/* ---------- ⑥ 预览三态：原图 / 对比 / 结果 ---------- */
await ev(
  "var p=getCurrentPages().pop();p.setData({sourcePath:'/static/image1.png',sourceFileID:'t',resultSrc:'/static/image2.png',stageView:'out'});return 1;",
);
const pairSel = '.pair';
const pairEmpty = deep(await tool('automation_element_action', { project: PROJECT, action: 'size', selector: pairSel }, 30000));

await tap('.stage__tab[data-view="both"]');
await new Promise((r) => setTimeout(r, 300));
const viewBoth = await ev('var p=getCurrentPages().pop();return p.data.stageView;');
const pairSize = deep(await tool('automation_element_action', { project: PROJECT, action: 'size', selector: pairSel }, 30000));
console.log(`[对比] view=${viewBoth} 并排区域=${pairSize && pairSize.width ? Math.round(pairSize.width) + 'x' + Math.round(pairSize.height) : '未渲染'}`);
if (viewBoth !== 'both') problems.push(`对比切换失败 ${viewBoth}`);
if (!pairSize || !pairSize.width) problems.push('对比态没有渲染并排两张图');

await tap('.stage__tab[data-view="src"]');
const viewSrc = await ev('var p=getCurrentPages().pop();return p.data.stageView;');
if (viewSrc !== 'src') problems.push(`切回原图失败 ${viewSrc}`);

await tap('.stage__tab[data-view="out"]');
const viewOut = await ev('var p=getCurrentPages().pop();return p.data.stageView;');
if (viewOut !== 'out') problems.push(`切回结果失败 ${viewOut}`);
console.log(`[切换] both→src→out 结果：${viewBoth}/${viewSrc}/${viewOut}`);

// 复原，避免影响后续手动调试
await ev("var p=getCurrentPages().pop();p.setData({sourcePath:'',sourceFileID:'',resultSrc:'',stageView:'src'});return 1;");

const con = await tool('get_simulator_console', { project: PROJECT, command: 'grep -n -i -E "typeerror|is not a function|cannot read" .' });

console.log(`\n单轴点击 ${tapped} 个选项`);
console.log(problems.length ? '发现问题:\n- ' + problems.join('\n- ') : '全部通过');

child.kill();
setTimeout(() => process.exit(problems.length ? 1 : 0), 200);
