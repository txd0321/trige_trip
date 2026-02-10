Page({
  data: {
    content: ''
  },
  onInput(e) {
    this.setData({ content: e.detail.value });
  },
  onSubmit() {
    if (!this.data.content.trim()) {
      wx.showToast({ title: '请输入反馈内容', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '提交中...' });
    // 模拟提交
    setTimeout(() => {
      wx.hideLoading();
      wx.showToast({ title: '提交成功', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 1500);
    }, 1000);
  }
});