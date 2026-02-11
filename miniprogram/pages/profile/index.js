// pages/profile/index.js
Page({
  data: {
    debugFullState: false, // 【调试开关】设为 true 预览“已获得”状态，设为 false 预览“未获得”状态
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
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({
        selected: 1
      })
    }
    this.fetchProfile();
  },
  fetchProfile() {
    // --- 调试模式：展示全集齐状态 ---
    if (this.data.debugFullState) {
      this.setData({
        userCards: [
          { _id: 'mock1', name: 'CUPI', image: 'https://miniapp-assets-cupi-1327655007.cos.ap-guangzhou.myqcloud.com/ui/logo.png' },
          { _id: 'mock2', name: '猫咪老师', image: 'https://miniapp-assets-cupi-1327655007.cos.ap-guangzhou.myqcloud.com/ui/logo.png' },
          { _id: 'mock3', name: '夏目', image: 'https://miniapp-assets-cupi-1327655007.cos.ap-guangzhou.myqcloud.com/ui/logo.png' }
        ],
        achievements: [
          { id: 1, name: '啦啦啦啦', icon: 'https://mmbiz.qpic.cn/mmbiz/icTdbqWNOwNRna42FI242Lcia07jQodd2FJGIYQfG0LAJGFxM4FbnQP6yfMxBgJ0F3YRqJCJ1aPAK2dQagdusBZg/0' },
          { id: 2, name: '愿望实现', icon: 'https://mmbiz.qpic.cn/mmbiz/icTdbqWNOwNRna42FI242Lcia07jQodd2FJGIYQfG0LAJGFxM4FbnQP6yfMxBgJ0F3YRqJCJ1aPAK2dQagdusBZg/0' },
          { id: 3, name: '生日快乐', icon: 'https://mmbiz.qpic.cn/mmbiz/icTdbqWNOwNRna42FI242Lcia07jQodd2FJGIYQfG0LAJGFxM4FbnQP6yfMxBgJ0F3YRqJCJ1aPAK2dQagdusBZg/0' }
        ],
        'summary.unlocked': 3,
        'summary.total': 3
      });
      return;
    }

    // --- 真实模式：从数据库获取数据 ---
    const db = wx.cloud.database();
    
    // 1. 获取用户信息（头像、昵称）
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
      });

    // 2. 获取总卡牌数
    db.collection('cards').count().then((res) => this.setData({ 'summary.total': res.total || 0 }));
    
    const openid = wx.getStorageSync('openid') || '';
    if (openid) {
      // 3. 获取用户已解锁卡牌数量
      db.collection('user_cards').where({ _openid: openid }).count().then((res) => {
        const unlockedCount = res.total;
        this.setData({ 'summary.unlocked': unlockedCount });

        // 核心逻辑：如果没有卡牌，强制清空成就
        if (unlockedCount === 0) {
          this.setData({ achievements: [] });
        }
      });

      // 4. 获取用户已解锁卡牌的具体列表
      db.collection('user_cards').where({ _openid: openid }).get().then(res => {
        const cardIds = res.data.map(uc => uc.cardId);
        if (cardIds.length > 0) {
          db.collection('cards').where({
            _id: db.command.in(cardIds)
          }).get().then(cardsRes => {
            this.setData({ userCards: cardsRes.data });
          });
        } else {
          this.setData({ userCards: [] });
        }
      });
    }
  },
  onAbout() {
    wx.navigateTo({ url: '/pages/about/index' });
  },
  onFeedback() {
    wx.navigateTo({ url: '/pages/feedback/index' });
  },
  onAddCard() {
    wx.navigateTo({
      url: '/pages/scan/index'
    });
  },
  onCardTap(e) {
    const cupId = e.currentTarget.dataset.id;
    if (cupId) {
      wx.navigateTo({
        url: `/pages/card/detail?cupId=${cupId}`
      });
    }
  },
  onLockedAchievementTap() {
    wx.showModal({
      title: '提示',
      content: '请先解锁卡牌',
      showCancel: false,
      confirmText: '我知道了'
    });
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
    wx.showLoading({ title: '上传中...' });
    
    const cloudPath = `avatars/${Date.now()}-${Math.floor(Math.random() * 1000)}.png`;
    wx.cloud.uploadFile({
      cloudPath,
      filePath: avatarUrl,
      success: res => {
        this.updateUser({ avatarUrl: res.fileID });
      },
      fail: err => {
        wx.hideLoading();
        wx.showToast({ title: '头像上传失败', icon: 'none' });
      }
    });
  },
  updateUser(updateData) {
    wx.cloud
      .callFunction({
        name: 'updateUser',
        data: updateData,
      })
      .then(() => {
        wx.hideLoading();
        this.setData({ user: { ...this.data.user, ...updateData } });
        wx.showToast({ title: '修改成功', icon: 'success' });
      })
      .catch(() => {
        wx.hideLoading();
        wx.showToast({ title: '更新失败', icon: 'none' });
      });
  },
});
