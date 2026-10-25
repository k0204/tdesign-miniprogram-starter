// pages/aiImage/index.js —— AI 修图（选照片 → 选类型 → 选效果 → 生成）
import useToastBehavior from '~/behaviors/useToast';
import {
  CAPABILITIES,
  findCapability,
  findOption,
  buildEditPrompt,
  ANCHOR_PHOTO,
  CONSTRAINT_TAIL,
} from './editPresets';
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

    // 能力与选项
    caps: CAPABILITIES,
    activeCapId: CAPABILITIES[0].id,
    activeCap: CAPABILITIES[0],
    optionsView: [], // 带 selected 标记，供 wxml 直接渲染
    picked: [], // 单选效果 id；保留数组形态以兼容模板的长度判断
    promptPreview: '',
    promptParts: [], // 四段拆解，供界面展示

    extra: '',
    pageStyle: '', // 一屏高度 = 100vh - 导航栏，由 onLoad 算
    stageView: 'src', // 预览区看原图还是结果
    promptOpen: false, // 指令拆解弹层，默认收起
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
    this.setData({
      pageStyle: `height: calc(100vh - ${navHeight}px)`,
      optionsView: CAPABILITIES[0].options.map((item) => ({ ...item, selected: false })),
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

  /* ---------------- 能力与选项 ---------------- */

  chooseCap(e) {
    if (this.data.generating) return;
    const { id } = e.currentTarget.dataset;
    if (!id || id === this.data.activeCapId) return;
    const cap = findCapability(id);
    if (!cap) return;
    // 每个效果都是一套完整方案。切换类型时清空旧效果，防止风格互相冲突。
    this.setData({
      activeCapId: id,
      activeCap: cap,
      optionsView: cap.options.map((item) => ({ ...item, selected: false })),
      picked: [],
      promptPreview: '',
      promptParts: [],
      error: '',
    });
  },

  toggleOption(e) {
    if (this.data.generating) return;
    const { id } = e.currentTarget.dataset;
    if (!id) return;
    const found = findOption(id);
    if (!found || found.capability.id !== this.data.activeCapId) return;
    const picked = this.data.picked[0] === id ? [] : [id];
    this.setData({
      picked,
      optionsView: this.data.activeCap.options.map((item) => ({
        ...item,
        selected: picked[0] === item.id,
      })),
      error: '',
    });
    this.refreshPreview(picked);
  },

  /** 底部单行输入（原生 input） */
  onExtraInput(e) {
    const extra = (e.detail && e.detail.value) || '';
    this.setData({ extra }, () => this.refreshPreview());
  },

  refreshPreview(pickedArg) {
    const picked = pickedArg || this.data.picked;
    const { extra, engineId, imageCount } = this.data;

    const found = picked[0] ? findOption(picked[0]) : null;
    const userText = String(extra || '').trim();
    if (!found) {
      this.setData({ promptPreview: '', promptParts: [] });
      return;
    }
    const { capability, option } = found;
    const reference = referenceHint(engineId, imageCount);
    const mods = [option.prompt, userText].filter(Boolean).join('。');

    this.setData({
      promptPreview: buildEditPrompt({ option, capability, extra: userText, reference }),
      promptParts: [
        { key: '基础', text: ANCHOR_PHOTO },
        { key: '改动', text: mods },
        { key: '参考', text: reference },
        { key: '保留', text: capability.keepHint },
        { key: '质量', text: CONSTRAINT_TAIL },
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
    const {
      engine,
      images,
      uploading,
      generating,
      activeCap,
      picked,
      sourceSize,
      ratio,
    } = this.data;
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
    if (!activeCap) {
      this.showHint('请先选择要使用的功能');
      return;
    }
    if (!picked.length) {
      this.showHint(`请在「${activeCap.name}」里选择一种效果`);
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

  /* ---------------- 指令弹层 ---------------- */

  openPrompt() {
    if (!this.data.promptPreview) return;
    this.setData({ promptOpen: true });
  },

  closePrompt() {
    if (this.data.promptOpen) this.setData({ promptOpen: false });
  },

  /** 弹层内部点击不冒泡到遮罩 */
  noop() {},
});
