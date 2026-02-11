Page({
  data: {
    isScanning: false
  },

  // 扫码回调
  onScanCode(e) {
    if (this.data.isScanning) return;
    
    const { result } = e.detail;
    if (result) {
      this.setData({ isScanning: true });
      
      // 模拟解析结果：假设二维码内容就是 cardId
      // 实际应用中可以根据您的二维码格式进行解析
      const cardId = result;

      wx.showLoading({ title: '识别成功' });
      
      setTimeout(() => {
        wx.hideLoading();
        // 跳转到对应的卡牌详情页，并携带 cupId
        wx.navigateTo({
          url: `/pages/card/detail?cupId=${cardId}`,
          fail: () => {
            wx.showToast({ title: '无效的卡牌信息', icon: 'none' });
            this.setData({ isScanning: false });
          }
        });
      }, 500);
    }
  },

  goBack() {
    wx.navigateBack();
  }
});
