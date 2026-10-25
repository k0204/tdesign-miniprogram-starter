/**
 * 探活 promptAdvisor —— 真图真调，确认「deepseek-v4.1-flash 图片理解是否已开通 + 实际耗时」
 *
 * 运行：node .workbuddy/scripts/probe-promptAdvisor.mjs
 *
 * 为什么必须真调一次：顾问走的是云开发托管的 DeepSeek 模型组，
 * 这个模型在本环境是否开通（资源点套餐 / 自定义模型）、单次跑多少秒，文档都答不了，
 * 只能拿一张真实云存储原图打一次。
 *
 * 费用参考：一次约「1 张图 + 数百 token 输出」，属于可忽略量级，且没有副作用
 * （不写库、不落盘、不生成图片）。
 */
import { resolve } from 'node:path';
import { connect, deep } from './wechat-mcp.mjs';

/** project 必须是绝对路径，写相对路径会按 cwd 解析并报 PROJECT_CONFIG_JSON_ERROR */
const PROJECT = resolve(import.meta.dirname, '../..');
const APPID = 'wx16f3362b82c554fd';
const ENV = 'cloud1-d4g48z822d1300a77';
/** 模型调用最慢要 20s+，低于这个值的超时一定会被杀 */
const MIN_TIMEOUT_S = 30;

/** 线上已有的 ai-images/input 原图（346KB 人像），前缀取自 ai_image_tasks 里的真实 fileID */
const FILE_ID =
  'cloud://cloud1-d4g48z822d1300a77.636c-cloud1-d4g48z822d1300a77-1512321434/ai-images/input/1792667370143-b0x938f5.jpg';

const PAYLOAD = {
  fileID: FILE_ID,
  demand: '把人拍得亮一点，但别修得太假',
  scope: '人像成片·自然精修：气色更好，保留真实肤质',
  keepHint:
    '严格保持人物身份、五官比例、脸型、表情、发型、身材、姿态、服装与个人皮肤特征不变，不做网红脸',
  engineName: '混元',
};

const fnSource = `function () {
  return (async function () {
    var started = Date.now();
    try {
      var res = await wx.cloud.callFunction({
        name: 'promptAdvisor',
        data: ${JSON.stringify(PAYLOAD)}
      });
      return { elapsed: Date.now() - started, result: res && res.result };
    } catch (err) {
      return { elapsed: Date.now() - started, error: (err && (err.errMsg || err.message)) || String(err) };
    }
  })();
}`;

const mcp = await connect();
try {
  // 0. 先查函数配置。新建的云函数默认超时只有 3s，模型调用必然被杀，
  //    而这一步查不出来就只能看到语焉不详的 -501002，白猜半天。
  const info = deep(
    await mcp.call('cloud_fn_info', { appid: APPID, env: ENV, names: 'promptAdvisor' }, 30000),
  );
  const fn = (info && info.list && info.list[0]) || {};
  console.log(`函数状态: ${fn.status || '?'} · 超时 ${fn.timeout}s · 运行时 ${fn.runtime || '?'}`);
  if (Number(fn.timeout) < MIN_TIMEOUT_S) {
    console.log(
      `⚠️ 超时只有 ${fn.timeout}s，低于 ${MIN_TIMEOUT_S}s。请到「云开发控制台 → 云函数 → promptAdvisor → 配置」把执行超时改成 60s，否则下面的调用一定失败。`,
    );
  }

  const out = deep(
    await mcp.call('automation_evaluate', { project: PROJECT, action: 'evaluate', fnSource }, 120000),
  );
  console.log(JSON.stringify(out, null, 2));

  // automation_evaluate 的返回可能被剥掉一层 result 外壳，也可能直接是返回值本身，
  // 两种都要认——否则会出现「明明 ok:true 却打印顾问不可用」的假阴性。
  const payload = out && typeof out === 'object' && out.ok ? out : out && out.result;
  if (payload && payload.ok) {
    console.log(`\n✅ 顾问可用，实测 ${payload.elapsed}ms，模型 ${payload.model}，${payload.candidates.length} 条候选`);
    payload.candidates.forEach((c) => console.log(`  [${c.label}] ${c.text}`));
  } else {
    console.log('\n❌ 顾问不可用，见上面的 error / result.error');
  }
} finally {
  mcp.close();
}
