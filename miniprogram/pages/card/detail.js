Page({
  data: { loading: true, error: '', card: {}, repeat: false },
  onLoad(options) {
    const cupId = options.cupId || '';
    if (!cupId) return this.setData({ loading: false, error: '缺少 cupId' });
    wx.cloud.callFunction({ name: 'unlockCard', data: { cupId } })
      .then(({ result }) => {
        if (!result.success) {
          this.setData({ loading: false, error: result.error || '解锁失败' });
          return;
        }
        this.setData({
          loading: false,
          card: result.cardInfo,
          repeat: result.repeat,
        });
      })
      .catch(() => this.setData({ loading: false, error: '网络错误' }));
  },
});
