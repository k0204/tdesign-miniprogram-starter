/**
 * AI 修图页面「接线」回归：真实 import 页面 index.js，跑 onLoad + 锁定/因素流程
 *
 * 为什么不能只测纯逻辑：上一轮出过 `DIMENSIONS` / `buildMods` 用了没 import 的 bug，
 * 纯逻辑脚本全过，真机一进页面就 ReferenceError。这个脚本把页面模块整体搬到临时目录，
 * 用假的 `Page` / `wx` 跑一遍生命周期和数据流，专门抓「模块导出 / 导入 / this 接线」问题。
 *
 *   node .workbuddy/scripts/verify-aiimage-page.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const here = import.meta.dirname;
const root = path.resolve(here, '../..');
const srcDir = path.join(root, 'pages/aiImage');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aiimage-page-'));

const importToMjs = (text) =>
  text.replace(/from '\.\/([A-Za-z0-9_]+)'/g, "from './$1.mjs'");

function copy(name, to, transform) {
  let text = fs.readFileSync(path.join(srcDir, name), 'utf8');
  text = importToMjs(text);
  if (transform) text = transform(text);
  fs.writeFileSync(path.join(work, to), text, 'utf8');
}

// 配置模块：把 `~/` 别名换成本地 factors.mjs
fs.writeFileSync(
  path.join(work, 'factors.mjs'),
  fs.readFileSync(path.join(root, 'config/prompts/aiImage.factors.js'), 'utf8'),
  'utf8',
);
copy('promptConfig.js', 'promptConfig.mjs', (t) =>
  t.replace("'~/config/prompts/aiImage.factors'", "'./factors.mjs'"),
);
['dimensions.js', 'locks.js', 'promptOptions.js', 'editPresets.js', 'providers.js', 'errors.js', 'advisor.js'].forEach(
  (name) => copy(name, name.replace(/\.js$/, '.mjs')),
);

// 页面本体：useToast behavior 换成 stub（它依赖 TDesign 的全局 Behavior，真实运行由小程序注入）
copy('index.js', 'page.mjs', (t) =>
  t.replace(
    /import useToastBehavior from '~\/behaviors\/useToast';/,
    'const useToastBehavior = { methods: { onShowToast() {}, onHideToast() {} } };',
  ),
);

const store = {};
const calls = [];

globalThis.wx = {
  getSystemInfoSync: () => ({ statusBarHeight: 24 }),
  getStorageSync: (key) => store[key],
  setStorageSync: (key, value) => {
    store[key] = value;
  },
  setClipboardData: ({ success }) => success && success(),
  showLoading: () => {},
  hideLoading: () => {},
  showModal: () => {},
  cloud: {
    // 云端配置下载走失败分支：页面应继续用内置 v7，不阻塞 onLoad
    downloadFile: ({ fail }) => fail && fail({ errMsg: 'mock: no network' }),
  },
};

let definition = null;
globalThis.Page = (def) => {
  definition = def;
};

const pageUrl = pathToFileURL(path.join(work, 'page.mjs')).href;
await import(pageUrl);

const fails = [];
const ok = (cond, msg) => {
  if (!cond) fails.push(msg);
};

ok(definition && typeof definition.onLoad === 'function', '页面没有注册 Page 或缺少 onLoad');

const page = {
  ...definition,
  data: JSON.parse(JSON.stringify(definition.data)),
};
// 小程序运行时会自动把 behaviors 的 methods 合进页面实例，这里手动补上
(definition.behaviors || []).forEach((behavior) => Object.assign(page, (behavior && behavior.methods) || {}));
page.setData = (patch, callback) => {
  Object.assign(page.data, patch);
  if (typeof callback === 'function') callback();
};

try {
  page.onLoad();
  /**
   * 布局契约从「JS 算一屏高度」改成了「CSS flex + navbar 占位」：
   * t-navbar 的 fixed 默认 true、placeholder 默认 false，漏了 placeholder 页面内容
   * 就从 y=0 开始，整块被导航栏盖住（引擎条曾因此「消失」）。
   */
  const wxmlSrc = fs.readFileSync(path.join(root, 'pages/aiImage/index.wxml'), 'utf8');
  ok(/<t-navbar[^>]*\bplaceholder\b/.test(wxmlSrc), 't-navbar 缺 placeholder，内容会被 fixed 导航栏盖住');
  ok(wxmlSrc.includes('range-key="label"') && wxmlSrc.includes('chooseDimensionOption'), '参数选项没有使用下拉选择器');
  ok(!wxmlSrc.includes('class="dim__scroll"') && !wxmlSrc.includes('class="seg-scroll"'), '参数菜单仍包含横向滑动区域');
  ok(wxmlSrc.includes('class="dim__desc"'), '参数没有展示具体说明');
  ok(wxmlSrc.includes('class="shell"'), '缺少 .shell 竖排容器');
  ok(!wxmlSrc.includes('style="{{pageStyle}}"'), 'shell 不应再依赖 pageStyle 内联高度');
  ok(page.data.locks.length === 5, `锁定项应为 5 个，实际 ${page.data.locks.length}`);
  ok(page.data.lockSummary.includes('人物') && page.data.lockSummary.includes('场景'), '默认锁摘要不对');
  ok(page.data.promptPreview.includes('以原图人物为准，延续人物身份'), '默认提示词里没有人物锁');
  ok(page.data.promptPreview.includes('以原图五官为准，延续眼型'), '默认提示词里没有必选五官锁');
  ok(page.data.promptPreview.includes('以原图环境为基础，延续背景'), '默认提示词里没有场景锁');
  const featuresLock = page.data.locks.find((item) => item.id === 'features');
  ok(featuresLock && featuresLock.mandatory && featuresLock.on, '必选五官锁没有展示为开启状态');
  page.toggleLock({ currentTarget: { dataset: { id: 'features' } } });
  ok(page.data.locks.find((item) => item.id === 'features').on, '页面交互关闭了必选五官锁');
  page.openLockEditor({ currentTarget: { dataset: { id: 'features' } } });
  ok(page.data.lockEditorOpen === false, '必选五官锁不应开放文案编辑');
  ok(page.data.promptParts.some((part) => part.key === '锁定'), '指令拆解里没有锁定段');
  ok(page.data.promptParts.every((part) => part.text), '指令拆解里有空段');
  ok(page.data.promptDigits.includes('字'), '指令字数没有算出来');
  ok(page.data.effectRecommendations.length === 11, '推荐效果没有全部进入精简列表');
  ok(page.data.visibleEffectRecommendations.length === 3, '默认只应展示三个常用效果');
  ok(!page.data.paramsExpanded && !page.data.effectsExpanded, '手动参数和完整效果列表默认应收起');
  page.toggleEffects();
  ok(page.data.visibleEffectRecommendations.length === page.data.effectRecommendations.length, '展开后没有显示全部推荐效果');
  page.toggleEffects();
  page.toggleParams();
  ok(page.data.paramsExpanded, '手动微调入口没有展开');
  ok(
    page.data.effectRecommendations.some((item) => item.id === 'skinRefine')
      && page.data.effectRecommendations.some((item) => item.id === 'faceRefine'),
    '皮肤和脸部推荐没有进入列表',
  );
  ok(page.data.effectRecommendations.every((item) => !item.cls.includes('effect--hidden')), '推荐效果列表不应隐藏项目');

  // 关掉场景锁：摘要、提示词、本地偏好三者都要同步
  page.toggleLock({ currentTarget: { dataset: { id: 'scene' } } });
  ok(!page.data.lockSummary.includes('场景'), '关掉场景后摘要仍显示场景');
  ok(!page.data.promptPreview.includes('以原图环境为基础，延续背景'), '关掉场景后提示词仍有场景锁');
  ok(store.aiimage_lock_prefs_v1 && store.aiimage_lock_prefs_v1.on.scene === false, '锁定开关没有持久化');

  // 选一个因素：计数、提示词、分类角标联动
  const fullShotIndex = page.data.dimensions.find((item) => item.key === 'shot').options.findIndex((item) => item.id === 'full');
  page.chooseDimensionOption({ currentTarget: { dataset: { key: 'shot' } }, detail: { value: fullShotIndex } });
  ok(page.data.pickedDigits === '1 项', `已选计数不对: ${page.data.pickedDigits}`);
  ok(page.data.promptPreview.includes('全景，人物全身完整入画'), '选中的因素没有拼进提示词');
  ok(page.data.pickedTags.length === 1, '拆解弹层没有生成已选标签');
  ok(page.data.pickedTags[0].text.includes('景别') && page.data.pickedTags[0].text.includes('全景'), '已选标签内容不对');
  ok(page.data.cats[0].badge === '1', '分类角标没有同步');

  // 推荐效果应一次填入多项，并可继续单独微调
  page.chooseEffectRecommendation({ currentTarget: { dataset: { id: 'cinematic' } } });
  ok(page.data.effectRecommendations.length === 11, `推荐效果数量不对: ${page.data.effectRecommendations.length}`);
  ok(page.data.selectedEffectId === 'cinematic', '推荐效果没有标记选中');
  ok(page.data.effectRecommendations.find((item) => item.id === 'cinematic').cls.includes('--on'), '推荐卡片选中样式没有同步');
  ok(page.data.effectRecommendations.find((item) => item.id === 'cinematic').selected, '推荐效果的选中标记没有同步');
  ok(page.data.visibleEffectRecommendations.some((item) => item.id === 'cinematic'), '收起状态没有保留当前选中的效果');
  ok(page.data.selection.light === 'side' && page.data.selection.grade === 'cinematic', '推荐效果没有填入对应因素');
  ok(page.data.promptPreview.includes('高光偏暖橙、暗部偏青蓝'), '推荐效果的具体调色没有进入提示词');
  page.chooseDimension({ currentTarget: { dataset: { key: 'grade', id: 'cool_clean' } } });
  ok(page.data.selectedEffectId === '', '手动微调后推荐卡片仍显示为原预设');
  ok(page.data.effectRecommendations.every((item) => !item.cls.includes('--on')), '手动微调后仍有推荐卡片选中');
  ok(page.data.selection.light === 'side', '手动微调丢失了推荐配方的其他参数');

  page.chooseEffectRecommendation({ currentTarget: { dataset: { id: 'backlitFill' } } });
  ok(page.data.selection.light === 'back' && page.data.selection.grade === 'clean', '逆光效果没有映射到精简参数');
  ok(page.data.promptPreview.includes('适度补亮面部中间调') && page.data.promptPreview.includes('发丝轮廓光自然清晰'), '逆光效果指令不完整');

  page.chooseEffectRecommendation({ currentTarget: { dataset: { id: 'creamyBokeh' } } });
  ok(page.data.selection.dof === 'shallow' && page.data.selection.light === 'soft', '奶油虚化配方没有填入景深与光线参数');
  page.chooseEffectRecommendation({ currentTarget: { dataset: { id: 'skinRefine' } } });
  ok(page.data.selection.skin === 'blemish', '自然修肤效果没有映射到皮肤优化');
  ok(page.data.promptPreview.includes('痘痘、痘印、斑点与泛红细节'), '自然修肤指令没有进入提示词');

  // 人像优化分类：皮肤和脸部细分项都应能进入最终提示词
  page.chooseCategory({ currentTarget: { dataset: { id: 'portrait' } } });
  ok(page.data.activeCatId === 'portrait' && page.data.dimensions.length === 2, '人像优化应精简为皮肤和脸部两个控制维度');
  page.chooseDimension({ currentTarget: { dataset: { key: 'skin', id: 'tone_balance' } } });
  page.chooseDimension({ currentTarget: { dataset: { key: 'skin', id: 'blemish' } } });
  ok(page.data.promptPreview.includes('痘痘、痘印、斑点与泛红细节'), '皮肤优化细分项没有进入提示词');
  ok(page.data.promptPreview.includes('保留真实肤质'), '简化后的皮肤指令没有保留自然纹理细节');
  page.chooseDimension({ currentTarget: { dataset: { key: 'skin', id: 'tone_match' } } });
  ok(page.data.promptPreview.includes('面部、颈部及画面中可见手臂等露肤区域'), '露肤区域肤色衔接没有进入提示词');
  page.chooseDimension({ currentTarget: { dataset: { key: 'face', id: 'eye_bright' } } });
  ok(page.data.promptPreview.includes('自然提亮眼睛与眼神光'), '脸部优化细分项没有进入提示词');
  page.chooseEffectRecommendation({ currentTarget: { dataset: { id: 'faceRefine' } } });
  ok(page.data.selection.face === 'even_light' && page.data.selection.skin === 'tone_balance', '脸部精修配方没有填入细分参数');
  ok(page.data.promptPreview.includes('柔和校正脸部左右'), '脸部精修没有覆盖面部光影优化');

  // AI 效果推荐要应用对应配方，同时保留用户补充和配方未涉及的参数
  page.chooseDimension({ currentTarget: { dataset: { key: 'shot', id: 'closeup' } } });
  page.setData({
    extra: '保留用户的主体描述',
    adviceAppliedText: '',
    adviceMode: 'effect',
    advice: { candidates: [{ label: '青橙电影', effectId: 'cinematic', text: '依照当前照片压住背景高光并保留脸部层次' }] },
  });
  page.pickAdvice({ currentTarget: { dataset: { index: 0 } } });
  ok(page.data.selectedEffectId === 'cinematic', 'AI 效果推荐没有选中对应配方');
  ok(page.data.effectRecommendations.find((item) => item.id === 'cinematic').selected, 'AI 推荐后效果列表没有同步选中态');
  ok(page.data.selection.grade === 'cinematic' && page.data.selection.shot === 'closeup', 'AI 效果推荐未应用配方或覆盖了其他手动参数');
  ok(page.data.extra.includes('保留用户的主体描述') && page.data.extra.includes('依照当前照片'), 'AI 效果推荐没有保留用户补充或照片微调指令');
  ok(page.data.promptPreview.includes('依照当前照片'), 'AI 效果指令没有更新到最终提示词');

  // 参数推荐只替换上一条 AI 微调指令，不改变因素选择
  const beforeParameterAdvice = JSON.stringify(page.data.selection);
  page.setData({
    adviceMode: 'parameter',
    advice: { candidates: [{ label: '高光微调', text: '轻收背景亮部并保留发丝边缘细节' }] },
  });
  page.pickAdvice({ currentTarget: { dataset: { index: 0 } } });
  ok(JSON.stringify(page.data.selection) === beforeParameterAdvice, '参数推荐意外修改了已选因素');
  ok(page.data.extra.includes('保留用户的主体描述') && page.data.extra.includes('轻收背景亮部'), '参数推荐没有保留用户描述或追加微调提示词');
  ok(!page.data.extra.includes('依照当前照片'), '再次选择参数推荐时没有替换上一条 AI 指令');

  // 效果模式不能把缺失配方 ID 的候选误当作参数提示词应用
  const beforeInvalidEffect = page.data.extra;
  page.setData({
    adviceMode: 'effect',
    adviceError: '',
    advice: { candidates: [{ label: '无配方效果', text: '这条候选没有配方编号' }] },
  });
  page.pickAdvice({ currentTarget: { dataset: { index: 0 } } });
  ok(page.data.extra === beforeInvalidEffect, '缺少配方 ID 的效果候选被追加成普通提示词');
  ok(Boolean(page.data.adviceError), '缺少配方 ID 时没有提示用户');

  // 编辑人物锁：句号要换成逗号，保存后摘要显示「改」
  page.openLockEditor({ currentTarget: { dataset: { id: 'person' } } });
  ok(page.data.lockEditorOpen && page.data.lockEditId === 'person', '锁定文案弹层没有打开');
  const longLockDraft = `${'保留脸上的痣，不要磨皮过度 '.repeat(30)}。保留人物真实特征`;
  page.onLockDraftInput({ detail: { value: longLockDraft } });
  ok(page.data.lockDraftEdited === true, '编辑后 edited 标记没亮');
  page.applyLockDraft();
  ok(page.data.lockEditorOpen === false, '完成后弹层没有关闭');
  ok(page.data.promptPreview.includes('保留脸上的痣，不要磨皮过度'), '自定义锁定文案没有拼进提示词');
  ok(page.data.promptPreview.includes('保留人物真实特征'), '长锁定文案被长度限制或截断');
  ok(!page.data.promptPreview.includes('。保留人物真实特征'), '自定义文案里的句号没有被替换');
  ok(page.data.locks.find((lock) => lock.id === 'person').mark === '改', '自定义文案没有标「改」');
  ok(store.aiimage_lock_prefs_v1.phrases.person.length > 200, '长锁定文案没有完整持久化');

  // 恢复默认
  page.openLockEditor({ currentTarget: { dataset: { id: 'person' } } });
  page.resetLockDraft();
  page.applyLockDraft();
  ok(!page.data.promptPreview.includes('保留脸上的痣'), '恢复默认后自定义文案仍留在提示词里');
  ok(page.data.locks.find((lock) => lock.id === 'person').mark === '', '恢复默认后仍标「改」');

  // 清空因素
  page.resetSelection();
  ok(page.data.pickedDigits === '0 项', '清空因素后计数没有归零');
  ok(page.data.cats[0].badge === '', '清空因素后分类角标没有清掉');
  ok(page.data.pickedTags.length === 0, '清空因素后拆解标签没有清掉');

  // 冲突提示：远景人物占比小，人物锁开着，应出现橙色提示
  page.chooseDimension({ currentTarget: { dataset: { key: 'shot', id: 'env' } } });
  ok(page.data.lockTip.includes('人物占比'), '环境人像没有触发人物锁冲突提示');
  ok(page.data.lockTipCls.includes('--warn'), '冲突提示没有用警示样式');

  // 弹层互斥：打开写提示词会关闭锁定编辑
  page.openLockEditor({ currentTarget: { dataset: { id: 'scene' } } });
  page.openPromptInput();
  ok(page.data.lockEditorOpen === false, '打开写提示词时锁定弹层没有关闭');
  const longDraft = '详细修图要求 '.repeat(120);
  page.onDraftInput({ detail: { value: longDraft } });
  page.applyDraft();
  ok(page.data.extra === longDraft.trim() && page.data.extra.length > 600, '自由提示词被长度限制或截断');
  ok(!page.data.promptDigits.includes('超长'), '自由提示词仍被前端标记为超长');
  const textareaTags = [...wxmlSrc.matchAll(/<textarea\b[^>]*>/g)].map((match) => match[0]);
  ok(
    textareaTags.length === 2 && textareaTags.every((tag) => /\bmaxlength="-1"/.test(tag)),
    '自由提示词和锁定文案输入框都必须明确设置为不限长',
  );
  page.closePromptInput();

  // 页面源码里的导出名必须真的存在（防止 import 了不存在的名字）
  const source = fs.readFileSync(path.join(srcDir, 'index.js'), 'utf8');
  const importedNames = [];
  const importRe = /import\s*\{([\s\S]*?)\}\s*from\s*'\.\/([A-Za-z0-9_]+)'/g;
  let match;
  while ((match = importRe.exec(source))) {
    const from = match[2];
    match[1]
      .split(',')
      .map((s) => s.trim().split(/\s+as\s+/)[0])
      .filter(Boolean)
      .forEach((name) => importedNames.push({ from, name }));
  }
  const modules = {
    editPresets: await import(pathToFileURL(path.join(work, 'editPresets.mjs')).href),
    locks: await import(pathToFileURL(path.join(work, 'locks.mjs')).href),
    providers: await import(pathToFileURL(path.join(work, 'providers.mjs')).href),
    errors: await import(pathToFileURL(path.join(work, 'errors.mjs')).href),
    advisor: await import(pathToFileURL(path.join(work, 'advisor.mjs')).href),
  };
  importedNames.forEach(({ from, name }) => {
    ok(modules[from] && modules[from][name] !== undefined, `页面 import 了 ${from} 不存在的导出 ${name}`);
  });
  const mediaReadError = modules.errors.toFriendlyError(
    'Media URL could not be downloaded (timeout or source server error). (request id: test-123)',
  );
  ok(
    mediaReadError.text === 'AI 暂时无法读取原图，请重新选图或稍后重试',
    'Agnes 原图链接读取失败被误报成了生成超时',
  );
  ok(mediaReadError.retryable, '原图链接读取失败应允许重试');
  calls.push(`import 校验 ${importedNames.length} 项`);
} catch (err) {
  fails.push(`页面流程抛错: ${err && err.stack ? err.stack : err}`);
}

try {
  fs.rmSync(work, { recursive: true, force: true });
} catch (err) {
  // 临时目录删不掉不影响结果
}

calls.forEach((line) => console.log(line));
console.log(fails.length ? `❌ ${fails.length} 项失败:\n${fails.join('\n')}` : '✅ 页面接线与锁定流程全部通过');
process.exit(fails.length ? 1 : 0);
