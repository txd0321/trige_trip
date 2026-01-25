const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  const { avatarUrl, nickname } = event
  console.log('updateUser params', { avatarUrl, nickname })

  if (!avatarUrl || !nickname) {
    return { success: false, error: 'param missing' }
  }

  const updateRes = await db.collection('users').where({ _openid: OPENID }).update({
    data: { avatarUrl, nickname },
  })
  console.log('update result', updateRes)

  if (updateRes.stats.updated === 0) {
    const addRes = await db.collection('users').add({
      data: { _openid: OPENID, avatarUrl, nickname, createdAt: db.serverDate() },
    })
    console.log('add result', addRes)
  }

  return { success: true }
}
