const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  try {
    const { OPENID } = cloud.getWXContext();
    const samples = Array.isArray(event.samples) ? event.samples : [];
    if (!samples.length) return { success: true, saved: 0 };

    const scene = event.scene || 'ar_scan';
    const source = event.source || 'manual_collect';
    const now = Date.now();

    const tasks = samples.slice(0, 200).map((item) => {
      return db.collection('shape_samples').add({
        data: {
          openid: OPENID,
          scene,
          source,
          tag: item.tag || 'unknown',
          labels: item.labels || [],
          confidences: item.confidences || [],
          patches: item.patches || [],
          tuneParams: item.tuneParams || {},
          ts: item.ts || now,
          createdAt: now,
        },
      });
    });

    const res = await Promise.allSettled(tasks);
    const failed = res.filter((r) => r.status === 'rejected');
    const saved = res.length - failed.length;

    if (failed.length) {
      const firstError = failed[0] && failed[0].reason;
      return {
        success: saved > 0,
        saved,
        failed: failed.length,
        message: firstError && (firstError.message || String(firstError)) || 'partial save failed',
      };
    }

    return { success: true, saved, failed: 0 };
  } catch (err) {
    return { success: false, message: err.message || 'save samples failed', saved: 0 };
  }
};
