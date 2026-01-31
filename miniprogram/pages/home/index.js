// pages/home/index.js
Page({
  data: {
    basePath: 'https://miniapp-assets-cupi-1327655007.cos.ap-guangzhou.myqcloud.com/animations/',
    placeholderSrc: 'https://miniapp-assets-cupi-1327655007.cos.ap-guangzhou.myqcloud.com/animations/catstop.png',
    logoSrc: 'https://miniapp-assets-cupi-1327655007.cos.ap-guangzhou.myqcloud.com/ui/logo.png',

    currentSrc: '',
    isLoop: false,
    showPlaceholder: true,

    randomActions: ['catdance', 'catspeak', 'catyawn'],

    isPlayingAction: false,
    musicOn: true,
  },

  /* ------------------------- 生命周期 ------------------------- */
  onReady() {
    this.videoCtx = wx.createVideoContext('elfVideo', this);
  },

  onLoad() {
    // 进入页面立即播放一次 catlook，然后进入闲置循环
    this.playCatlook();
  },
  onHide() {
    // 切换到其他 Tab 时会触发 onHide，但不会销毁页面
    clearTimeout(this.idleTimer);
    if (this.videoCtx) {
      this.videoCtx.stop(); // 彻底停止，释放声音
    }
    // 清空状态，返回时重新播放
    this.setData({ currentSrc: '', showPlaceholder: true, isPlayingAction: false });
    this.wasHidden = true;
  },
  onShow() {
    // 第一次 onShow 会在 onLoad 之后立即触发，此时由 onLoad 负责首帧播放
    if (this.wasHidden) {
      this.wasHidden = false;
      this.playCatlook();
    }
  },
  onUnload() {
    clearTimeout(this.idleTimer);
  },

  /* ------------------ 播放控制 ------------------ */
  // 播放一次 catlook
  playCatlook() {
    this.setData({ showPlaceholder: true, currentSrc: this.data.basePath + 'catlook.mp4', isLoop: false });
  },

  // 安排 10 秒后进入一次 catlook 播放
  scheduleIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.playCatlook();
    }, 10000);
  },

  // 播放任意一次性动画（交互/idle）
  playOnce(src) {
    this.setData({ showPlaceholder: true, currentSrc: src, isLoop: false });
  },

  handleTap() {
    if (this.data.isPlayingAction) return;
    clearTimeout(this.idleTimer);
    const next = this.data.randomActions[Math.floor(Math.random() * this.data.randomActions.length)];
    this.setData({ isPlayingAction: true });
    this.playOnce(this.data.basePath + `${next}.mp4`);
  },

  onVideoLoaded() {
    if (this.videoCtx) {
      this.videoCtx.seek(0);
      this.videoCtx.play();
    }
  },
  onVideoPlay() {
    this.setData({ showPlaceholder: false });
  },

  onVideoEnded() {
    // 无论是 catlook 还是点击动作，播放完都回到 catstop
    this.setData({ showPlaceholder: true, currentSrc: '', isPlayingAction: false });
    // 进入 idle：catstop 停留 10s 后再播放一次 catlook
    this.scheduleIdle();
  },

  toggleMusic(e) {
    this.setData({ musicOn: e.detail.value });
  },

  goAR() {
    wx.navigateTo({ url: '/pages/ar/index' });
  },
});
