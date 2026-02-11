const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  const { cupId, checkOnly } = event; // 增加 checkOnly 参数
  if (!cupId) return { success: false, error: 'missing cupId' };

  // 1. 找到卡牌 (支持通过 _id 或 cupType 匹配)
  const _ = db.command;
  const cardRes = await db.collection('cards').where(_.or([
    { _id: cupId },
    { cupType: cupId }
  ])).limit(1).get();
  if (!cardRes.data.length) return { success: false, error: 'card not found' };
  const card = cardRes.data[0];

  // 2. 判断是否已解锁
  const userCardCol = db.collection('user_cards');
  const exist = await userCardCol.where({ _openid: OPENID, cardId: card._id }).count();
  const isUnlocked = exist.total > 0;

  // 3. 如果只是检查或者已经解锁，直接返回
  if (checkOnly || isUnlocked) {
    return { success: true, repeat: isUnlocked, cardInfo: card };
  }

  // 4. 执行写入解锁记录
  await userCardCol.add({ data: { _openid: OPENID, cardId: card._id, unlockedAt: db.serverDate() } });
  return { success: true, repeat: false, cardInfo: card };
};
