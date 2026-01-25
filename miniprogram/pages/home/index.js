// pages/home/index.js
Page({
  data: {
    cards: [],
    page: 1,
    total: 0,
    loading: false,
  },
  onLoad() {
    this.loadCards();
  },
  onPullDownRefresh() {
    this.setData({ page: 1, cards: [] });
    this.loadCards(() => wx.stopPullDownRefresh());
  },
  loadMoreCards() {
    if (this.data.cards.length >= this.data.total || this.data.loading) return;
    this.setData({ page: this.data.page + 1 }, this.loadCards);
  },
  loadCards(cb) {
    this.setData({ loading: true });
    const db = wx.cloud.database();
    db.collection('cards')
      .skip((this.data.page - 1) * 20)
      .limit(20)
      .get()
      .then((res) => {
        this.setData({
          cards: this.data.page === 1 ? res.data : this.data.cards.concat(res.data),
          total: res.total || 0,
          loading: false,
        });
        cb && cb();
      })
      .catch(() => {
        wx.showToast({ title: '加载失败', icon: 'none' });
        this.setData({ loading: false });
        cb && cb();
      });
  },
  openCard(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/card/detail?cardId=${id}` });
  },
  goAR() {
    wx.navigateTo({ url: `/pages/ar/index` });
  },
});
