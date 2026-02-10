// after complete, redirect to loading page
const defaultAvatarUrl = 'https://mmbiz.qpic.cn/mmbiz/icTdbqWNOwNRna42FI242Lcia07jQodd2FJGIYQfG0LAJGFxM4FbnQP6yfMxBgJ0F3YRqJCJ1aPAK2dQagdusBZg/0';
Page({
  data: {
    avatarUrl: defaultAvatarUrl,
    nickname: '',
    logged: false,
  },
  onChooseAvatar(e) {
    this.setData({
      avatarUrl: e.detail.avatarUrl
    });
  },
  onNicknameBlur(e) {
    this.setData({
      nickname: e.detail.value
    });
  },
  onConfirm() {
    const { avatarUrl, nickname } = this.data;
    if (!nickname) {
      wx.showToast({ title: '请输入昵称', icon: 'none' });
      return;
    }
    const finish = () => {
      wx.cloud.callFunction({ name: 'updateUser', data: { avatarUrl, nickname } });
      wx.navigateTo({ url: '/pages/loading/index' });
    };
    if (!this.data.logged) {
      wx.cloud.callFunction({ name: 'login' }).then((r) => {
        wx.setStorageSync('openid', r.result.openid);
        this.setData({ logged: true });
        finish();
      });
    } else finish();
  },
});
