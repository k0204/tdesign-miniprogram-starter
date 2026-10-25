/**
 * 实测混元图生图（HY-Image-v3.0-I2I-ToB）的 prompt 真实长度上限
 *
 * 运行：node .workbuddy/scripts/probe-hunyuan-prompt-limit.mjs
 *
 * 背景：前端卡 480、云函数卡 500（现已放宽到 8192 做实测），这两个数一直是自己拍的。
 * Hy-Image-3.0 官方文档标 prompt ≤ 8192 字符，但「文档上限」和「实际可用上限」是两件事：
 *   1. CloudBase 封装层是否另有校验
 *   2. 长 prompt 是否让生成耗时超过 `wx.cloud.callFunction` 的 60s 客户端硬限
 * 第 2 条往往才是真正的天花板 —— 用户等不到结果，等于不可用。
 *
 * 为什么不用「await callFunction」的写法：
 * automator 通道自己有响应超时（约 90s），长 prompt 会先把它耗死，
 * 拿到的只是 `timeout waiting for automator response`，分不清是模型慢还是通道慢。
 * 所以改成「发起后立即返回，把 Promise 挂到 globalThis，隔一段时间再读」。
 *
 * 注意：每个成功的用例都会真的出一张图（有少量费用）。
 */
import { resolve } from 'node:path';
import { connect, deep } from './wechat-mcp.mjs';

const PROJECT = resolve(import.meta.dirname, '../..');
const FILE_ID =
  'cloud://cloud1-d4g48z822d1300a77.636c-cloud1-d4g48z822d1300a77-1512321434/ai-images/input/1792667370143-b0x938f5.jpg';

/** 和真实修图提示词结构相近的中文，重复填充到目标长度，避免无意义的 aaaa 干扰模型行为 */
const BASE =
  '保持原图构图与人物身份不变，仅调整整体曝光与白平衡，提亮中间调并恢复暗部层次，压低高光溢出，让肤色过渡自然。';

/** 从大到小：先测最可能失败的点，命中天花板就不必再花更长的钱 */
const CASES = [8192, 3000];
/** callFunction 客户端硬限 60s，多等 15s 让「超时」这件事自己浮出来 */
const WAIT_MS = 75000;
/** automator 单次响应上限，发起/读取都必须很快返回，不能在这里等生成 */
const START_TIMEOUT_MS = 30000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const startFn = (len, slot) => `function () {
  var base = ${JSON.stringify(BASE)};
  var prompt = base.repeat(Math.ceil(${len} / base.length)).slice(0, ${len});
  var started = Date.now();
  globalThis['${slot}'] = { pending: true, reqLen: ${len}, actualLen: prompt.length };
  wx.cloud.callFunction({
    name: 'imageToImage',
    data: { prompt: prompt, fileID: ${JSON.stringify(FILE_ID)}, size: '1024x1024' }
  }).then(function (res) {
    var r = (res && res.result) || {};
    globalThis['${slot}'] = {
      reqLen: ${len}, actualLen: prompt.length,
      elapsed: Date.now() - started,
      ok: !!r.ok, error: r.error || '', hasFile: r.fileID ? 'yes' : 'no'
    };
  }).catch(function (err) {
    globalThis['${slot}'] = {
      reqLen: ${len}, actualLen: prompt.length,
      elapsed: Date.now() - started,
      ok: false,
      threw: (err && (err.errMsg || err.message)) || String(err)
    };
  });
  return { started: true, reqLen: ${len}, actualLen: prompt.length };
}`;

const readFn = (slot) => `function () { return globalThis['${slot}'] || { missing: true }; }`;

const mcp = await connect();
const results = [];
try {
  for (let i = 0; i < CASES.length; i += 1) {
    const len = CASES[i];
    const slot = `__probe_${len}`;
    console.log(`\n→ 发起长度 ${len} ...`);
    const started = deep(
      await mcp.call(
        'automation_evaluate',
        { project: PROJECT, action: 'evaluate', fnSource: startFn(len, slot) },
        START_TIMEOUT_MS,
      ),
    );
    console.log('   发起结果:', JSON.stringify(started));

    console.log(`   等待 ${WAIT_MS / 1000}s（跨过 callFunction 的 60s 硬限）...`);
    await sleep(WAIT_MS);

    const out = deep(
      await mcp.call(
        'automation_evaluate',
        { project: PROJECT, action: 'evaluate', fnSource: readFn(slot) },
        START_TIMEOUT_MS,
      ),
    );
    const r = out && out.reqLen !== undefined ? out : (out && out.result) || out;
    results.push(r);
    console.log('   最终状态:', JSON.stringify(r));
  }
} finally {
  mcp.close();
}

console.log('\n===== 汇总 =====');
results.forEach((r) => {
  if (!r || r.reqLen === undefined) {
    console.log(`?    ${JSON.stringify(r)}`);
    return;
  }
  const label = r.ok ? 'OK  ' : 'FAIL';
  const detail = r.ok
    ? `fileID=${r.hasFile}`
    : r.error || r.threw || (r.pending ? '仍在生成（未在 75s 内完成）' : '未知');
  console.log(`${label} len=${r.reqLen} elapsed=${r.elapsed || '-'}ms ${detail}`);
});
