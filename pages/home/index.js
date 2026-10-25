import Message from 'tdesign-miniprogram/message/index';
import request from '~/api/request';

// 获取应用实例
// const app = getApp()

/**
 * 留言板入口：连续点击卡片上的点赞红星 5 次。
 *
 * 为什么用「连击」而不是直接点卡片：卡片本身要保持可浏览（以后可能挂详情页），
 * 所以入口做成一个小彩蛋，点不到就走不开，不会误触。
 *
 * 连击判定：两次点击间隔 ≤ LIKE_STREAK_GAP 才算同一串，
 * 中间停顿超过这个值就从 1 重新数。计数器跨卡片共用——
 * 4 张卡各点 2 下、中间没停，也算连击。
 */
const LIKE_STREAK_TARGET = 5;
const LIKE_STREAK_GAP = 2000;

/** 点赞状态存在本地：卡片没有稳定 id，用图片地址当 key（同名描述有两张，不能用 desc） */
const LIKE_STORAGE_KEY = 'card_likes';

/** 给卡片补渲染字段：是否已点赞（模板不做判断） */
function decorateCards(list, likedKeys) {
  const rows = Array.isArray(list) ? list : [];
  const liked = new Set(Array.isArray(likedKeys) ? likedKeys : []);
  return rows.map((item) => ({ ...item, liked: liked.has(item.url || '') }));
}

Page({
  data: {
    enable: false,
    swiperList: [],
    cardInfo: [],
    focusCardInfo: [],
    // 发布
    motto: 'Hello World',
    userInfo: {},
    hasUserInfo: false,
    canIUse: wx.canIUse('button.open-type.getUserInfo'),
    canIUseGetUserProfile: false,
    canIUseOpenData: wx.canIUse('open-data.type.userAvatarUrl') && wx.canIUse('open-data.type.userNickName'), // 如需尝试获取用户信息可改为false
  },

  onLoad(option) {
    this._likedKeys = wx.getStorageSync(LIKE_STORAGE_KEY) || [];
    this._likeStreak = 0;
    this._lastLikeAt = 0;

    if (wx.getUserProfile) {
      this.setData({
        canIUseGetUserProfile: true,
      });
    }
    if (option.oper) {
      let content = '';
      if (option.oper === 'release') {
        content = '发布成功';
      } else if (option.oper === 'save') {
        content = '保存成功';
      }
      this.showOperMsg(content);
    }
  },

  // 生命周期
  async onReady() {
    const [cardRes, swiperRes] = await Promise.all([
      request('/home/cards').then((res) => res.data),
      request('/home/swipers').then((res) => res.data),
    ]);

    this.applyCards(cardRes.data);
    this.setData({ swiperList: swiperRes.data });
  },

  onHide() {
    // 离开页面就断开连击，回来重新数
    this.resetStreak();
  },

  onRefresh() {
    this.refresh();
  },

  async refresh() {
    this.setData({
      enable: true,
    });
    const [cardRes, swiperRes] = await Promise.all([
      request('/home/cards').then((res) => res.data),
      request('/home/swipers').then((res) => res.data),
    ]);

    setTimeout(() => {
      this.setData({ enable: false, swiperList: swiperRes.data });
      this.applyCards(cardRes.data);
    }, 1500);
  },

  /**
   * 卡片列表只有一个写入口：点赞状态从这里统一注入，
   * 「我的关注」用同一次结果切片，两个 tab 的星星才不会各画各的。
   */
  applyCards(rawList) {
    const cardInfo = decorateCards(rawList, this._likedKeys);
    this.setData({
      cardInfo,
      focusCardInfo: cardInfo.slice(0, 3),
    });
  },

  showOperMsg(content) {
    Message.success({
      context: this,
      offset: [120, 32],
      duration: 4000,
      content,
    });
  },

  /* ---------------- 点赞 ---------------- */

  onCardLike(e) {
    // 用图片地址定位，不用下标：「我的关注」是切片出来的另一份数据，
    // 下标恰好和「推荐」对齐但不该依赖这一点
    const url = e.currentTarget.dataset.url || '';
    const index = this.data.cardInfo.findIndex((item) => item.url === url);
    if (index < 0) return;

    this.toggleLike(index);
    this.countStreak();
  },

  toggleLike(index) {
    const cardInfo = this.data.cardInfo.slice();
    const card = cardInfo[index];
    const liked = !card.liked;
    cardInfo[index] = { ...card, liked };

    const keys = new Set(this._likedKeys);
    if (liked) {
      keys.add(card.url || '');
    } else {
      keys.delete(card.url || '');
    }
    this._likedKeys = Array.from(keys);
    wx.setStorageSync(LIKE_STORAGE_KEY, this._likedKeys);

    this.setData({
      cardInfo,
      focusCardInfo: cardInfo.slice(0, 3),
    });
  },

  countStreak() {
    const now = Date.now();
    const gap = now - this._lastLikeAt;
    this._lastLikeAt = now;
    this._likeStreak = gap <= LIKE_STREAK_GAP ? this._likeStreak + 1 : 1;

    if (this._likeStreak < LIKE_STREAK_TARGET) return;

    this.resetStreak();
    wx.navigateTo({
      url: '/pages/leaveMessage/index',
    });
  },

  resetStreak() {
    this._likeStreak = 0;
    this._lastLikeAt = 0;
  },

  goRelease() {
    wx.navigateTo({
      url: '/pages/release/index',
    });
  },

  goAiImage() {
    wx.navigateTo({
      url: '/pages/aiImage/index',
    });
  },
});
