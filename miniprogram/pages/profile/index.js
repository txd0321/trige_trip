// pages/profile/index.js
Page({
  data: {
    user: {
      avatarUrl: '',
      nickname: '',
    },
    summary: { unlocked: 0, total: 0 },
  },
  onShow() {
    this.fetchProfile();
  },
  fetchProfile() {
    const db = wx.cloud.database();
    wx.cloud.callFunction({ name: 'getProfile' })
      .then((res) => this.setData({ user: res.result }))
      .catch(() => {});
    db.collection('cards').count().then((res) => this.setData({ 'summary.total': res.total }));
    const openid = wx.getStorageSync('openid') || '';
    if (openid) {
      db.collection('user_cards').where({ _openid: openid }).count().then((res) => this.setData({ 'summary.unlocked': res.total }));
    }
  },
  // 选头像
  onChooseAvatar(e) {
    const avatarUrl = e.detail.avatarUrl;
    this.updateUser({ avatarUrl });
  },
  // 点昵称
  onNicknameTap() {
    wx.getUserProfile({
      desc: '获取微信昵称',
      success: (res) => {
        const nickname = res.userInfo.nickName;
        this.updateUser({ nickname });
      },
    });
  },
  updateUser(updateData) {
    wx.cloud
      .callFunction({
        name: 'updateUser',
        data: updateData,
      })
      .then(() => {
        this.setData({ user: { ...this.data.user, ...updateData } });
      });
  },
});
