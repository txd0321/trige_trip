Page({
  onLoad(){
    setTimeout(()=>{
      wx.switchTab({url:'/pages/home/index'});
    },3000);
  }
})
