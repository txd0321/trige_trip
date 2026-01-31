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
    idleTimer: null,
    isPlayingAction: false,
    musicOn: true,
  },

  /* ------------------------- 生命周期 ------------------------- */
  onLoad() {
    this.startIdleLoop();
  },
  onUnload() {
    clearTimeout(this.data.idleTimer);
  },

  startIdleLoop() {
    const loop = () => {
      this.playOnce(this.data.basePath + 'catlook.mp4');
      this.data.idleTimer = setTimeout(loop, 10000);
    };
    this.data.idleTimer = setTimeout(loop, 1000);
  },

  playOnce(src) {
    this.setData({ showPlaceholder: true, currentSrc: src, isLoop: false });
  },

  handleTap() {
    if (this.data.isPlayingAction) return;
    clearTimeout(this.data.idleTimer);
    const next = this.data.randomActions[Math.floor(Math.random() * this.data.randomActions.length)];
    this.setData({ isPlayingAction: true });
    this.playOnce(this.data.basePath + `${next}.mp4`);
  },

  onVideoLoaded() {
    const video = wx.createVideoContext('elfVideo', this);
    video.seek(0);
    video.play();
  },
  onVideoPlay() {
    this.setData({ showPlaceholder: false });
    if (this.data.isPlayingAction) {
      setTimeout(() => {
        this.setData({ showPlaceholder: true, currentSrc: '', isPlayingAction: false });
        this.startIdleLoop();
      }, 4800);
    }
  },

  toggleMusic(e) {
    this.setData({ musicOn: e.detail.value });
  },

  goAR() {
    wx.navigateTo({ url: '/pages/ar/index' });
  },
});
