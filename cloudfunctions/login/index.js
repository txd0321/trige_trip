// 云函数入口文件
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 云函数入口函数
exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  // NOTE: 这里可扩展为调用你自己的后台生成 token
  return {
    openid: OPENID,
    token: OPENID, // demo: 直接用 openid 作为 token
  }
}
