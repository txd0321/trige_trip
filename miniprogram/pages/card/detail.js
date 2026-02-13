Page({
  data: { 
    loading: true, 
    error: '', 
    card: {}, 
    unlocked: false, // 是否已经解锁
    cupId: '' 
  },
  onLoad(options) {
    let cupId = options.cupId || '';
    
    // --- 核心修改：处理普通链接二维码跳转 ---
    if (options.q) {
      const url = decodeURIComponent(options.q);
      // 假设您的链接格式为 https://yourdomain.com/card?cupId=CUP_001
      // 或者 https://yourdomain.com/card/CUP_001
      const match = url.match(/[?&]cupId=([^&]+)/) || url.match(/\/card\/([^?]+)/);
      if (match && match[1]) {
        cupId = match[1];
      }
    }

    if (!cupId) return this.setData({ loading: false, error: '缺少 cupId' });
    this.setData({ cupId });
  },

  onShow() {
    if (this.data.cupId) {
      this.fetchCardStatus(this.data.cupId);
    }
  },

  // 获取卡牌信息及解锁状态
  fetchCardStatus(cupId) {
    wx.cloud.callFunction({ 
      name: 'unlockCard', 
      data: { cupId, checkOnly: true } 
    })
      .then(({ result }) => {
        if (!result || !result.success) {
          this.setData({ 
            loading: false, 
            error: `卡牌不存在 (ID: ${cupId})` 
          });
          return;
        }
        this.setData({
          loading: false,
          card: result.cardInfo,
          unlocked: result.repeat,
        });
      })
      .catch(() => this.setData({ loading: false, error: '网络错误' }));
  },

  // 跳转到 杯子识别 页面进行扫描解锁
  onUnlock() {
    if (this.data.unlocked) return;
    wx.navigateTo({
      url: `/pages/cup-scan/index?cupId=${this.data.cupId}`
    });
  },

  goBack() {
    wx.switchTab({
      url: '/pages/profile/index'
    });
  }
});
