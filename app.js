// app.js
import config from './config';
import Mock from './mock/index';

if (config.isMock) {
  Mock();
}

App({
  onLaunch() {
    this.initCloud();

    const updateManager = wx.getUpdateManager();

    updateManager.onCheckForUpdate((res) => {
      // console.log(res.hasUpdate)
    });

    updateManager.onUpdateReady(() => {
      wx.showModal({
        title: '更新提示',
        content: '新版本已经准备好，是否重启应用？',
        success(res) {
          if (res.confirm) {
            updateManager.applyUpdate();
          }
        },
      });
    });
  },

  globalData: {
    userInfo: null,
  },

  /** 初始化云开发（AI 图生图依赖 wx.cloud.callFunction / uploadFile） */
  initCloud() {
    if (!wx.cloud) {
      console.warn('[cloud] 当前基础库不支持云开发');
      return;
    }
    try {
      wx.cloud.init({
        ...(config.cloudEnv ? { env: config.cloudEnv } : {}),
        traceUser: true,
      });
    } catch (err) {
      console.warn('[cloud] init 失败，请确认已开通云开发环境：', err);
    }
  },
});
