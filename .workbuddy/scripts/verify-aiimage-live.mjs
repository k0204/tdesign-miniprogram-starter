/**
 * AI 修图页面的模拟器走查：打开 IDE 项目 → 进页面 → 操作锁定/因素/弹层 → 截图
 *
 *   node .workbuddy/scripts/verify-aiimage-live.mjs
 *
 * 依赖微信开发者工具处于登录态；截图写到 .workbuddy/out/，便于人工复核视觉。
 * 交互统一走页面方法（automation_evaluate），不走元素 tap：
 * 弹层打开时 tap 遮罩会让 automator 通道超时并连带关掉项目窗口（实测）。
 */
import path from 'node:path';
import { connect } from './wechat-mcp.mjs';

const PROJECT = path.resolve(import.meta.dirname, '../..');
const OUT = path.join(PROJECT, '.workbuddy/out');

const mcp = await connect();

/** automation_evaluate 的返回可能带 result 外壳，也可能直接是值 */
function unwrap(value) {
  let v = value;
  for (let i = 0; i < 4; i += 1) {
    if (typeof v === 'string') {
      const text = v.trim();
      if (!text) return text;
      try {
        v = JSON.parse(text);
        continue;
      } catch (err) {
        return text;
      }
    }
    if (v && typeof v === 'object' && 'result' in v) {
      v = v.result;
      continue;
    }
    return v;
  }
  return v;
}

const evaluate = async (body) => {
  const raw = await mcp.call(
    'automation_evaluate',
    { project: PROJECT, action: 'evaluate', fnSource: `function(){${body}}` },
    120000,
  );
  return unwrap(raw);
};

const shot = async (name, wait = 0.8) => {
  const file = path.join(OUT, name);
  const res = await mcp.call('simulator_screenshot', { project: PROJECT, path: file, wait, optimize: false }, 60000);
  return unwrap(res);
};

const status = unwrap(await mcp.call('check_wechatide_status', {}, 30000));
console.log('IDE 登录态:', status && status.loginExpired ? '已过期' : '正常', status && status.loginUser && status.loginUser.nickName);

const fails = [];
const ok = (cond, msg) => {
  if (!cond) fails.push(msg);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 截图工具可能切回首页或让页面实例失效，所以每次操作前检查路由和页面方法。
 * 页面实例失效时 reLaunch 会重置选择；后续走查步骤不依赖之前的选择。
 */
async function ensurePage() {
  let info = null;
  try {
    info = await evaluate(`
    var pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
    var p = pages.length ? pages[pages.length - 1] : null;
    return JSON.stringify({
      route: (p && (p.route || p.__route__)) || '',
      ready: Boolean(p && typeof p.closePrompt === 'function' && typeof p.toggleLock === 'function')
    });
  `);
  } catch (err) {
    info = null;
  }
  if (info && info.route === 'pages/aiImage/index' && info.ready) return;
  await mcp.call('open_project_window', { project: PROJECT, windowMode: 'liteMode' }, 240000);
  await mcp.call('automation_navigate', { project: PROJECT, action: 'reLaunch', url: '/pages/aiImage/index', wait: 2.5 }, 90000);
  await sleep(1500);
}

try {
  await mcp.call('open_project_window', { project: PROJECT, windowMode: 'liteMode' }, 240000);
  // 测试前清掉本地锁定偏好：否则上一次走查留下的开关会让默认态断言失效
  await evaluate(`wx.removeStorageSync('aiimage_lock_prefs_v1'); return 'cleared';`);
  await mcp.call('automation_navigate', { project: PROJECT, action: 'reLaunch', url: '/pages/aiImage/index', wait: 3 }, 90000);

  const initial = await evaluate(`
    var p = getCurrentPages().pop();
    if (!p) return JSON.stringify({ ok: false, error: 'no page' });
    var d = p.data;
    return JSON.stringify({
      ok: true,
      route: p.route || p.__route__ || '',
      version: d.promptNote,
      lockTitle: d.lockTitle,
      lockSummary: d.lockSummary,
      lockTip: d.lockTip,
      locks: (d.locks || []).map(function (x) {
        return { id: x.id, name: x.name, on: x.on, mandatory: x.mandatory, edited: x.edited, icon: x.icon, hasMark: x.hasMark };
      }),
      promptDigits: d.promptDigits,
      promptPreview: d.promptPreview,
      promptParts: (d.promptParts || []).map(function (x) { return x.key; }),
      cats: (d.cats || []).map(function (x) { return { id: x.id, name: x.name, badge: x.badge }; }),
      dims: (d.dimensions || []).map(function (x) { return x.key; }),
      dimOptions: (d.dimensions || []).map(function (x) {
        return { key: x.key, labels: (x.options || []).map(function (o) { return o.label; }) };
      }),
      visibleEffects: (d.visibleEffectRecommendations || []).length,
      paramsExpanded: d.paramsExpanded,
      pickedDigits: d.pickedDigits,
      hasPicked: d.hasPicked
    });
  `);
  console.log('初始页面:', JSON.stringify(initial));
  ok(initial && initial.ok, '页面没有加载');
  ok(initial && initial.route === 'pages/aiImage/index', `当前页面不是 AI 修图: ${initial && initial.route}`);
  ok(initial && initial.version === '提示词 v23 · 内置', `提示词版本不对: ${initial && initial.version}`);
  ok(initial && initial.locks.length === 5, `锁定项数量不对: ${initial && initial.locks.length}`);
  ok(initial && initial.locks.filter((x) => x.on).length === 3, '默认应锁人物、五官和场景');
  ok(initial && initial.locks.some((x) => x.id === 'features' && x.on && x.mandatory), '五官锁不是必选状态');
  ok(initial && initial.lockSummary.includes('人物') && initial.lockSummary.includes('场景'), '默认锁定摘要不对');
  ok(initial && initial.dims.length === 2 && initial.cats.length === 3, '分类或取景维度数量不对');
  ok(initial && initial.visibleEffects === 3 && initial.paramsExpanded === false, '修图菜单默认展开项过多');
  const dofView = initial && initial.dimOptions && initial.dimOptions.find((x) => x.key === 'dof');
  ok(dofView && dofView.labels.indexOf('背景虚化') !== -1, '景深里没有「背景虚化」');
  ok(initial && initial.promptPreview.includes('以原图人物为准，延续人物身份'), '提示词里没有人物锁');
  ok(initial && initial.promptPreview.includes('以原图环境为基础，延续背景'), '提示词里没有场景锁');
  console.log('截图 1:', JSON.stringify(await shot('aiImage-locks.png', 1)));

  const parameterMenu = await evaluate(`
    var p = getCurrentPages().pop();
    p.toggleParams();
    p.chooseCategory({ currentTarget: { dataset: { id: 'portrait' } } });
    var skin = (p.data.dimensions || []).find(function (x) { return x.key === 'skin'; });
    var blemishIndex = skin.options.findIndex(function (x) { return x.id === 'blemish'; });
    p.chooseDimensionOption({ currentTarget: { dataset: { key: 'skin' } }, detail: { value: blemishIndex } });
    var d = p.data;
    return JSON.stringify({
      paramsExpanded: d.paramsExpanded,
      categoryCount: d.cats.length,
      selectedSkin: d.selection.skin,
      preview: d.promptPreview,
      dimensions: (d.dimensions || []).map(function (x) {
        return { key: x.key, name: x.name, value: x.pickedLabel, description: x.pickedDesc };
      })
    });
  `);
  console.log('手动微调:', JSON.stringify(parameterMenu));
  ok(parameterMenu && parameterMenu.paramsExpanded, '手动微调没有展开');
  ok(parameterMenu && parameterMenu.dimensions.every((item) => item.name && item.description), '参数缺少名称或具体说明');
  ok(parameterMenu && parameterMenu.selectedSkin === 'blemish', '下拉选择没有更新皮肤操作');
  ok(parameterMenu && parameterMenu.preview.includes('痘痘、痘印、斑点与泛红细节'), '下拉选择没有更新提示词');
  console.log('参数区截图:', JSON.stringify(await shot('aiImage-parameters.png', 0.6)));
  await ensurePage();

  const toneOptions = await evaluate(`
    var p = getCurrentPages().pop();
    p.chooseCategory({ currentTarget: { dataset: { id: 'tone' } } });
    var grade = null;
    (p.data.dimensions || []).forEach(function (x) { if (x.key === 'grade') grade = x; });
    return JSON.stringify({
      route: p.route || p.__route__ || '',
      labels: grade ? grade.options.map(function (o) { return o.label; }) : []
    });
  `);
  console.log('后期选项:', JSON.stringify(toneOptions));
  ok(toneOptions && toneOptions.labels.indexOf('日系清爽') !== -1, '后期里没有「日系清爽」');
  ok(toneOptions && toneOptions.labels.indexOf('冷调清透') !== -1, '后期里没有「冷调清透」');
  ok(toneOptions && toneOptions.labels.indexOf('低饱和胶片') !== -1, '后期里没有「低饱和胶片」');
  ok(toneOptions && toneOptions.labels.indexOf('黑白银盐') !== -1, '后期里没有「黑白银盐」');

  const afterPick = await evaluate(`
    var p = getCurrentPages().pop();
    p.toggleLock({ currentTarget: { dataset: { id: 'scene' } } });
    p.chooseDimension({ currentTarget: { dataset: { key: 'shot', id: 'full' } } });
    p.chooseDimension({ currentTarget: { dataset: { key: 'dof', id: 'shallow' } } });
    p.chooseDimension({ currentTarget: { dataset: { key: 'light', id: 'side' } } });
    p.chooseDimension({ currentTarget: { dataset: { key: 'grade', id: 'cool_clean' } } });
    var d = p.data;
    return JSON.stringify({
      route: p.route || p.__route__ || '',
      lockSummary: d.lockSummary,
      locks: (d.locks || []).map(function (x) { return { id: x.id, on: x.on }; }),
      pickedDigits: d.pickedDigits,
      pickedTags: d.pickedTags,
      promptDigits: d.promptDigits,
      promptPreview: d.promptPreview,
      promptParts: (d.promptParts || []).map(function (x) { return x.key; }),
      lockHeaderIcon: d.lockHeaderIcon
    });
  `);
  console.log('选因素后:', JSON.stringify(afterPick));
  ok(afterPick && afterPick.route === 'pages/aiImage/index', '选因素后页面被切走');
  ok(afterPick && afterPick.lockSummary === '已锁 人物、五官', `关场景锁失败: ${afterPick && afterPick.lockSummary}`);
  ok(afterPick && afterPick.pickedDigits === '4 项', `已选计数不对: ${afterPick && afterPick.pickedDigits}`);
  ok(afterPick && afterPick.pickedTags.length === 4, '拆解标签数量不对');
  ok(afterPick && afterPick.promptPreview.includes('背景按远近自然渐进虚化'), '背景虚化没有拼进提示词');
  ok(afterPick && afterPick.promptPreview.includes('冷调清透'), '冷调清透没有拼进提示词');
  ok(afterPick && !afterPick.promptPreview.includes('以原图环境为基础，延续背景'), '关场景锁后提示词仍有场景锁');
  console.log('截图 2:', JSON.stringify(await shot('aiImage-selected.png', 0.6)));

  await ensurePage();
  const editor = await evaluate(`
    var p = getCurrentPages().pop();
    p.openLockEditor({ currentTarget: { dataset: { id: 'person' } } });
    var d = p.data;
    return JSON.stringify({
      route: p.route || p.__route__ || '',
      open: d.lockEditorOpen,
      name: d.lockEditName,
      draft: d.lockDraft,
      digits: d.lockDraftDigits,
      edited: d.lockDraftEdited
    });
  `);
  console.log('锁定编辑:', JSON.stringify(editor));
  ok(editor && editor.open === true && editor.name === '人物', '锁定编辑弹层没有打开');
  console.log('截图 3:', JSON.stringify(await shot('aiImage-lock-editor.png', 0.6)));

  await ensurePage();
  const promptSheet = await evaluate(`
    var p = getCurrentPages().pop();
    p.chooseDimension({ currentTarget: { dataset: { key: 'shot', id: 'full' } } });
    p.chooseDimension({ currentTarget: { dataset: { key: 'dof', id: 'shallow' } } });
    p.chooseDimension({ currentTarget: { dataset: { key: 'light', id: 'side' } } });
    p.chooseDimension({ currentTarget: { dataset: { key: 'grade', id: 'cool_clean' } } });
    p.openPrompt();
    var d = p.data;
    return JSON.stringify({
      route: p.route || p.__route__ || '',
      open: d.promptOpen,
      tags: d.pickedTags,
      parts: (d.promptParts || []).map(function (x) { return { key: x.key, len: x.text.length }; }),
      foot: d.promptFoot
    });
  `);
  console.log('指令弹层:', JSON.stringify(promptSheet));
  ok(promptSheet && promptSheet.open === true, '指令拆解弹层没有打开');
  ok(promptSheet && Array.isArray(promptSheet.tags) && promptSheet.tags.length === 4, '指令弹层没有已选标签');
  ok(
    promptSheet && Array.isArray(promptSheet.parts) && promptSheet.parts.every((x) => x.len > 0),
    '指令弹层有空段',
  );
  console.log('截图 4:', JSON.stringify(await shot('aiImage-prompt.png', 0.6)));

  // 收尾：恢复默认状态，别把模拟器的本地偏好留成测试值
  await ensurePage();
  const cleaned = await evaluate(`
    var p = getCurrentPages().pop();
    p.closePrompt();
    if (p.lockState && p.lockState.on && !p.lockState.on.scene) {
      p.toggleLock({ currentTarget: { dataset: { id: 'scene' } } });
    }
    p.resetSelection();
    var d = p.data;
    return JSON.stringify({ route: p.route || p.__route__, lockSummary: d.lockSummary, pickedDigits: d.pickedDigits });
  `);
  console.log('收尾:', JSON.stringify(cleaned));
  ok(cleaned && cleaned.lockSummary === '已锁 人物、五官、场景', `收尾没有恢复默认锁: ${cleaned && cleaned.lockSummary}`);
  ok(cleaned && cleaned.pickedDigits === '0 项', `收尾没有清空因素: ${cleaned && cleaned.pickedDigits}`);

  const consoleLog = await mcp.call(
    'get_simulator_console',
    { project: PROJECT, command: 'grep -n -i -E "error|exception|fail|not a function"' },
    60000,
  );
  console.log('控制台错误:', JSON.stringify(unwrap(consoleLog)).slice(0, 1000));
} catch (err) {
  fails.push(`模拟器走查抛错: ${err && (err.stack || err.message || err)}`);
} finally {
  mcp.close();
}

console.log(fails.length ? `❌ ${fails.length} 项失败:\n${fails.join('\n')}` : '✅ 模拟器走查全部通过');
process.exit(fails.length ? 1 : 0);
