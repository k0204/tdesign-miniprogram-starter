Component({
  properties: {
    url: String,
    desc: String,
    tags: Array,
    /** 是否已点赞，实际状态由页面持有（组件只负责画和抛事件） */
    liked: {
      type: Boolean,
      value: false,
    },
  },
  data: {
    heartIcon: 'heart',
    heartColor: '#ffffff',
    likeClass: 'home-card__like',
  },
  observers: {
    liked(value) {
      // 图标名 / 颜色 / class 都在 JS 侧算好，模板里不写判断。
      // 爱心压在图片上，未点赞用白色才不会跟画面糊在一起（底色有半透明黑托着）
      this.setData({
        heartIcon: value ? 'heart-filled' : 'heart',
        heartColor: value ? '#d54941' : '#ffffff',
        likeClass: value ? 'home-card__like home-card__like--on' : 'home-card__like',
      });
    },
  },
  methods: {
    /** catchtap：点赞不能冒泡到卡片上（卡片本身没有点击行为，但别让以后的整卡点击把它吃掉） */
    onLike() {
      this.triggerEvent('like');
    },
  },
});
