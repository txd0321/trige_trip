// after complete, redirect to loading page
const defaultAvatarUrl = 'https://mmbiz.qpic.cn/mmbiz/icTdbqWNOwNRna42FI242Lcia07jQodd2FJGIYQfG0LAJGFxM4FbnQP6yfMxBgJ0F3YRqJCJ1aPAK2dQagdusBZg/0';
Page({
  data: {
    userInfo: { avatarUrl: defaultAvatarUrl, nickName: '' },
    avatarReady: false,
    nameReady: false,
    logged: false,
  },
  onChooseAvatar(e) {
    this.setData({ 'userInfo.avatarUrl': e.detail.avatarUrl, avatarReady: true });
  },
  onNicknameTap() {
    if (this.data.nameReady) return;
    wx.getUserProfile({ desc: '获取微信昵称', success: (r) => this.setData({ 'userInfo.nickName': r.userInfo.nickName, nameReady: true }) });
  },
  onInputChange(e) {
    const v = e.detail.value; this.setData({ 'userInfo.nickName': v, nameReady: !!v });
  },
  onCompleteTap() {
    if (!(this.data.avatarReady && this.data.nameReady)) return;
    const { avatarUrl, nickName } = this.data.userInfo;
    const finish = () => {
      wx.cloud.callFunction({ name: 'updateUser', data: { avatarUrl, nickname: nickName } });
      wx.navigateTo({ url: '/pages/loading/index' });
    };
    if (!this.data.logged) {
      wx.cloud.callFunction({ name: 'login' }).then((r) => { wx.setStorageSync('openid', r.result.openid); this.setData({ logged: true }); finish(); });
    } else finish();
  },
});
