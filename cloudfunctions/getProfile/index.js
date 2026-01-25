const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  const users = db.collection('users')

  // 1. 取该用户最新一条记录
  const record = await users
    .where({ _openid: OPENID })
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get()

  if (record.data.length) {
    return record.data[0]
  }

  // 2. 若不存在则创建空白记录
  const newUser = {
    avatarUrl: '',
    nickname: '',
    createdAt: db.serverDate(),
  }
  await users.add({ data: newUser })
  return { ...newUser, _openid: OPENID }
}
