Page({
  data: {
    recognizing: false,
    cupId: ''
  },

  onLoad(options) {
    if (options.cupId) {
      this.setData({ cupId: options.cupId });
    }
  },

  onReady() {
    // 模拟识别过程
    this.setData({ recognizing: true });
    
    // 模拟 3 秒后识别成功
    setTimeout(() => {
      this.doUnlock();
    }, 3000);
  },

  doUnlock() {
    if (!this.data.cupId) return;

    wx.showLoading({ title: '匹配成功' });
    
    wx.cloud.callFunction({
      name: 'unlockCard',
      data: { cupId: this.data.cupId }
    }).then(res => {
      wx.hideLoading();
      if (res.result && res.result.success) {
        wx.showToast({ title: '卡牌已解锁', icon: 'success' });
        // 延迟返回，让用户看清成功提示
        setTimeout(() => {
          wx.navigateBack();
        }, 1500);
      } else {
        wx.showToast({ title: '解锁失败', icon: 'none' });
        setTimeout(() => wx.navigateBack(), 1500);
      }
    }).catch(err => {
      wx.hideLoading();
      wx.showToast({ title: '网络错误', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 1500);
    });
  },

  goBack() {
    wx.navigateBack();
  },

  error(e) {
    console.error('相机授权失败', e.detail);
    wx.showModal({
      title: '提示',
      content: '需要相机权限才能进行识别',
      showCancel: false,
      success: () => wx.navigateBack()
    });
  }
});
