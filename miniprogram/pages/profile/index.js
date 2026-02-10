// pages/profile/index.js
Page({
  data: {
    user: {
      avatarUrl: '',
      nickname: '',
      id: '0000000001'
    },
    summary: { unlocked: 0, total: 0 },
    userCards: [],
    achievements: []
  },
  onShow() {
    this.fetchProfile();
  },
  fetchProfile() {
    const db = wx.cloud.database();
    wx.cloud.callFunction({ name: 'getProfile' })
      .then((res) => {
        if (res.result) {
          this.setData({ 
            user: { 
              ...res.result,
              id: res.result.openid ? res.result.openid.slice(-10).toUpperCase() : '0000000001'
            } 
          });
        }
      })
      .catch(() => {});

    // 获取总卡牌数
    db.collection('cards').count().then((res) => this.setData({ 'summary.total': res.total || 1 }));
    
    const openid = wx.getStorageSync('openid') || '';
    if (openid) {
      // 获取用户已解锁卡牌数量
      db.collection('user_cards').where({ _openid: openid }).count().then((res) => {
        this.setData({ 'summary.unlocked': res.total });
      });

      // 获取用户已解锁卡牌的具体列表
      db.collection('user_cards').where({ _openid: openid }).get().then(res => {
        const cardIds = res.data.map(uc => uc.cardId);
        if (cardIds.length > 0) {
          db.collection('cards').where({
            _id: db.command.in(cardIds)
          }).get().then(cardsRes => {
            this.setData({ userCards: cardsRes.data });
          });
        } else {
          // --- 模拟预览数据开始 ---
          // 如果数据库里没有，我们先塞入 3 张模拟卡牌看看效果
          this.setData({
            userCards: [
              { _id: 'mock1', name: 'CUPI', image: 'https://miniapp-assets-cupi-1327655007.cos.ap-guangzhou.myqcloud.com/ui/logo.png' },
              { _id: 'mock2', name: '猫咪老师', image: 'https://miniapp-assets-cupi-1327655007.cos.ap-guangzhou.myqcloud.com/ui/logo.png' },
              { _id: 'mock3', name: '夏目', image: 'https://miniapp-assets-cupi-1327655007.cos.ap-guangzhou.myqcloud.com/ui/logo.png' }
            ],
            'summary.unlocked': 3,
            'summary.total': 3
          });
          // --- 模拟预览数据结束 ---
        }
      });

      // --- 模拟成就数据 ---
      this.setData({
        achievements: [
          { id: 1, name: '啦啦啦啦', icon: 'https://mmbiz.qpic.cn/mmbiz/icTdbqWNOwNRna42FI242Lcia07jQodd2FJGIYQfG0LAJGFxM4FbnQP6yfMxBgJ0F3YRqJCJ1aPAK2dQagdusBZg/0' },
          { id: 2, name: '愿望实现', icon: 'https://mmbiz.qpic.cn/mmbiz/icTdbqWNOwNRna42FI242Lcia07jQodd2FJGIYQfG0LAJGFxM4FbnQP6yfMxBgJ0F3YRqJCJ1aPAK2dQagdusBZg/0' },
          { id: 3, name: '生日快乐', icon: 'https://mmbiz.qpic.cn/mmbiz/icTdbqWNOwNRna42FI242Lcia07jQodd2FJGIYQfG0LAJGFxM4FbnQP6yfMxBgJ0F3YRqJCJ1aPAK2dQagdusBZg/0' }
        ]
      });
    }
  },
  onAbout() {
    wx.navigateTo({ url: '/pages/about/index' });
  },
  onFeedback() {
    wx.navigateTo({ url: '/pages/feedback/index' });
  },
  // 修改昵称
  onNicknameTap() {
    wx.showModal({
      title: '修改昵称',
      editable: true,
      placeholderText: '请输入新昵称',
      content: this.data.user.nickname || '',
      success: (res) => {
        if (res.confirm && res.content) {
          this.updateUser({ nickname: res.content });
        }
      }
    });
  },
  // 选头像
  onChooseAvatar(e) {
    const avatarUrl = e.detail.avatarUrl;
    this.updateUser({ avatarUrl });
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
