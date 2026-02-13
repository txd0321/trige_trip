Page({
  onLoad(){
    console.log('>>> [Loading] onLoad 开始');
    setTimeout(()=>{
      console.log('>>> [Loading] 准备跳转到 Home');
      wx.switchTab({url:'/pages/home/index'});
    },3000);
  }
})
