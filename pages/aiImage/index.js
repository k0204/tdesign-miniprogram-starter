// pages/aiImage/index.js —— AI 图生图（垫图 + 提示词 -> 生成图）
import useToastBehavior from '~/behaviors/useToast';

const MAX_PROMPT = 500;
const CLOUD_FN_NAME = 'imageToImage';

const randomName = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

Page({
  behaviors: [useToastBehavior],

  data: {
    // 垫图：本地临时路径 + 上传后的云存储 fileID
    sourcePath: '',
    sourceFileID: '',
    uploading: false,

    prompt: '',
    presets: [
      '改成水彩风格，暖色调',
      '转为日系动漫风格',
      '变成赛博朋克夜景',
      '换成写实摄影风格',
      '改为国风水墨画',
    ],

    generating: false,
    resultSrc: '', // 优先 fileID，其次官方临时 URL
    resultFileID: '',
    resultUrl: '',
    revisedPrompt: '',
    error: '',
  },

  /** 选择垫图 */
  chooseImage() {
    if (this.data.uploading || this.data.generating) return;
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: async (res) => {
        const file = res.tempFiles && res.tempFiles[0];
        if (!file) return;
        this.setData({ sourcePath: file.tempFilePath, sourceFileID: '', error: '' });
        await this.uploadSource(file.tempFilePath);
      },
      fail: (err) => {
        if (err && err.errMsg && err.errMsg.includes('cancel')) return;
        this.setData({ error: '选择图片失败' });
      },
    });
  },

  /** 垫图上传到云存储，换取 fileID（云函数侧再换成公网 URL） */
  async uploadSource(tempFilePath) {
    if (!wx.cloud) {
      this.setData({ error: '当前环境不支持云开发，请检查基础库版本' });
      return;
    }
    this.setData({ uploading: true });
    try {
      const suffix = (/\.([a-zA-Z0-9]+)$/.exec(tempFilePath) || [, 'jpg'])[1].toLowerCase();
      const { fileID } = await wx.cloud.uploadFile({
        cloudPath: `ai-images/input/${randomName()}.${['jpg', 'jpeg', 'png'].includes(suffix) ? suffix : 'jpg'}`,
        filePath: tempFilePath,
      });
      this.setData({ sourceFileID: fileID });
    } catch (err) {
      this.setData({ error: `垫图上传失败：${(err && err.errMsg) || '请稍后重试'}` });
    } finally {
      this.setData({ uploading: false });
    }
  },

  removeImage() {
    this.setData({ sourcePath: '', sourceFileID: '', error: '' });
  },

  onPromptChange(e) {
    this.setData({ prompt: (e.detail && e.detail.value) || '' });
  },

  usePreset(e) {
    const { text } = e.currentTarget.dataset;
    this.setData({ prompt: text });
  },

  /** 调云函数生图 */
  async generate() {
    const { prompt, sourceFileID, uploading, generating } = this.data;
    if (generating) return;

    const value = prompt.trim();
    if (!sourceFileID) {
      this.setData({ error: uploading ? '垫图上传中，请稍候' : '请先选择 1 张垫图' });
      return;
    }
    if (!value) {
      this.setData({ error: '请输入提示词' });
      return;
    }
    if (value.length > MAX_PROMPT) {
      this.setData({ error: `提示词最多 ${MAX_PROMPT} 字` });
      return;
    }

    this.setData({ generating: true, error: '' });
    wx.showLoading({ title: '生成中，约 30s', mask: true });

    let succeeded = false;
    try {
      const res = await wx.cloud.callFunction({
        name: CLOUD_FN_NAME,
        data: { prompt: value, fileID: sourceFileID, revise: true },
      });
      const result = (res && res.result) || {};
      if (!result.ok) {
        this.setData({ error: result.error || '生成失败' });
        return;
      }
      this.setData({
        resultFileID: result.fileID || '',
        resultUrl: result.url || '',
        resultSrc: result.fileID || result.url || '',
        revisedPrompt: result.revisedPrompt || '',
        error: '',
      });
      succeeded = true;
    } catch (err) {
      this.setData({
        error: `生成失败：${(err && (err.errMsg || err.message)) || '请检查云函数是否已部署'}`,
      });
    } finally {
      // loading 先关，再弹 toast，避免两个浮层叠在一起
      wx.hideLoading();
      this.setData({ generating: false });
      if (succeeded) this.onShowToast('#t-toast', '生成完成');
    }
  },

  preview() {
    const { resultSrc } = this.data;
    if (!resultSrc) return;
    wx.previewImage({ current: resultSrc, urls: [resultSrc] });
  },

  /** 保存到相册：优先走云文件下载，避免官方 URL 域名未加入 downloadFile 白名单 */
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
      if (msg.includes('auth deny') || msg.includes('authorize')) {
        wx.showModal({
          title: '需要相册权限',
          content: '请在设置中允许保存到相册后重试',
          confirmText: '去设置',
          success: (r) => r.confirm && wx.openSetting(),
        });
        return;
      }
      this.setData({ error: msg.includes('cancel') ? '' : `保存失败：${msg}` });
    }
  },

  copyFileID() {
    const { resultFileID } = this.data;
    if (!resultFileID) {
      this.onShowToast('#t-toast', '未生成云存储文件');
      return;
    }
    wx.setClipboardData({ data: resultFileID });
  },

  /** 清空结果，保留垫图与提示词，便于微调重试 */
  resetResult() {
    this.setData({ resultSrc: '', resultFileID: '', resultUrl: '', revisedPrompt: '', error: '' });
  },
});
