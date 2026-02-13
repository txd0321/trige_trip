Component({
  data: {
    selected: 0,
    color: "#999999",
    selectedColor: "#87CEFA",
    list: [{
      pagePath: "/pages/home/index",
      iconPath: "/images/icons/home.png",
      selectedIconPath: "/images/icons/home-active.png",
      text: "精灵"
    }, {
      pagePath: "/pages/profile/index",
      iconPath: "/images/icons/usercenter.png",
      selectedIconPath: "/images/icons/usercenter-active.png",
      text: "我的"
    }]
  },
  methods: {
    switchTab(e) {
      const data = e.currentTarget.dataset
      const url = data.path
      wx.switchTab({
        url: url
      })
    }
  }
})
