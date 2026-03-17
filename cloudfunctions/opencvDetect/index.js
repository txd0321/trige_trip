const cloud = require('wx-server-sdk');
const https = require('https');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: 4000,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          const parsed = body ? JSON.parse(body) : {};
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
            return;
          }
          reject(new Error(`opencv api status ${res.statusCode}`));
        }catch (err) {
          reject(err);
        }
      });
    });

    req.on('timeout', () => req.destroy(new Error('opencv api timeout')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

exports.main = async (event) => {
  try {
    const apiUrl = process.env.OPENCV_API_URL;
    if (!apiUrl) {
      return { success: false, message: 'missing OPENCV_API_URL env' };
    }

    const payload = {
      imageBase64: event.imageBase64 || event.roiGray,
      roiGray: event.roiGray,
      roiWidth: event.roiWidth,
      roiHeight: event.roiHeight,
      roi: event.roi,
      seq: event.seq,
      timestamp: event.timestamp,
      thresholdHint: event.thresholdHint,
      scene: event.scene || 'ar_scan',
    };

    const result = await postJson(apiUrl, payload);
    return { success: true, result };
  }catch (err) {
    return { success: false, message: err.message || 'opencv detect failed' };
  }
};
