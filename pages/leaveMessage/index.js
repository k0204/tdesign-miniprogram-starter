// pages/leaveMessage/index.js —— 留言板（文字 + 图片）
import useToastBehavior from '~/behaviors/useToast';
import cipher from '../../utils/cipher';

const CLOUD_FN = 'leaveMessage';
const COLLECTION = 'leave_messages';
const MAX_CONTENT = 500;
const MAX_IMAGES = 3;
const PAGE_SIZE = 10;
const NICKNAME_KEY = 'board_nickname';
const DEFAULT_NICKNAME = '微信用户';

/**
 * 实时刷新：优先云开发数据库 watch（别人一发就推过来），
 * 同时保留增量轮询兜底 —— 集合权限默认是「仅创建者可读写」，
 * 这种情况下 watch 只会推自己的文档，别人发的收不到，只能靠轮询补。
 */
const SYNC_INTERVAL = 12000;
const WATCH_LIMIT = 20;
/** 页面滚动超过这个距离就「攒着」新留言，不把用户正在看的内容顶走 */
const SCROLL_HOLD = 300;
/** 「N 条新留言」浮条离底部的距离：输入区高度 + 安全区，有图时再抬高一档 */
const NEW_TIP_BOTTOM = 104;
const NEW_TIP_BOTTOM_PICKING = 164;

/**
 * 离开多久回来必须重新上锁（毫秒）。
 *
 * 页面 onHide 已经会上锁，这个阈值是给「onHide 被选图豁免 / onAppHide 迟到」
 * 之类漏网场景兜底用的：回到前台先看离开时长，超了就补锁，
 * **绝不能锁完还往下走刷新**——那正是「锁屏不隐藏、打开才刷一下」的根因。
 */
const RELOCK_AFTER_HIDE = 1000;
/** 选图/拍照回来后的豁免窗口：complete 和 onShow 的先后顺序各机型不一样，两头都认 */
const PICK_GRACE = 1500;

/** 打开留言板的 4 位口令：直接输在输入框里，发送时先校验；校验在云函数做（口令不放前端） */
const PIN_PATTERN = /^\d{4}$/;

const pad2 = (n) => (n < 10 ? `0${n}` : `${n}`);
const randomName = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const yearMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}`;
};

/** 从本地临时路径取小写后缀，拿不到就按 jpg 存 */
function pickSuffix(path = '') {
  const matched = /\.([a-zA-Z0-9]+)(?:[?#].*)?$/.exec(String(path));
  const suffix = matched ? matched[1].toLowerCase() : '';
  return ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(suffix) ? suffix : 'jpg';
}

/**
 * 相对时间：一天内说「几分钟前」，跨天给具体日期。
 * 不引入 dayjs，这里只要四种形态，自己算更省体积。
 */
function formatTime(ms) {
  if (!ms) return '';
  const now = Date.now();
  const diff = now - ms;
  // 服务端和客户端有一点点时钟偏差，未来时间按「刚刚」处理，别显示「-1 分钟前」
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / (60 * 1000))} 分钟前`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / (60 * 60 * 1000))} 小时前`;

  const d = new Date(ms);
  const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (d.getFullYear() === new Date().getFullYear()) {
    return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${clock}`;
  }
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${clock}`;
}

/** 头像没有图，用昵称首字符兜底，比统一的灰色小人好认 */
function firstChar(nickname) {
  const chars = Array.from(String(nickname || DEFAULT_NICKNAME));
  return chars[0] || '微';
}

/**
 * 列表项统一在这里加工：模板里只做渲染，不写任何逻辑。
 * 布尔的派生字段（single）必须在这一层算好——`wx:for` 里做数值比较
 * （如 `{{item.images.length === 1}}`）在当前基础库上恒走假分支。
 *
 * 内容和昵称在库里是密文，这里顺手解密；没有 key 或认证失败会拿到空串，
 * 内容位置就给一句「解密失败」占位，不要静默显示成空白。
 */
function decorate(raw = {}, key) {
  const content = decodeText(key, raw.content);
  const nickname = decodeText(key, raw.nickname) || DEFAULT_NICKNAME;
  const images = Array.isArray(raw.images) ? raw.images : [];
  const encrypted = cipher.isCipher(raw.content) || cipher.isCipher(raw.nickname);
  return {
    id: raw.id,
    content: !content && encrypted ? '［解密失败］' : content,
    images,
    single: images.length === 1,
    nickname,
    nicknameChar: firstChar(nickname),
    createdAt: Number(raw.createdAt) || 0,
    timeText: formatTime(raw.createdAt),
    mine: Boolean(raw.mine),
  };
}

/** 密文解密；历史明文（没有 v1. 前缀）原样返回 */
function decodeText(key, value) {
  const text = String(value == null ? '' : value);
  if (!text) return '';
  if (!cipher.isCipher(text)) return text;
  return cipher.decrypt(key, text);
}

/**
 * 合并增量消息：按 id 去重后整体按时间倒序。
 * 直接用 unshift 会有两个问题——分页拉到的重复项、watch 推送自己刚发的那条。
 */
function mergeMessages(incoming, base) {
  if (!incoming.length) return base;
  const seen = new Set(base.map((item) => item.id));
  const fresh = incoming.filter((item) => !seen.has(item.id));
  if (!fresh.length) return base;
  return fresh.concat(base).sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * 「有新留言」浮条文案：带上是谁发的。
 * 多条时只报最新那位 + 总数（list 已按时间倒序，[0] 就是最新）。
 */
function buildNewTip(list) {
  const latest = list && list[0];
  if (!latest) return '';
  if (list.length === 1) return `${latest.nickname} 发了新留言`;
  return `${latest.nickname} 等 ${list.length} 条新留言`;
}

/**
 * 错误翻译：用户只看人话，原始错误一律 console.error 打出来。
 * 云函数已经把「码农话」翻过一遍了，这里只兜客户端侧的失败（网络、上传、权限）。
 */
function toFriendlyError(err) {
  const raw = String((err && (err.errMsg || err.message)) || err || '');
  if (/timeout|timedout|超时/i.test(raw)) return '网络有点慢，请稍后重试';
  if (/callFunction:fail|function.*not.*found|FunctionName/i.test(raw)) return '留言服务还没部署好，请稍后再试';
  if (/uploadFile:fail|uploadFile:fail.*network/i.test(raw)) return '图片上传失败，请检查网络后重试';
  if (/request:fail|network|ERR_INTERNET/i.test(raw)) return '网络连接失败，请检查网络';
  if (/-501002|resource server timeout/i.test(raw)) return '服务响应超时，请稍后重试';
  return raw || '操作失败，请稍后重试';
}

Page({
  behaviors: [useToastBehavior],

  data: {
    messages: [],
    loading: true,
    loadingMore: false,
    hasMore: true,
    error: '',
    /** 用户在看下面内容时攒下来的、别人发的新留言 + 浮条文案 */
    pendingNew: [],
    newCount: 0,
    newTipText: '',

    draft: '',
    images: [], // [{ path, size }]
    canSend: false,
    sending: false,
    /** 发送按钮文案：锁着的状态下点发送其实是「校验密码」 */
    sendText: '发送',
    boardClass: 'board',

    nickname: DEFAULT_NICKNAME,
    maxContent: MAX_CONTENT,
    maxImages: MAX_IMAGES,
    /** 键盘弹起高度，composer 跟着抬，否则输入框被键盘盖住 */
    keyboardHeight: 0,
    composerStyle: '',
    newTipStyle: '',

    /**
     * 口令锁：每次进入页面都要重新输密码。
     * 没有单独的密码页——直接在输入框里打 4 位数字，点发送时先校验；
     * 校验通过前不请求任何数据。
     */
    unlocked: false,
  },

  onLoad() {
    this._page = 0;
    this._busy = false;
    this._newestAt = 0;
    this._scrollTop = 0;
    /** 离开前台的时刻；onShow 用它算离开时长，0 表示没离开过 */
    this._leftAt = 0;
    /** 最近一次选图结束的时刻（PICK_GRACE 窗口内回来不上锁） */
    this._mediaDoneAt = 0;
    /**
     * 会话令牌：每次上锁 +1。所有异步落地（拉列表、翻页、watch 推送、发送回执）
     * 都要在写 data 前比对它，否则锁屏后迟到的响应会把已清空的内容又灌回页面。
     */
    this._session = 0;
    this.setData({
      nickname: wx.getStorageSync(NICKNAME_KEY) || DEFAULT_NICKNAME,
      newTipStyle: `bottom: ${NEW_TIP_BOTTOM}px`,
    });

    /**
     * 锁屏 / 退出微信 / 切到别的应用，小程序整体进后台都会触发 wx.onAppHide。
     * 没有「只监听锁屏」的接口，所以这里和页面 onHide 一起做双通道，
     * 谁先到谁锁（lockBoard 幂等），保证锁屏的当下内容就没了，
     * 而不是等回到前台再补一次刷新。
     */
    this._onAppHide = () => this.handleBackground();
    if (typeof wx.onAppHide === 'function') {
      wx.onAppHide(this._onAppHide);
    }

    // 这里故意不调 loadFirst / startSync：进页面先是锁着的，解锁后才拉数据
  },

  onShow() {
    const away = this._leftAt ? Date.now() - this._leftAt : 0;
    this._leftAt = 0;

    // 兜底补锁：离开超过阈值回来一律先锁，锁完直接返回，不再刷新。
    // 选图/拍照要豁免——那是用户自己主动离开又立刻回来的，锁了图就白选了。
    if (this.data.unlocked && away > RELOCK_AFTER_HIDE && !this.isPickingMedia()) {
      this.lockBoard();
    }

    // 从别的页面回来：已解锁的话补一次，再恢复监听/轮询；没解锁就什么都不做
    if (!this.data.unlocked) return;
    if (this._loadedOnce) {
      this.pullNew();
      this.startSync();
    }
  },

  onHide() {
    this.stopSync();
    /**
     * 锁屏在真机上先走页面 onHide、再走 App 级 onAppHide，而且部分安卓机型
     * 灭屏时 App 级回调会迟到甚至不来。既然锁屏必经这里，就直接在这一层上锁，
     * 别把隐私押在单一通道上。
     */
    this.handleBackground();
  },

  /**
   * 进后台（锁屏 / 切 app / 退出微信）的统一入口。
   * 只负责「立刻清空」，不负责判断要不要清。
   *
   * 这里只认「选图正在进行中」——`_mediaDoneAt` 的宽限期不能拿来豁免，
   * 否则刚选完图就锁屏的那 1.5s 里内容不会隐藏。
   */
  handleBackground() {
    this._leftAt = Date.now();
    // 选图会把小程序短暂切到后台，这不是「离开」，回来还要接着用
    if (this._mediaPicking) return;
    this.lockBoard();
  },

  /** 选图是否正在进行 / 刚刚结束（各机型 complete 与 onShow 的先后不一致） */
  isPickingMedia() {
    if (this._mediaPicking) return true;
    return Boolean(this._mediaDoneAt) && Date.now() - this._mediaDoneAt < PICK_GRACE;
  },

  onUnload() {
    this.stopSync();
    if (this._onAppHide && typeof wx.offAppHide === 'function') {
      wx.offAppHide(this._onAppHide);
    }
  },

  onPageScroll(e) {
    this._scrollTop = e.scrollTop || 0;
  },

  onPullDownRefresh() {
    if (!this.data.unlocked) {
      wx.stopPullDownRefresh();
      return;
    }
    this.loadFirst({ silent: true }).then(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (!this.data.unlocked) return;
    this.loadMore();
  },

  /* ---------------- 口令 ---------------- */

  /**
   * 输入框里打的是 4 位数字 → 当成密码去校验。
   * 没有单独的密码页：发送按钮在锁着的时候就是「校验」。
   * 校验在云函数里比对，前端拿不到明文。
   *
   * 输错（含格式不对、网络失败）一律只提示「功能未开放」：
   * 对外不暴露这里有密码这回事。
   */
  async tryUnlock(text) {
    const pin = String(text || '').trim();
    const deny = () => {
      this.setData({ sending: false, sendText: '发送' });
      this.applyDraft('');
      wx.showToast({ title: '功能未开放', icon: 'none' });
    };

    if (!PIN_PATTERN.test(pin)) {
      deny();
      return;
    }

    this.setData({ sending: true, sendText: '校验中…' });
    try {
      const res = await wx.cloud.callFunction({
        name: CLOUD_FN,
        data: { action: 'unlock', pin },
      });
      const payload = (res && res.result) || {};
      if (!payload.ok) throw new Error(payload.error || '密码校验失败');

      // 口令校验通过后，用同一个口令派生加解密密钥（只在客户端，云函数拿不到）
      this._key = cipher.deriveKey(pin);

      // 解开后清空输入框（密码不该留在草稿里），再拉数据 + 开实时同步
      this.setData({ unlocked: true, sending: false, sendText: '发送' });
      this.applyDraft('');
      await this.loadFirst();
      // 拉数据期间可能已经锁屏（切后台/锁屏），别再起定时器
      if (!this.data.unlocked) return;
      this.startSync();
    } catch (err) {
      // 原始原因只留日志，界面上统一说「功能未开放」
      console.error('[leaveMessage] 口令校验失败：', err);
      // 顺带留一份在实例上，方便真机/模拟器排查（不展示给用户）
      this._unlockError = String((err && (err.errMsg || err.message)) || err || '');
      deny();
    }
  },

  /**
   * 重新上锁：锁屏 / 退出微信时调用。
   *
   * 不只是把 unlocked 置回 false —— 已加载的留言、待发草稿、选好的图、
   * 攒着的新留言全部清掉，避免别人拿到手机后直接看到内容。
   */
  lockBoard() {
    // 选图会短暂把小程序切到后台，这不是「离开」，别误锁
    if (this._mediaPicking) return;

    this.stopSync();
    if (!this.data.unlocked) return;

    // 先抬令牌再清数据：锁屏瞬间还在路上的请求回来时会发现令牌变了，直接丢弃
    this._session += 1;
    this._page = 0;
    this._busy = false;
    this._newestAt = 0;
    this._scrollTop = 0;
    this._loadedOnce = false;
    this._myOpenid = '';
    // 密钥不能留在内存里：上锁后即使拿到页面实例也解不出内容
    this._key = null;
    cipher.clearKey();

    this.setData({
      unlocked: false,
      messages: [],
      pendingNew: [],
      newCount: 0,
      newTipText: '',
      error: '',
      loading: false,
      hasMore: true,
      draft: '',
      images: [],
      canSend: false,
      boardClass: 'board',
      sendText: '发送',
      keyboardHeight: 0,
      composerStyle: '',
    });
  },

  /* ---------------- 列表 ---------------- */

  async fetchPage(page) {
    if (!wx.cloud) throw new Error('当前微信版本不支持云开发，请升级微信后重试');
    const res = await wx.cloud.callFunction({
      name: CLOUD_FN,
      data: { action: 'list', page, pageSize: PAGE_SIZE },
    });
    const payload = (res && res.result) || {};
    if (!payload.ok) throw new Error(payload.error || '留言加载失败');
    if (payload.data && payload.data.myOpenid) this._myOpenid = payload.data.myOpenid;
    return payload.data || { list: [], hasMore: false };
  },

  /** 增量拉取：只要比本地最新一条更新的留言 */
  async fetchSince(since) {
    if (!wx.cloud) throw new Error('当前微信版本不支持云开发，请升级微信后重试');
    const res = await wx.cloud.callFunction({
      name: CLOUD_FN,
      data: { action: 'list', since },
    });
    const payload = (res && res.result) || {};
    if (!payload.ok) throw new Error(payload.error || '留言刷新失败');
    if (payload.data && payload.data.myOpenid) this._myOpenid = payload.data.myOpenid;
    return payload.data || { list: [] };
  },

  /** 重新拉第一页。silent 用于下拉刷新：不清屏、不显示骨架，刷新痕迹更轻 */
  async loadFirst({ silent = false } = {}) {
    if (this._busy) return;
    this._busy = true;
    const session = this._session;
    if (!silent) this.setData({ loading: true });
    try {
      const data = await this.fetchPage(0);
      // 请求期间锁屏了：这一页数据不能在已清空的页面上落地
      if (session !== this._session || !this.data.unlocked) return;
      const messages = (data.list || []).map((raw) => decorate(raw, this._key));
      this._page = 0;
      this._loadedOnce = true;
      this._newestAt = messages.reduce((max, item) => Math.max(max, item.createdAt), 0);
      this.setData({
        messages,
        hasMore: Boolean(data.hasMore),
        loading: false,
        error: '',
        // 整页重拉过了，攒着的新留言已经包含在里面
        pendingNew: [],
        newCount: 0,
        newTipText: '',
      });
    } catch (err) {
      console.error('[leaveMessage] 加载列表失败：', err);
      this.setData({ loading: false, error: toFriendlyError(err) });
    } finally {
      this._busy = false;
    }
  },

  async loadMore() {
    if (this._busy || this.data.loading || !this.data.hasMore) return;
    this._busy = true;
    const session = this._session;
    this.setData({ loadingMore: true });
    try {
      const next = this._page + 1;
      const data = await this.fetchPage(next);
      if (session !== this._session || !this.data.unlocked) return;
      this._page = next;
      this.setData({
        // 翻页期间可能有新留言插进来，普通 concat 会出现重复项
        messages: mergeMessages((data.list || []).map((raw) => decorate(raw, this._key)), this.data.messages),
        hasMore: Boolean(data.hasMore),
        loadingMore: false,
      });
    } catch (err) {
      console.error('[leaveMessage] 加载更多失败：', err);
      this.setData({ loadingMore: false });
      // 加载更多失败只轻提示，别把整页打成错误态——已经看到的列表还在
      wx.showToast({ title: toFriendlyError(err), icon: 'none' });
    } finally {
      this._busy = false;
    }
  },

  retryLoad() {
    this.loadFirst();
  },

  /* ---------------- 实时刷新 ---------------- */

  startSync() {
    this.startPolling();
    this.startWatch();
  },

  stopSync() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this._watcher) {
      try {
        this._watcher.close();
      } catch (err) {
        console.error('[leaveMessage] 关闭实时监听失败：', err);
      }
      this._watcher = null;
    }
  },

  startPolling() {
    if (this._timer) return;
    this._timer = setInterval(() => this.pullNew(), SYNC_INTERVAL);
  },

  /**
   * 云开发数据库 watch：真正的实时推送。
   *
   * 前提是集合读权限放得开（「所有用户可读」），否则只能收到自己写入的文档，
   * 别人发的推不过来 —— 所以这里失败也不影响：轮询在兜底。
   */
  startWatch() {
    if (this._watcher || this._watchFailed) return;
    if (!wx.cloud || typeof wx.cloud.database !== 'function') return;
    try {
      this._watcher = wx.cloud
        .database()
        .collection(COLLECTION)
        .orderBy('createdAt', 'desc')
        .limit(WATCH_LIMIT)
        .watch({
          onChange: (snapshot) => this.onWatchChange(snapshot),
          onError: (err) => {
            console.error('[leaveMessage] 实时监听不可用，改用轮询：', err);
            this._watchFailed = true;
            this._watcher = null;
          },
        });
    } catch (err) {
      console.error('[leaveMessage] 实时监听启动失败，改用轮询：', err);
      this._watchFailed = true;
      this._watcher = null;
    }
  },

  /** watch 推送的文档是原始结构（带 _openid），这里转成列表项再合并 */
  onWatchChange(snapshot) {
    // 上锁之后 watcher 已关，但排队中的推送还可能到这，一律丢掉
    if (!this.data.unlocked) return;
    const changes = (snapshot && snapshot.docChanges) || [];
    const removed = [];
    const added = [];
    changes.forEach((change) => {
      if (!change) return;
      if (change.dataType === 'remove' && change.docId) removed.push(change.docId);
      if (change.doc) {
        added.push(
          decorate(
            {
              id: change.doc._id,
              content: change.doc.content,
              images: change.doc.images,
              nickname: change.doc.nickname,
              createdAt: change.doc.createdAt,
              mine: Boolean(this._myOpenid) && change.doc._openid === this._myOpenid,
            },
            this._key,
          ),
        );
      }
    });

    if (removed.length) {
      const pendingNew = this.data.pendingNew.filter((item) => !removed.includes(item.id));
      this.setData({
        messages: this.data.messages.filter((item) => !removed.includes(item.id)),
        pendingNew,
        newCount: pendingNew.length,
        newTipText: buildNewTip(pendingNew),
      });
    }
    if (added.length) this.ingest(added);
  },

  /** 轮询兜底：只拉增量，失败静默（不打断用户看留言） */
  async pullNew() {
    if (this._pulling || !this.data.unlocked) return;
    this._pulling = true;
    const session = this._session;
    try {
      // 列表还是空的（本地没有基准时间）就退回拉第一页：
      // 空板子恰恰最需要「有人发第一条时能自动出现」
      const data = this._newestAt ? await this.fetchSince(this._newestAt) : await this.fetchPage(0);
      // 请求期间可能已经锁屏（清空 + 清密钥），别把旧数据写回去
      if (session !== this._session || !this.data.unlocked) return;
      const list = data.list || [];
      if (list.length) this.ingest(list.map((raw) => decorate(raw, this._key)));
    } catch (err) {
      console.error('[leaveMessage] 增量刷新失败：', err);
    } finally {
      this._pulling = false;
    }
  },

  /**
   * 收到新留言。
   *
   * 按 openid 分成两拨：**自己发的（含同账号在别的设备上发的）只静默并进列表，
   * 不计入「新留言」提示**；只有别人发的才会触发浮条。
   *
   * 别人的留言：用户正停在顶部 → 直接插进去；已经往下翻了 → 先攒着，
   * 浮出「XX 发了新留言」，点了再滚回去合并，免得把正在读的内容顶走。
   */
  ingest(items) {
    // 锁着的时候任何来源的新数据都不落地（锁屏瞬间在途的轮询/watch 都会走到这）
    if (!items.length || !this.data.unlocked) return;
    this._newestAt = Math.max(
      this._newestAt || 0,
      items.reduce((max, item) => Math.max(max, item.createdAt), 0),
    );

    const own = items.filter((item) => item.mine);
    const others = items.filter((item) => !item.mine);

    // 自己的先落地，不打扰
    if (own.length) {
      this.setData({ messages: mergeMessages(own, this.data.messages) });
    }
    if (!others.length) return;

    if ((this._scrollTop || 0) > SCROLL_HOLD && this.data.messages.length) {
      const pendingNew = mergeMessages(others, this.data.pendingNew);
      this.setData({
        pendingNew,
        newCount: pendingNew.length,
        newTipText: buildNewTip(pendingNew),
      });
      return;
    }

    this.setData({ messages: mergeMessages(others, this.data.messages) });
  },

  flushNew() {
    this.setData({
      messages: mergeMessages(this.data.pendingNew, this.data.messages),
      pendingNew: [],
      newCount: 0,
      newTipText: '',
    });
    wx.pageScrollTo({ scrollTop: 0, duration: 200 });
  },

  /* ---------------- 输入区 ---------------- */

  onInput(e) {
    this.applyDraft(e.detail.value);
  },

  applyDraft(draft) {
    this.setData({ draft, canSend: Boolean(String(draft).trim()) || this.data.images.length > 0 });
  },

  applyImages(images) {
    this.setData({
      images,
      canSend: Boolean(this.data.draft.trim()) || images.length > 0,
      // 有图时输入区高一截，列表底部要多留白，否则最后一条被挡住
      boardClass: images.length ? 'board board--picking' : 'board',
      // 浮条跟着输入区一起抬高，别压在缩略图上
      newTipStyle: `bottom: ${images.length ? NEW_TIP_BOTTOM_PICKING : NEW_TIP_BOTTOM}px`,
    });
  },

  chooseImage() {
    if (this.data.sending) return;
    // 未解锁时静默忽略：输密码是默认规则，界面上不提示
    if (!this.data.unlocked) return;
    const remain = MAX_IMAGES - this.data.images.length;
    if (remain <= 0) {
      wx.showToast({ title: `最多 ${MAX_IMAGES} 张图片`, icon: 'none' });
      return;
    }
    // 选图时系统会把小程序短暂切到后台，这段时间不能被判成「锁屏」而上锁
    this._mediaPicking = true;
    wx.chooseMedia({
      count: remain,
      mediaType: ['image'],
      // 用户自己勾选原图会更清晰但更慢，这里默认压缩，留言板不需要原图
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const picked = (res.tempFiles || [])
          .filter((file) => file && file.tempFilePath)
          .map((file) => ({ path: file.tempFilePath, size: file.size || 0 }));
        this.applyImages(this.data.images.concat(picked).slice(0, MAX_IMAGES));
      },
      fail: (err) => {
        // 用户主动取消不算错误，不要弹提示
        if (!/cancel/i.test(String((err && err.errMsg) || ''))) {
          console.error('[leaveMessage] 选图失败：', err);
          wx.showToast({ title: '选择图片失败，请重试', icon: 'none' });
        }
      },
      complete: () => {
        this._mediaPicking = false;
        // 记一笔结束时刻：有的机型 onShow 早于 complete，靠它做 PICK_GRACE 豁免
        this._mediaDoneAt = Date.now();
      },
    });
  },

  removeImage(e) {
    if (this.data.sending) return;
    const { index } = e.currentTarget.dataset;
    const images = this.data.images.slice();
    images.splice(index, 1);
    this.applyImages(images);
  },

  previewDraft(e) {
    const { index } = e.currentTarget.dataset;
    wx.previewImage({
      urls: this.data.images.map((item) => item.path),
      current: this.data.images[index] && this.data.images[index].path,
    });
  },

  onKeyboardHeight(e) {
    const height = (e.detail && e.detail.height) || 0;
    this.setData({
      keyboardHeight: height,
      composerStyle: height ? `bottom: ${height}px` : '',
    });
  },

  /** 改昵称：用 showModal 的可编辑输入，比单独做一个弹层省事 */
  editNickname() {
    wx.showModal({
      title: '设置昵称',
      editable: true,
      placeholderText: '最多 12 个字',
      content: this.data.nickname,
      success: (res) => {
        if (!res.confirm) return;
        const nickname = String(res.content || '').trim().slice(0, 12);
        if (!nickname) return;
        wx.setStorageSync(NICKNAME_KEY, nickname);
        this.setData({ nickname });
      },
    });
  },

  /* ---------------- 发送 ---------------- */

  /** 图片先落云存储拿 fileID，云函数只收 fileID（不传 base64，避开 1MB 入参上限） */
  async uploadImages(images) {
    if (!images.length) return [];
    if (!wx.cloud) throw new Error('当前微信版本不支持云开发，请升级微信后重试');
    const fileIDs = [];
    for (let i = 0; i < images.length; i += 1) {
      const path = images[i].path;
      // eslint-disable-next-line no-await-in-loop
      const res = await wx.cloud.uploadFile({
        cloudPath: `leave-message/${yearMonth()}/${randomName()}.${pickSuffix(path)}`,
        filePath: path,
      });
      if (!res || !res.fileID) throw new Error('图片上传失败，请重试');
      fileIDs.push(res.fileID);
    }
    return fileIDs;
  },

  async send() {
    if (this.data.sending) return;

    // 还没解锁：输入框里的 4 位数字当密码处理，先去校验，不当成留言发出去
    if (!this.data.unlocked) {
      await this.tryUnlock(this.data.draft);
      return;
    }

    const plainContent = String(this.data.draft).trim();
    const images = this.data.images;

    if (!plainContent && !images.length) {
      wx.showToast({ title: '说点什么再发送吧', icon: 'none' });
      return;
    }
    if (Array.from(plainContent).length > MAX_CONTENT) {
      wx.showToast({ title: `留言最多 ${MAX_CONTENT} 字`, icon: 'none' });
      return;
    }
    if (!this._key) {
      // 密钥丢了（理论上只有解锁前才可能），别把明文发出去
      console.error('[leaveMessage] 缺少加密密钥，拒绝发送');
      this.setData({ sending: false, sendText: '发送' });
      wx.showToast({ title: '功能未开放', icon: 'none' });
      return;
    }

    // 文字和昵称都在本地加密再上传，云函数和数据库只见到 v1.<base64>
    let content = '';
    let nickname = '';
    try {
      content = cipher.encrypt(this._key, plainContent);
      nickname = cipher.encrypt(this._key, this.data.nickname);
    } catch (err) {
      console.error('[leaveMessage] 加密失败：', err);
      wx.showToast({ title: '发送失败，请重试', icon: 'none' });
      return;
    }

    this.setData({ sending: true, sendText: '发送中' });
    try {
      const fileIDs = await this.uploadImages(images);
      const res = await wx.cloud.callFunction({
        name: CLOUD_FN,
        data: { action: 'create', content, images: fileIDs, nickname, encrypted: 1 },
      });
      const payload = (res && res.result) || {};
      if (!payload.ok) throw new Error(payload.error || '发送失败');

      // 发送期间锁屏了：服务端已经存下，但本地不能再把这条插回已清空的页面
      if (!this.data.unlocked) return;

      // 乐观插入：服务端已经落库，直接把自己这条并进列表，省一次整页刷新。
      // watch / 轮询稍后也会推回同一条，靠 mergeMessages 按 id 去重，不会重复
      const item = decorate({ ...payload.data, mine: true }, this._key);
      this._newestAt = Math.max(this._newestAt || 0, item.createdAt);
      this.setData({
        messages: mergeMessages([item], this.data.messages),
        draft: '',
        images: [],
        canSend: false,
        sending: false,
        sendText: '发送',
        boardClass: 'board',
        newTipStyle: `bottom: ${NEW_TIP_BOTTOM}px`,
      });
      wx.pageScrollTo({ scrollTop: 0, duration: 200 });
    } catch (err) {
      console.error('[leaveMessage] 发送失败：', err);
      this.setData({ sending: false, sendText: '发送' });
      wx.showToast({ title: toFriendlyError(err), icon: 'none' });
    }
  },

  /* ---------------- 图片预览 / 删除 ---------------- */

  previewMessageImage(e) {
    const { id, index } = e.currentTarget.dataset;
    const target = this.data.messages.find((item) => item.id === id);
    if (!target || !target.images.length) return;
    // fileID 可直接给 previewImage 用，不用先换临时链接
    wx.previewImage({
      urls: target.images,
      current: target.images[index],
    });
  },

  onMessageLongPress(e) {
    // 归属从 messages 里查，不读 data-mine：dataset 的值有时会被转成字符串，
    // 靠它判「是不是自己的」不可靠（服务端还会再校验一次，这里只是省掉无意义的确认弹窗）
    const { id } = e.currentTarget.dataset;
    const target = this.data.messages.find((item) => item.id === id);
    if (!target || !target.mine) return;
    wx.showModal({
      title: '删除留言',
      content: '删除后不可恢复，确定删除吗？',
      confirmText: '删除',
      confirmColor: '#d54941',
      success: (res) => {
        if (res.confirm) this.removeMessage(id);
      },
    });
  },

  async removeMessage(id) {
    try {
      const res = await wx.cloud.callFunction({ name: CLOUD_FN, data: { action: 'remove', id } });
      const payload = (res && res.result) || {};
      if (!payload.ok) throw new Error(payload.error || '删除失败');
      this.setData({ messages: this.data.messages.filter((item) => item.id !== id) });
      wx.showToast({ title: '已删除', icon: 'success' });
    } catch (err) {
      console.error('[leaveMessage] 删除失败：', err);
      wx.showToast({ title: toFriendlyError(err), icon: 'none' });
    }
  },
});
