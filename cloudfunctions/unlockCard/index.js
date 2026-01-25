const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  const { cupId } = event;
  if (!cupId) return { success: false, error: 'missing cupId' };

  // 1. 找到卡牌
  const cardRes = await db.collection('cards').where({ cupType: cupId }).limit(1).get();
  if (!cardRes.data.length) return { success: false, error: 'card not found' };
  const card = cardRes.data[0];

  // 2. 判断是否已解锁
  const userCardCol = db.collection('user_cards');
  const exist = await userCardCol.where({ _openid: OPENID, cardId: card._id }).count();
  if (exist.total) {
    return { success: true, repeat: true, cardInfo: card };
  }

  // 3. 写入解锁记录
  await userCardCol.add({ data: { _openid: OPENID, cardId: card._id, unlockedAt: db.serverDate() } });
  return { success: true, repeat: false, cardInfo: card };
};
