const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  const { avatarUrl, nickname } = event
  console.log('updateUser params', { avatarUrl, nickname })

  // 构建更新对象，只更新传入了的字段
  const updateData = {}
  if (avatarUrl) updateData.avatarUrl = avatarUrl
  if (nickname) updateData.nickname = nickname

  if (Object.keys(updateData).length === 0) {
    return { success: false, error: 'no data to update' }
  }

  // 尝试更新
  const updateRes = await db.collection('users').where({ _openid: OPENID }).update({
    data: updateData,
  })

  // 如果没有记录则新增
  if (updateRes.stats.updated === 0) {
    // 补全默认值
    const newData = {
      _openid: OPENID,
      avatarUrl: avatarUrl || '',
      nickname: nickname || '微信用户',
      createdAt: db.serverDate(),
      ...updateData
    }
    await db.collection('users').add({ data: newData })
  }

  return { success: true }
}
