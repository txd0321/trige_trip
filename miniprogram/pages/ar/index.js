// pages/ar/index.js
import { playNoteAudio } from '../../utils/audio';

Page({
  data: {
    collected: [],
    total: 14,
    percent: 0,
    cardId: '',
  },
  onLoad(options) {
    this.setData({ cardId: options.cardId || '' });
  },
  goBack() {
    wx.navigateBack({});
  },
  onScan(e) {
    // 占位：识别音符逻辑。此处用随机演示
    const noteId = Math.floor(Math.random() * 14);
    if (this.data.collected.includes(noteId)) return;

    // 播放音效
    playNoteAudio(noteId);

    // 更新进度
    const collected = this.data.collected.concat(noteId);
    const percent = (collected.length / this.data.total) * 100;
    this.setData({ collected, percent });

    // 上报接口
    wx.cloud.callFunction({
      name: 'arNote',
      data: { cardId: this.data.cardId, noteId },
    });

    // 完成条件
    if (collected.length >= 13) {
      wx.showToast({ title: '扫描完成！', icon: 'success', duration: 1500 });
      setTimeout(() => {
        wx.navigateTo({ url: `/pages/winder/index?cardId=${this.data.cardId}` });
      }, 1500);
    }
  },
});
