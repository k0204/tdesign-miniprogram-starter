Component({
  data: {
    value: '', // 初始值设置为空，避免第一次加载时闪烁
  },
  lifetimes: {
    ready() {
      const pages = getCurrentPages();
      const curPage = pages[pages.length - 1];
      if (!curPage) return;
      // 从路由里取 tab 名（home / my），和 t-tab-bar-item 的 value 对齐
      const nameRe = /pages\/(\w+)\/index/.exec(curPage.route);
      if (nameRe === null) return;
      if (nameRe[1]) {
        this.setData({ value: nameRe[1] });
      }
    },
  },
  methods: {
    handleChange(e) {
      const { value } = e.detail;
      wx.switchTab({ url: `/pages/${value}/index` });
    },
  },
});
