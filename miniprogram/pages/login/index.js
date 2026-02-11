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
    wx.showLoading({ title: '同步中...' });

    const finish = (finalAvatarUrl) => {
      wx.cloud.callFunction({ 
        name: 'updateUser', 
        data: { avatarUrl: finalAvatarUrl, nickname } 
      }).then(() => {
        wx.hideLoading();
        wx.navigateTo({ url: '/pages/loading/index' });
      });
    };

    const uploadAvatar = () => {
      // 如果是临时路径，则上传
      if (avatarUrl.startsWith('http://tmp') || avatarUrl.startsWith('wxfile://tmp')) {
        const cloudPath = `avatars/${Date.now()}-${Math.floor(Math.random() * 1000)}.png`;
        wx.cloud.uploadFile({
          cloudPath,
          filePath: avatarUrl,
          success: res => finish(res.fileID),
          fail: err => {
            wx.hideLoading();
            wx.showToast({ title: '头像上传失败', icon: 'none' });
          }
        });
      } else {
        finish(avatarUrl);
      }
    };

    if (!this.data.logged) {
      wx.cloud.callFunction({ name: 'login' }).then((r) => {
        wx.setStorageSync('openid', r.result.openid);
        this.setData({ logged: true });
        uploadAvatar();
      });
    } else {
      uploadAvatar();
    }
  },
});
