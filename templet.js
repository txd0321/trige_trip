// 获取应用实例，用于全局状态（如有）
const app = getApp()
// 默认头像URL，用于未登录时的占位显示
const defaultAvatarUrl = 'https://mmbiz.qpic.cn/mmbiz/icTdbqWNOwNRna42FI242Lcia07jQodd2FJGIYQfG0LAJGFxM4FbnQP6yfMxBgJ0F3YRqJCJ1aPAK2dQagdusBZg/0'

Page({
  data: {
    userInfo: {
      avatarUrl: defaultAvatarUrl,
      nickName: '点击登录',
    },
    // 用于控制UI显示状态
    hasUserInfo: false,
    isLoading: false,
    // 能力检测，决定使用哪种获取用户信息的方式
    canIUseGetUserProfile: wx.canIUse('getUserProfile'),
    canIUseNicknameComp: wx.canIUse('input.type.nickname'),
  },

  onLoad() {
    // 页面加载时，检查本地是否有登录态
    this.checkLocalLoginStatus();
  },

  // 检查本地存储的登录状态
  checkLocalLoginStatus() {
    const openid = wx.getStorageSync('openid');
    const storedUserInfo = wx.getStorageSync('userInfo');
    if (openid && storedUserInfo) {
      this.setData({
        hasUserInfo: true,
        userInfo: storedUserInfo
      });
    }
  },

  // 核心：一键登录（静默获取OpenID）
  handleLoginTap() {
    if (this.data.isLoading) return;

    this.setData({ isLoading: true });
    wx.showLoading({ title: '登录中...' });

    // 调用云开发 login 云函数
    wx.cloud.callFunction({
      name: 'login',
      success: res => {
        console.log('云函数登录成功:', res.result);
        const openid = res.result.openid;

        // 1. 将用户唯一标识存入缓存（后续所有功能的基础）
        wx.setStorageSync('openid', openid);

        // 2. 更新页面状态，标记为已登录
        // 注意：此时只有openid，没有头像昵称，所以hasUserInfo仍为false
        this.setData({
          isLoading: false,
          // hasUserInfo: true // 这里不设为true，等用户主动完善信息
        });

        wx.hideLoading();
        wx.showToast({
          title: '登录成功',
          icon: 'success',
          duration: 1500
        });

        // 3. 登录成功后，可以跳转到主页或留在本页提示完善信息
        // wx.switchTab({
        //   url: '/pages/index/index' // 假设这是你的精灵之家主页
        // });

      },
      fail: err => {
        console.error('云函数登录失败:', err);
        this.setData({ isLoading: false });
        wx.hideLoading();
        wx.showToast({
          title: '登录失败',
          icon: 'none'
        });
      }
    });
  },

  // 以下为完善个人信息的功能（用户可主动触发）
  // 选择头像事件
  onChooseAvatar(e) {
    const { avatarUrl } = e.detail;
    this.setData({
      'userInfo.avatarUrl': avatarUrl,
    });
    // 检查是否同时有头像和昵称，来决定是否可以显示完整信息
    this.checkUserInfoComplete();
  },

  // 输入昵称事件
  onInputChange(e) {
    const nickName = e.detail.value;
    this.setData({
      'userInfo.nickName': nickName,
    });
    this.checkUserInfoComplete();
  },

  // 检查头像和昵称是否都已填写
  checkUserInfoComplete() {
    const { avatarUrl, nickName } = this.data.userInfo;
    const isComplete = nickName && avatarUrl && avatarUrl !== defaultAvatarUrl;
    this.setData({
      hasUserInfo: isComplete
    });
    // 如果信息完整，可以保存到本地和云端
    if (isComplete) {
      this.saveUserProfile();
    }
  },

  // 保存用户资料到缓存和云端
  saveUserProfile() {
    const userInfo = this.data.userInfo;
    wx.setStorageSync('userInfo', userInfo);

    // 可选：调用云函数，将头像昵称更新到云数据库 users 集合中
    const openid = wx.getStorageSync('openid');
    if (openid) {
      wx.cloud.callFunction({
        name: 'updateUserProfile', // 你需要创建这个云函数
        data: {
          userInfo: userInfo
        }
      });
    }
  },

  // 旧的获取用户信息接口（已不推荐主动弹窗，保留作为参考）
  getUserProfile() {
    wx.getUserProfile({
      desc: '用于完善个人资料',
      success: (res) => {
        console.log('getUserProfile 成功:', res.userInfo);
        this.setData({
          userInfo: res.userInfo,
          hasUserInfo: true
        });
        this.saveUserProfile();
      }
    });
  },
})