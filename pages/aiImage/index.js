// pages/aiImage/index.js —— AI 修图（选照片 → 选类型 → 选效果 → 生成）
import useToastBehavior from '~/behaviors/useToast';
import {
  buildDimViews,
  buildEditPrompt,
  buildElements,
  countPicked,
  defaultSelection,
  describeSelection,
  describePromptSource,
  findCategory,
  getCategories,
  getCopy,
  getLockConfig,
  getOrder,
  getPromptVersion,
  loadPromptConfig,
  selectionKey,
  EFFECT_RECOMMENDATIONS,
  applyEffectRecommendation,
} from './editPresets';
import {
  LOCK_PHRASE_MAX,
  buildLockText,
  buildLockViews,
  describeLocks,
  detectLockTip,
  getLockDefaultPhrase,
  lockKey,
  normalizeLockState,
  readLockState,
  sanitizeLockText,
  saveLockState,
  setLockPhrase,
  toggleLockState,
} from './locks';
import {
  ENGINES,
  findEngine,
  pickExactSize,
  pickAgnesRatio,
  referenceHint,
  outputLabel,
  buildPayload,
  slotLabel,
} from './providers';
import { toFriendlyError } from './errors';
import {
  buildAdviceKey,
  readCachedAdvice,
  cacheAdvice,
  clearAdviceCache,
  requestAdvice,
} from './advisor';

/**
 * 垫图大小上限。模型侧规定最多 10MB，这里留 0.5MB 余量提前拦截，
 * 免得白传一次再拿到模型侧语焉不详的报错。不做任何客户端压缩，原图直传。
 */
const MAX_SOURCE_BYTES = 9.5 * 1024 * 1024;

const randomName = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

Page({
  behaviors: [useToastBehavior],

  data: {
    // 引擎（混元 / Agnes）。两者的差异全部收在 providers.js 里
    engines: ENGINES,
    engineId: ENGINES[0].id,
    engine: ENGINES[0],

    // 素材列表：混元最多 1 张，Agnes 最多 4 张（第 1 张是主图，其余是参考图）
    images: [], // [{ path, fileID, width, height }]
    // 以下三个由 images 派生，只为预览区与按钮状态服务
    sourcePath: '',
    sourceFileID: '',
    imageCount: 0,
    canAddImage: false,
    sourceSize: '1024x1024', // 混元用的精确尺寸，按主图比例算
    ratio: '1:1', // Agnes 用的比例档，按主图比例吸附
    outputLabel: '1024x1024',
    uploading: false,

    // 因素分类。初始为空，onLoad 里从提示词配置取（配置可能已热更新到云端版本）
    cats: [],
    activeCatId: '',
    activeCat: null,
    /** 当前分类下的因素维度，带 selected 标记，供 wxml 直接渲染 */
    dimensions: [],
    effectRecommendations: [],
    selectedEffectId: '',
    /** 各因素默认只显示常用项，用户可单独展开需要精调的因素。 */
    expandedDims: {},
    /**
     * 全部因素的选择：{ shot:'full', angle:'auto', lightDir:'right', ... }
     * 跨分类保留，切 tab 不清空——用户改了取景再改影调，取景不该丢。
     */
    selection: {},
    /** 当前分类/全部已选的因素数量，文案在 JS 侧拼好 */
    pickedDigits: '0 项',
    hasPicked: false,
    promptPreview: '',
    /** 拼装后是否超过当前引擎的字数上限，交给模板标红，不在这里截断 */
    promptTooLong: false,
    /** 折叠条右侧的字数文案，在 JS 侧算好——模板里不拼字符串 */
    promptDigits: '待生成',
    /** 拆解弹层顶部的已选因素标签，让用户先看到「选了哪些」再看长句 */
    pickedTags: [],
    /** 拆解弹层的几段 */
    promptParts: [],
    /** 所有因素都留着「不指定」——用来提示「这样也能直接生成」 */
    nonePicked: true,
    /** 提示词配置的版本与来源（内置 / 本地缓存 / 云端），显示在拆解弹层底部 */
    promptNote: '',

    // 锁定不换（默认锁人物 + 场景，防止 AI 顺着提示词把人和背景一起重画）
    locks: [],
    lockTitle: '锁定不换',
    lockHeaderIcon: 'lock-on',
    lockHeaderColor: '#0052d9',
    lockSummary: '',
    lockHint: '',
    /** 锁与已选因素冲突时的橙色提示；空字符串表示不显示 */
    lockTip: '',
    lockTipCls: 'locks__tip',
    /** 锁定文案编辑弹层 */
    lockEditorOpen: false,
    lockEditId: '',
    lockEditName: '',
    lockDraft: '',
    lockDraftDigits: '',
    lockDraftDefault: '',
    lockDraftEdited: false,
    lockPhraseMax: LOCK_PHRASE_MAX,
    /** 锁定默认只显示保护摘要，需要修改时再展开。 */
    locksExpanded: false,
    /** 指令拆解弹层底部那句提示，随有没有锁变化 */
    promptFoot: '',

    extra: '',
    /** 底部摘要条右侧的字数 */
    extraDigits: '',
    /** 自己写提示词的弹层 */
    promptInputOpen: false,
    /** 弹层里的草稿：输入时不重算提示词，点「完成」才落到 extra */
    promptDraft: '',
    draftDigits: '',
    /** 弹层跟随键盘上移，原生 textarea 的 adjust-position 推不动 fixed 弹层 */
    inputSheetStyle: '',
    pageStyle: '', // 一屏高度 = 100vh - 导航栏，由 onLoad 算
    stageView: 'src', // 预览区看原图还是结果
    promptOpen: false, // 指令拆解弹层，默认收起

    // 提示词顾问（DeepSeek 图片理解，看原图给建议）
    adviceOpen: false,
    advising: false,
    advice: null, // { analysis, candidates: [{ label, text }] }
    adviceError: '',
    adviceFromCache: false,
    generating: false,
    resultSrc: '',
    resultFileID: '',
    resultUrl: '',
    error: '',
    /** 出错了能不能直接重试（决定错误条上是否显示「重试」） */
    errorRetryable: false,
  },

  /* ---------------- 生命周期 ---------------- */

  /** 一屏布局：内容区高度 = 视口 - 自定义导航栏（状态栏 + 44px） */
  onLoad() {
    // 轮询期间用来判断用户是否还在这页，离开就停
    this.alive = true;
    const sys = wx.getSystemInfoSync();
    const navHeight = (sys.statusBarHeight || 20) + 44;

    // 先用「当前生效配置」渲染（内置默认，或上次下载缓存下来的版本），不等网络
    const selection = defaultSelection();
    const cats = this.decorateCategories(getCategories(), selection);
    const catId = (cats[0] && cats[0].id) || '';

    // 锁定偏好存在本地：用户改过的文案、开关状态，比配置更「属于这个人」
    this.lockState = readLockState();

    this.setData({
      pageStyle: `height: calc(100vh - ${navHeight}px)`,
      cats,
      effectRecommendations: this.decorateEffectRecommendations(''),
      activeCatId: catId,
      activeCat: findCategory(catId),
      selection,
      dimensions: buildDimViews(catId, selection, {}),
      promptNote: describePromptSource(),
      locks: buildLockViews(this.lockState),
      lockTitle: (getLockConfig() || {}).title || '锁定不换',
      lockSummary: this.buildLockSummary(),
      lockHint: (getLockConfig() || {}).hint || '',
    });
    this.refreshPreview();

    // 再异步问云端有没有新版本。热更新只是锦上添花，失败/超时都不打断使用
    this.syncPromptConfig();
  },

  /**
   * 给分类挂上「已选 N 项」角标。
   * 文案在 JS 侧算好，模板里不做判断（wx:for 内的判断在当前基础库不可靠）。
   */
  decorateCategories(cats, selection) {
    return (cats || []).map((cat) => {
      const picked = countPicked(cat.id, selection);
      return {
        ...cat,
        badge: picked ? `${picked}` : '',
      };
    });
  },

  decorateEffectRecommendations(selectedId) {
    return EFFECT_RECOMMENDATIONS.map((item) => ({
      ...item,
      selected: item.id === selectedId,
      cls: item.id === selectedId ? 'effect effect--on' : 'effect',
    }));
  },

  /** 「已锁 人物、场景」；一个都没锁时给一句风险提示 */
  buildLockSummary() {
    const names = describeLocks(this.lockState);
    return names ? `已锁 ${names}` : '都没锁';
  },

  /**
   * 拉取云端提示词配置。版本变了就重建菜单。
   *
   * 刻意不重置 selection：用户可能已经选到一半，云端这时候到了不该把他打回默认。
   * 旧选择里已经被删掉的维度，buildElements 按 order 遍历时压根不会看它，
   * 所以配置结构升级也不会拼出脏提示词。
   */
  syncPromptConfig() {
    loadPromptConfig()
      .then((res) => {
        if (!this.alive || !res || !res.changed) return;
        // 配置升级可能新增/删除锁定项：按 id 对齐，用户改过的文案保留
        this.lockState = normalizeLockState(this.lockState);
        const cats = getCategories();
        const exists = cats.some((item) => item.id === this.data.activeCatId);
        const catId = exists ? this.data.activeCatId : (cats[0] && cats[0].id) || '';
        this.setData({
          cats: this.decorateCategories(cats, this.data.selection),
          activeCatId: catId,
          activeCat: findCategory(catId),
          dimensions: buildDimViews(catId, this.data.selection, this.data.expandedDims),
          promptNote: describePromptSource(),
          locks: buildLockViews(this.lockState),
          lockTitle: (getLockConfig() || {}).title || '锁定不换',
          lockSummary: this.buildLockSummary(),
          lockHint: (getLockConfig() || {}).hint || '',
        });
        this.refreshPreview();
        console.log('[aiImage] 提示词已更新至', getPromptVersion());
      })
      .catch((err) => {
        console.warn('[aiImage] 提示词配置加载异常', err);
      });
  },

  onUnload() {
    this.alive = false;
  },

  /* ---------------- 引擎 ---------------- */

  /**
   * 切引擎。素材按新引擎的容量截断——混元只能吃 1 张，从 Agnes 切回来
   * 必须丢掉参考图，静默丢掉会让用户以为图还在，所以显式提示。
   *
   * engine 显式透传给 applyImages：setData 的 callback 是下一帧才跑的，
   * 派生字段（输出规格、可加图状态）必须在同一次同步流程里算完，
   * 否则 UI 会晚一帧、外部读到的也是旧值。
   */
  chooseEngine(e) {
    if (this.data.generating || this.data.uploading) return;
    const { id } = e.currentTarget.dataset;
    if (!id || id === this.data.engineId) return;
    const engine = findEngine(id);
    if (!engine) return;

    const { images } = this.data;
    const kept = images.slice(0, engine.maxImages);
    const dropped = images.length - kept.length;

    this.setData({ engineId: engine.id, engine, error: '' });
    this.applyImages(kept, {
      engine,
      // 素材没变，只是换引擎，上一轮结果仍然有效，不用清
      keepResult: true,
      error: dropped > 0 ? `已切到${engine.name}，只保留前 ${engine.maxImages} 张图` : '',
    });
  },

  /* ---------------- 原图 ---------------- */

  chooseImage() {
    if (this.data.uploading || this.data.generating) return;
    const { engine, images } = this.data;
    let room = engine.maxImages - images.length;
    if (room <= 0) {
      if (engine.maxImages > 1) {
        this.setData({ error: `最多 ${engine.maxImages} 张图片，先删掉一张再加` });
        return;
      }
      // 单图引擎上的「更换」就等同于重选：清空旧图再开选择器，不做二次确认
      this.applyImages([]);
      room = 1;
    }

    wx.chooseMedia({
      count: room,
      mediaType: ['image'],
      // 取原图，不做任何缩放或二次编码，保留完整画质交给模型
      sizeType: ['original'],
      sourceType: ['album', 'camera'],
      success: async (res) => {
        const files = (res.tempFiles || []).filter(Boolean);
        if (files.length) await this.addFiles(files);
      },
      fail: (err) => {
        const msg = (err && err.errMsg) || '';
        if (msg.includes('cancel')) return; // 用户自己取消，不提示
        console.error('[aiImage] 选择图片失败（原始错误）', err);
        this.showHint('没能打开相册，请检查相册权限后重试');
      },
    });
  },

  /**
   * 逐张读宽高 + 上传云存储。
   * 逐张处理而不是 Promise.all：单张失败不该把已经传好的几张一起丢掉，
   * 而且串行上传对弱网更友好。
   */
  async addFiles(files) {
    const { engine } = this.data;
    const room = Math.max(0, engine.maxImages - this.data.images.length);
    const batch = files.slice(0, room);
    if (!batch.length) return;

    this.setData({ uploading: true, error: '' });
    const added = [];
    let failure = '';

    for (let i = 0; i < batch.length; i += 1) {
      const file = batch[i];
      if (typeof file.size === 'number' && file.size > MAX_SOURCE_BYTES) {
        failure = failure || '有图片超过 10MB，请先压缩后再试';
        continue;
      }
      try {
        const info = await this.readImageInfo(file.tempFilePath);
        const fileID = await this.uploadToCloud(file.tempFilePath);
        added.push({
          path: file.tempFilePath,
          fileID,
          width: info.width || 0,
          height: info.height || 0,
        });
      } catch (err) {
        console.error('[aiImage] 图片导入失败（原始错误）', {
          index: i,
          path: file.tempFilePath,
          err,
        });
        failure = failure || (err && (err.errMsg || err.message)) || '上传失败';
      }
    }

    const next = this.data.images.concat(added).slice(0, engine.maxImages);
    this.setData({ uploading: false });
    // 素材错误文案本身就能看懂，只需要去掉 errMsg 里的技术噪音
    const hint = failure
      ? `有图片没导入成功（${toFriendlyError(failure).text}）`
      : '';
    this.applyImages(next, { error: hint });
  },

  /** 读本地图片宽高；读不到就返回空对象，由尺寸计算兜底成 1:1 */
  readImageInfo(src) {
    return new Promise((resolve) => {
      wx.getImageInfo({
        src,
        success: (info) => resolve({ width: info.width, height: info.height }),
        fail: () => resolve({}),
      });
    });
  },

  /** 上传云存储，云函数侧用 getTempFileURL 换成公网链接喂给模型 */
  uploadToCloud(filePath) {
    if (!wx.cloud) {
      return Promise.reject(new Error('当前环境不支持云开发，请检查基础库版本'));
    }
    const matched = /\.([a-zA-Z0-9]+)$/.exec(filePath);
    const raw = matched ? matched[1].toLowerCase() : 'jpg';
    const suffix = ['jpg', 'jpeg', 'png', 'webp'].includes(raw) ? raw : 'jpg';
    return wx.cloud
      .uploadFile({
        cloudPath: `ai-images/input/${randomName()}.${suffix}`,
        filePath,
      })
      .then((res) => res.fileID);
  },

  /**
   * 素材列表的唯一写入口：一次 setData 算完所有派生字段 + 清掉上一轮结果。
   * 尺寸只按「主图」算——参考图的比例不参与出图规格，否则会被参考图带偏。
   *
   * options.engine 允许调用方在同一次同步流程里换了引擎时显式指定，
   * 不必等 setData 回调（回调是下一帧）。
   */
  applyImages(images, options = {}) {
    const { engine: engineArg, keepResult = false, error = '' } = options;
    const engine = engineArg || this.data.engine;
    const list = (images || []).slice(0, engine.maxImages);
    const main = list[0];
    const hasSize = main && main.width && main.height;

    let size = '1024x1024';
    let ratio = '1:1';
    if (hasSize) {
      // 尺寸算法由引擎自己定：混元用 pickExactSize（8 倍数 / 面积 ≤1024²），
      // Nexus 用 pickNexusSize（gpt-image-2 官方规则：16 倍数 + 长短边 ≤3:1）
      const pick = engine.pickSize || pickExactSize;
      size = pick(main.width, main.height);
      ratio = pickAgnesRatio(main.width, main.height);
    }

    const patch = {
      // 角标（主图 / 参考 N）在 JS 侧算好，模板里只做取值：
      // WXML 的 `index === 0` 在这套基础库上不会走真分支，别把判断放在模板里
      images: list.map((item, i) => ({ ...item, label: slotLabel(engine, i), isMain: i === 0 })),
      sourcePath: main ? main.path : '',
      sourceFileID: main ? main.fileID : '',
      imageCount: list.length,
      canAddImage: list.length < engine.maxImages,
      sourceSize: size,
      ratio,
      outputLabel: outputLabel(engine, { size, ratio }),
      error,
      errorRetryable: false,
    };

    // 换了素材，上一轮结果失去意义，预览回到原图
    if (!keepResult) {
      Object.assign(patch, {
        resultSrc: '',
        resultFileID: '',
        resultUrl: '',
        stageView: 'src',
      });
    }

    // 主图换了 → 上一轮的 AI 建议跟着失效。不清的话用户会在新图上看到旧图的诊断，
    // 点一下就把「调整左脸阴影」这种只对旧图成立的指令写到新图上。
    const nextFileID = main ? main.fileID : '';
    if (nextFileID !== this.data.sourceFileID) {
      Object.assign(patch, {
        advice: null,
        adviceOpen: false,
        adviceError: '',
        adviceFromCache: false,
      });
      clearAdviceCache(this.data.sourceFileID);
    }

    // setData 会同步更新 this.data，所以紧接着重算提示词即可，
    // 不要放进 callback——那样指令区会晚一帧，多图/单图切换时看到的是旧文案
    this.setData(patch);
    this.refreshPreview();
  },

  removeImageAt(e) {
    if (this.data.generating || this.data.uploading) return;
    const index = Number(e.currentTarget.dataset.index);
    if (!Number.isInteger(index) || index < 0) return;
    const next = this.data.images.slice();
    next.splice(index, 1);
    this.applyImages(next);
  },

  removeImage() {
    if (this.data.generating || this.data.uploading) return;
    this.applyImages([]);
  },

  /** 点缩略图放大看这一张（多图时用来确认自己选的是哪几张） */
  previewSlot(e) {
    const { images } = this.data;
    const index = Number(e.currentTarget.dataset.index);
    if (!images.length || !Number.isInteger(index) || index < 0) return;
    const urls = images.map((item) => item.path);
    wx.previewImage({ current: urls[index], urls });
  },

  /* ---------------- 因素分类与取值 ---------------- */

  /** 切分类只换「显示哪组维度」，不动 selection——跨分类的选择要一直保留 */
  chooseCategory(e) {
    if (this.data.generating) return;
    const { id } = e.currentTarget.dataset;
    if (!id || id === this.data.activeCatId) return;
    const cat = findCategory(id);
    if (!cat) return;
    this.setData({
      activeCatId: id,
      activeCat: cat,
      dimensions: buildDimViews(id, this.data.selection, this.data.expandedDims),
      error: '',
    });
  },

  /**
   * 点一个因素取值。单选，点已选中的那个回到「不指定」。
   *
   * 允许点回不指定（而不像旧的修图维度那样禁止清空）：因素本来就是「想改什么就选什么」，
   * 全部留空也算一种合法状态——按原图原样生成，只是重新出图，不改任何要素。
   */
  chooseDimension(e) {
    if (this.data.generating) return;
    const { key, id } = e.currentTarget.dataset;
    if (!key || !id) return;

    const selection = { ...this.data.selection };
    selection[key] = selection[key] === id ? 'auto' : id;

    const catId = this.data.activeCatId;
    this.setData({
      selection,
      selectedEffectId: '',
      effectRecommendations: this.decorateEffectRecommendations(''),
      dimensions: buildDimViews(catId, selection, this.data.expandedDims),
      cats: this.decorateCategories(this.data.cats, selection),
      error: '',
    });
    this.refreshPreview();
  },

  /** 先套用完整效果配方，再通过下方因素逐项微调。 */
  chooseEffectRecommendation(e) {
    if (this.data.generating) return;
    const { id } = e.currentTarget.dataset;
    const selection = applyEffectRecommendation(id);
    if (!selection) return;
    const catId = this.data.activeCatId;
    this.setData({
      selection,
      selectedEffectId: id,
      effectRecommendations: this.decorateEffectRecommendations(id),
      dimensions: buildDimViews(catId, selection, this.data.expandedDims),
      cats: this.decorateCategories(this.data.cats, selection),
      error: '',
    });
    this.refreshPreview();
  },

  /** 清空全部因素（回到「不指定」），锁不受影响——它们是两层独立的意图 */
  resetSelection() {
    if (this.data.generating) return;
    const selection = defaultSelection();
    const catId = this.data.activeCatId;
    this.setData({
      selection,
      selectedEffectId: '',
      effectRecommendations: this.decorateEffectRecommendations(''),
      dimensions: buildDimViews(catId, selection, this.data.expandedDims),
      cats: this.decorateCategories(this.data.cats, selection),
      error: '',
    });
    this.refreshPreview();
    this.onShowToast('#t-toast', '已清空因素');
  },

  /** 在常用项和完整列表之间切换，每个因素独立记录展开状态。 */
  toggleDimensionOptions(e) {
    if (this.data.generating) return;
    const { key } = e.currentTarget.dataset;
    if (!key) return;
    const expandedDims = {
      ...this.data.expandedDims,
      [key]: !this.data.expandedDims[key],
    };
    this.setData({
      expandedDims,
      dimensions: buildDimViews(this.data.activeCatId, this.data.selection, expandedDims),
    });
  },

  /* ---------------- 锁定不换 ---------------- */

  toggleLocksPanel() {
    this.setData({ locksExpanded: !this.data.locksExpanded });
  },

  /** 统一的渲染出口：视图、摘要、本地偏好一次算完 */
  renderLocks(save) {
    if (save) saveLockState(this.lockState);
    this.setData({
      locks: buildLockViews(this.lockState),
      lockSummary: this.buildLockSummary(),
    });
  },

  toggleLock(e) {
    if (this.data.generating) return;
    const { id } = e.currentTarget.dataset;
    if (!id) return;
    this.lockState = toggleLockState(this.lockState, id);
    this.renderLocks(true);
    this.refreshPreview();
  },

  /**
   * 编辑一条锁定文案。
   * 开关和编辑是两个独立动作：锁关掉也能改文案，下次打开就直接用。
   */
  openLockEditor(e) {
    if (this.data.generating) return;
    const { id } = e.currentTarget.dataset;
    const item = (this.data.locks || []).find((lock) => lock.id === id);
    if (!item) return;

    const fallback = item.defaultPhrase || getLockDefaultPhrase(item.id);
    const draft = item.phrase || fallback;
    this.setData({
      lockEditorOpen: true,
      lockEditId: item.id,
      lockEditName: item.name,
      lockDraft: draft,
      lockDraftDefault: fallback,
      lockDraftDigits: `${draft.length} 字`,
      lockDraftEdited: item.edited,
      // 三个弹层互斥，别叠在一起
      promptInputOpen: false,
      promptOpen: false,
      adviceOpen: false,
      inputSheetStyle: '',
    });
  },

  closeLockEditor() {
    this.setData({ lockEditorOpen: false, inputSheetStyle: '' });
  },

  onLockDraftInput(e) {
    const value = (e.detail && e.detail.value) || '';
    this.setData({
      lockDraft: value,
      lockDraftDigits: `${value.length} 字`,
      // 用清洗后的值比较：只多敲了句号/空格不算改过
      lockDraftEdited: sanitizeLockText(value) !== sanitizeLockText(this.data.lockDraftDefault),
    });
  },

  resetLockDraft() {
    const text = this.data.lockDraftDefault || '';
    this.setData({
      lockDraft: text,
      lockDraftDigits: `${text.length} 字`,
      lockDraftEdited: false,
    });
  },

  applyLockDraft() {
    const text = sanitizeLockText(this.data.lockDraft);
    if (!text) {
      this.showHint('锁定文案不能为空，可以点「恢复默认」');
      return;
    }
    this.lockState = setLockPhrase(this.lockState, this.data.lockEditId, text);
    this.renderLocks(true);
    this.setData({ lockEditorOpen: false, inputSheetStyle: '' });
    this.refreshPreview();
  },

  /* ---------------- 自己写提示词 ---------------- */

  /**
   * 打开输入弹层。
   * 输入框不是「补充一句」的附件，它就是自由提示词入口：
   * 用户完全可以一个因素都不选、在这里写完整描述，然后直接生成。
   */
  openPromptInput() {
    if (this.data.generating) return;
    const draft = this.data.extra || '';
    this.setData({
      promptInputOpen: true,
      promptDraft: draft,
      draftDigits: `${draft.length} 字`,
      // 两个弹层互斥，别叠在一起
      adviceOpen: false,
      promptOpen: false,
      lockEditorOpen: false,
      inputSheetStyle: '',
    });
  },

  closePromptInput() {
    this.setData({ promptInputOpen: false, inputSheetStyle: '' });
  },

  /** 草稿只在弹层内部维护，输入过程中不重算提示词（每敲一个字都重拼会很卡） */
  onDraftInput(e) {
    const value = (e.detail && e.detail.value) || '';
    this.setData({ promptDraft: value, draftDigits: `${value.length} 字` });
  },

  /** 键盘弹起时把弹层顶上去：弹层是 mask 里的 flex 尾项，靠 mask 的 padding-bottom 抬起来 */
  onInputKeyboard(e) {
    const height = (e.detail && e.detail.height) || 0;
    this.setData({ inputSheetStyle: height ? `padding-bottom: ${height}px;` : '' });
  },

  clearDraft() {
    this.setData({ promptDraft: '', draftDigits: '0 字' });
  },

  /** 落盘：只有点完成才写进 extra，取消则原样保留上一次的内容 */
  applyDraft() {
    const extra = String(this.data.promptDraft || '').trim();
    this.setData({
      extra,
      promptInputOpen: false,
      inputSheetStyle: '',
      error: '',
    });
    this.refreshPreview();
  },

  refreshPreview() {
    const { selection, extra, engineId, imageCount, engine } = this.data;
    const userText = String(extra || '').trim();
    const elements = buildElements(selection);
    const reference = referenceHint(engineId, imageCount);
    // 锁定文案由 locks.js 统一收口：开关、用户改过的文案、配置默认值都在那里合并
    const lockText = buildLockText(this.lockState);
    const prompt = buildEditPrompt({ selection, extra: userText, reference, lockText });
    // 超长只标红，不静默截断——截断会让用户以为自己写的都生效了
    const tooLong = !!prompt && prompt.length > engine.maxPromptLength;
    // 固定文案可能被云端配置换掉，所以每次实时取，不缓存
    const copy = getCopy() || {};
    // 一个都没选是完全合法的状态：不选＝不给指令，只按原图和模型判断出片
    // 只认当前 order 里的维度：热更新可能删掉过某些维度，selection 里会留着失效的 key，
    // 直接按 Object.keys 数会把它们算进「已选」，导致零选择时提示不出现
    const pickedCount = getOrder().filter((key) => selection[key] && selection[key] !== 'auto').length;
    const selectionText = describeSelection(selection);
    const lockedNames = describeLocks(this.lockState);
    const lockTip = detectLockTip(selection, this.lockState);

    this.setData({
      promptPreview: prompt,
      promptTooLong: tooLong,
      promptDigits: prompt ? `${prompt.length} 字${tooLong ? ' · 超长' : ''}` : '待生成',
      pickedDigits: `${pickedCount} 项`,
      hasPicked: pickedCount > 0,
      nonePicked: pickedCount === 0,
      pickedTags: selectionText
        ? selectionText.split(' · ').map((text, index) => ({ key: `p${index}`, text }))
        : [],
      extraDigits: userText ? `${userText.length} 字` : '',
      lockSummary: lockedNames ? `已锁 ${lockedNames}` : '都没锁',
      lockHeaderIcon: lockedNames ? 'lock-on' : 'lock-off',
      lockHeaderColor: lockedNames ? '#0052d9' : 'rgba(0,0,0,0.32)',
      lockTip,
      lockTipCls: lockTip ? 'locks__tip locks__tip--warn' : 'locks__tip',
      promptFoot: lockText
        ? '锁定的内容写进提示词最后，AI 只改没锁的部分'
        : '没有锁定人物和场景，AI 可能把整张图重画',
      promptParts: [
        { key: '意图', text: copy.lead },
        { key: '要素', text: elements || '一个都没选，不额外加任何指令' },
        { key: '你写的', text: userText },
        { key: '参考', text: reference },
        { key: '锁定', text: lockText },
        { key: '质量', text: copy.tail },
      ].filter((item) => item.text),
    });
  },

  /** 复制本次指令，方便贴到别处复用 */
  copyPrompt() {
    const { promptPreview } = this.data;
    if (!promptPreview) return;
    wx.setClipboardData({
      data: promptPreview,
      success: () => this.onShowToast('#t-toast', '指令已复制'),
    });
  },

  /* ---------------- 错误处理 ---------------- */

  /**
   * 后端/网络错误统一出口。
   * 用户只看到人话（errors.js 负责翻译），原始错误完整打到控制台，
   * 带上任务号、耗时和当前引擎，方便对着控制台复现。
   */
  showBackendError(err, meta = {}) {
    const raw = (err && (err.errMsg || err.message)) || String(err || '');
    const { text, retryable } = toFriendlyError(raw);

    console.error('[aiImage] 生成失败（原始错误）', {
      raw,
      friendly: text,
      retryable,
      taskId: (err && err.taskId) || meta.taskId || '',
      engine: this.data.engineId,
      imageCount: this.data.imageCount,
      elapsedMs: (err && err.elapsed) || meta.elapsed || 0,
      error: err,
    });

    // 用户已经离开页面就别再往一个销毁的页面写状态
    if (!this.alive) return;
    this.setData({ error: text, errorRetryable: retryable });
  },

  /** 校验类提示（本身就是人话），清掉重试标记 */
  showHint(text) {
    this.setData({ error: text, errorRetryable: false });
  },

  /** 错误条上的「重试」：直接再跑一次同样的生成 */
  retryGenerate() {
    if (this.data.generating || this.data.uploading) return;
    this.setData({ error: '', errorRetryable: false });
    this.generate();
  },

  /* ---------------- 生成 ---------------- */

  async generate() {
    const { engine, images, uploading, generating, sourceSize, ratio } = this.data;
    if (generating) return;

    if (uploading) {
      this.showHint('图片还在上传，稍等一下');
      return;
    }
    if (!images.length) {
      this.showHint('请先选择一张图片');
      return;
    }
    if (images.some((item) => !item.fileID)) {
      this.showHint('有图片没上传成功，重新选一下');
      return;
    }
    if (engine.minImages && images.length < engine.minImages) {
      this.showHint(`当前引擎至少要 ${engine.minImages} 张图片`);
      return;
    }

    const prompt = this.data.promptPreview;
    if (!prompt) {
      this.showHint('提示词为空，请重新选择');
      return;
    }
    // 两个引擎的字数上限不同（混元 500 / Agnes 2000），按当前引擎卡
    if (prompt.length > engine.maxPromptLength) {
      this.showHint(
        `补充描述太长（${prompt.length} 字，上限 ${engine.maxPromptLength} 字），请精简一点`
      );
      return;
    }

    this.setData({ generating: true, error: '', errorRetryable: false });
    wx.showLoading({ title: engine.loadingTitle, mask: true });

    const payload = buildPayload(engine, { prompt, images, size: sourceSize, ratio });
    let succeeded = false;
    let elapsed = 0;

    try {
      // 混元 30s 同步等得回来；Agnes 图生图 85-96s，必须走提交 + 轮询
      const result = engine.asyncTask
        ? await this.runAsyncTask(engine, payload)
        : await this.runSyncTask(engine, payload);

      elapsed = result.elapsed || 0;
      this.setData({
        resultFileID: result.fileID || '',
        resultUrl: result.url || '',
        resultSrc: result.fileID || result.url || '',
        stageView: 'out', // 出图后默认看结果
      });
      succeeded = true;
      if (!result.fileID) {
        // 出图了但没转存成功：图能看，链接会过期，单独提示
        console.warn('[aiImage] 结果未转存云存储，仅有临时链接', result);
        this.showHint('图片已生成但没能保存，链接会过期，请尽快存到相册');
      }
    } catch (err) {
      this.showBackendError(err, { elapsed });
    } finally {
      wx.hideLoading();
      this.setData({ generating: false });
      if (succeeded) {
        const seconds = Math.round(elapsed / 1000);
        this.onShowToast('#t-toast', seconds ? `完成 · ${seconds}s` : '处理完成');
      }
    }
  },

  /** 同步模式：一次 callFunction 拿到图（耗时必须 < 60s，见 providers.js 说明） */
  async runSyncTask(engine, payload) {
    const res = await wx.cloud.callFunction({ name: engine.cloudFn, data: payload });
    const result = (res && res.result) || {};
    if (!result.ok) {
      console.warn('[aiImage] 云函数返回失败', { fn: engine.cloudFn, result });
      throw new Error(result.error || '生成失败');
    }
    // 出图但没转存成功：仍然返回结果，由调用方统一提示链接会过期
    if (!result.url) throw new Error('模型没有返回图片，请稍后重试');
    return result;
  },

  /**
   * 异步模式：提交拿 taskId → 轮询数据库。
   *
   * 为什么不直接等：`wx.cloud.callFunction` 有 60s 客户端硬上限，
   * `app.json` 的 networkTimeout 对它无效，Agnes 图生图 85-96s 必然被掐断。
   * 提交接口本身 < 1s 返回，之后每次查询也很轻，整条链路都在 60s 以内。
   */
  async runAsyncTask(engine, payload) {
    if (!wx.cloud) throw new Error('当前小程序版本不支持云开发，请升级微信后重试');

    const submitted = await wx.cloud.callFunction({
      name: engine.cloudFn,
      data: { ...payload, action: 'submit' },
    });
    const s = (submitted && submitted.result) || {};
    if (!s.ok) {
      console.warn('[aiImage] 任务提交失败', s);
      throw new Error(s.error || '任务提交失败，请重试');
    }
    const { taskId } = s;
    if (!taskId) throw new Error('任务提交失败：没拿到任务号');

    /** 抛错时带上任务号，控制台里可以直接拿它去查库/看日志 */
    const fail = (message, extra = {}) => {
      const err = new Error(message);
      err.taskId = taskId;
      if (extra.elapsed) err.elapsed = extra.elapsed;
      return err;
    };

    const startedAt = Date.now();
    const interval = Math.max(1000, Number(engine.pollIntervalMs) || 3000);
    const deadline = startedAt + (Number(engine.maxWaitMs) || 210000);
    let networkErrors = 0;

    while (Date.now() < deadline) {
      await sleep(interval);
      // 已经离开页面就不再轮询，避免用户切走后还在烧调用
      if (!this.alive) throw fail('已离开页面，生成已取消');

      wx.showLoading({
        title: `生成中 ${Math.round((Date.now() - startedAt) / 1000)}s`,
        mask: true,
      });

      let checked = null;
      try {
        const res = await wx.cloud.callFunction({
          name: engine.cloudFn,
          data: { action: 'status', taskId },
        });
        checked = (res && res.result) || null;
      } catch (err) {
        // 单次查询抖动不算任务失败，连续 3 次才认定网络有问题
        networkErrors += 1;
        console.warn(`[aiImage] 轮询失败第 ${networkErrors} 次（任务 ${taskId}）`, err);
        if (networkErrors >= 3) throw fail((err && (err.errMsg || err.message)) || '网络异常');
        continue;
      }
      networkErrors = 0;

      if (!checked) continue;
      if (!checked.ok) throw fail(checked.error || '任务查询失败');
      if (checked.status === 'done') return checked;
      if (checked.status === 'failed') {
        console.warn('[aiImage] 任务执行失败', { taskId, ...checked });
        // 带上 worker 侧的真实耗时，控制台里能一眼看出是「排了很久」还是「秒失败」
        throw fail(checked.error || '生成失败', { elapsed: checked.elapsed });
      }
      // 派发异常 + 60s 还停在 queued（没进 running），才认定任务真的没起来。
      // worker 一旦跑起来会立刻把状态改成 running，所以这两个条件不会误杀长任务。
      if (
        checked.dispatchError &&
        checked.status === 'queued' &&
        Date.now() - startedAt > 60000
      ) {
        throw fail(checked.dispatchError);
      }
      // queued / running 继续等
    }

    throw fail(`生成超时（已等 ${Math.round((Date.now() - startedAt) / 1000)} 秒）`);
  },

  /* ---------------- 预览区 ---------------- */

  /** 原图 / 对比 / 结果 三态切换 */
  switchView(e) {
    const view = e.currentTarget.dataset.view;
    if (!view || view === this.data.stageView) return;
    this.setData({ stageView: view });
  },

  /** 点某张图：没图就去选图，有图就放大看（对比态可指定看哪张） */
  tapStage(e) {
    if (!this.data.sourcePath) {
      this.chooseImage();
      return;
    }
    this.previewCurrent(e);
  },

  /**
   * 预览大图：传事件时读 data-view，传字符串时按视图名。
   * 两张都塞进 urls，预览层里可以左右滑动对比。
   */
  previewCurrent(e) {
    const { stageView, resultSrc, sourcePath } = this.data;
    const fromEvent = e && e.currentTarget ? e.currentTarget.dataset.view : e;
    const want = typeof fromEvent === 'string' && fromEvent ? fromEvent : stageView;
    const current = want === 'src' ? sourcePath : resultSrc || sourcePath;
    const urls = [sourcePath, resultSrc].filter(Boolean);
    if (!current) return;
    wx.previewImage({ current, urls });
  },

  async saveToAlbum() {
    const { resultFileID, resultUrl } = this.data;
    if (!resultFileID && !resultUrl) return;
    try {
      let filePath = '';
      if (resultFileID) {
        filePath = (await wx.cloud.downloadFile({ fileID: resultFileID })).tempFilePath;
      } else {
        filePath = (await wx.downloadFile({ url: resultUrl })).tempFilePath;
      }
      await wx.saveImageToPhotosAlbum({ filePath });
      this.onShowToast('#t-toast', '已保存到相册');
    } catch (err) {
      const msg = (err && err.errMsg) || '';
      console.error('[aiImage] 保存到相册失败（原始错误）', { resultFileID, err });
      if (msg.includes('auth deny') || msg.includes('authorize')) {
        wx.showModal({
          title: '需要相册权限',
          content: '请在设置中允许「保存到相册」后再试',
          confirmText: '去设置',
          success: (r) => r.confirm && wx.openSetting(),
        });
        return;
      }
      if (msg.includes('cancel')) return;
      this.showHint('保存没成功，检查一下相册权限再试');
    }
  },

  /**
   * 把结果作为新的原图，可以接着改。
   * 只留结果这一张：继续修图时旧的参考图已经和画面无关了，留着只会干扰模型。
   */
  useAsSource() {
    const { resultSrc, resultFileID } = this.data;
    if (!resultSrc) return;
    // 结果的宽高读不到，沿用上一轮的主图规格，避免尺寸被重置成 1:1
    const size = this.data.sourceSize;
    const ratio = this.data.ratio;
    this.applyImages([{ path: resultSrc, fileID: resultFileID || '', width: 0, height: 0 }]);
    this.setData({ sourceSize: size, ratio, outputLabel: outputLabel(this.data.engine, { size, ratio }) });
    if (!resultFileID) {
      this.setData({ error: '结果未能保存到云存储，无法继续修改，请重新选择图片' });
    }
  },

  /* ---------------- 提示词顾问（DeepSeek 图片理解） ---------------- */

  /**
   * 打开建议弹层。
   *
   * 前置要求是「已经选好图 + 已经选好效果」：没选效果时模型不知道往哪个方向改，
   * 只会给出一堆《提升整体质感》这种泛泛之谈，比现成的模板还差。
   */
  openAdvice() {
    if (this.data.generating || this.data.uploading) return;
    const { sourceFileID } = this.data;

    if (!sourceFileID) {
      this.showHint('请先选择一张图片');
      return;
    }

    // 两个弹层互斥，别叠在一起
    this.setData({
      adviceOpen: true,
      promptOpen: false,
      promptInputOpen: false,
      lockEditorOpen: false,
      inputSheetStyle: '',
    });
    if (!this.data.advice) this.runAdvice(false);
  },

  /** 允许中途关掉：请求还会跑完并写进缓存，下次打开直接命中 */
  closeAdvice() {
    if (this.data.adviceOpen) this.setData({ adviceOpen: false });
  },

  /** 换一批：绕过缓存重跑一次 */
  refreshAdvice() {
    if (this.data.advising) return;
    this.runAdvice(true);
  },

  /**
   * 真正发起顾问请求。
   * force=false 时先查本地缓存——同一张图 + 同一个效果 + 同一句需求，
   * 视觉模型的答案不会变，重复调用纯属浪费。
   */
  async runAdvice(force) {
    if (this.data.advising) return;
    const { sourceFileID, selection, extra, engine } = this.data;
    if (!sourceFileID) return;

    const demand = String(extra || '').trim();
    const lockedNames = describeLocks(this.lockState);
    const key = buildAdviceKey({
      fileID: sourceFileID,
      // 因素菜单没有「功能」概念了，用当前分类当作用域标识，避免缓存混到别的分类上
      capId: this.data.activeCatId,
      // 锁变了，AI 建议的边界也变了，不该复用旧候选
      optionId: `${selectionKey(selection)}|${lockKey(this.lockState)}`,
      demand,
    });

    if (!force) {
      const cached = readCachedAdvice(key);
      if (cached) {
        this.setData({
          advice: cached,
          adviceFromCache: true,
          adviceError: '',
          advising: false,
        });
        return;
      }
    }

    this.setData({ advising: true, adviceError: '', advice: null, adviceFromCache: false });

    try {
      const advice = await requestAdvice({
        fileID: sourceFileID,
        demand,
        // scope 决定「这份建议服务于哪种处理」，模型据此判断该往哪个方向改
        scope: `已选因素：${describeSelection(selection) || '未指定'}；锁定：${lockedNames || '无'}`,
        // 边界只喂给模型（别建议换脸、换场景），不要求它复述
        keepHint: buildLockText(this.lockState),
        engineName: engine.name,
      });
      cacheAdvice(key, advice);
      if (!this.alive) return;
      this.setData({ advice, advising: false });
    } catch (err) {
      console.error('[aiImage] AI 建议失败（原始错误）', {
        raw: (err && (err.errMsg || err.message)) || String(err),
        key,
        err,
      });
      if (!this.alive) return;
      this.setData({ advising: false, adviceError: this.describeAdviceError(err) });
    }
  },

  /** 云函数返回的业务文案本身就是人话，只有网络层错误才需要翻译 */
  describeAdviceError(err) {
    if (err && err.fromServer) return err.message || '';
    const raw = (err && (err.errMsg || err.message)) || String(err || '');
    return toFriendlyError(raw).text || 'AI 没能给出建议，稍后再试';
  },

  /**
   * 点一条候选 → 写进「补充要求」。
   * 只覆盖 extra 这一格：锚点、保留、约束行仍由 buildPrompt 拼装，
   * 这样建议再活跃也动不了「保持不变」这条硬约束。
   */
  pickAdvice(e) {
    const index = Number(e.currentTarget.dataset.index);
    const list = (this.data.advice && this.data.advice.candidates) || [];
    const item = list[index];
    if (!item) return;

    // setData 是同步更新 this.data 的，但 callback 在下一帧 ——
    // 所以 refreshPreview 必须紧跟着 setData 调，不能塞进 callback
    this.setData({ extra: item.text, adviceOpen: false });
    this.refreshPreview();
  },

  /* ---------------- 指令弹层 ---------------- */

  openPrompt() {
    if (!this.data.promptPreview) return;
    this.setData({
      promptOpen: true,
      adviceOpen: false,
      promptInputOpen: false,
      lockEditorOpen: false,
      inputSheetStyle: '',
    });
  },

  closePrompt() {
    if (this.data.promptOpen) this.setData({ promptOpen: false });
  },

  /** 弹层内部点击不冒泡到遮罩 */
  noop() {},
});
