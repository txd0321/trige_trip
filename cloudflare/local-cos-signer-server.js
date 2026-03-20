import crypto from 'crypto';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`);
  });
  next();
});

const PORT = Number(process.env.PORT || 8080);
const BUCKET = process.env.BUCKET || 'miniapp-assets-cupi-1327655007';
const REGION = process.env.REGION || 'ap-guangzhou';
const SECRET_ID = process.env.TENCENT_SECRET_ID || '';
const SECRET_KEY = process.env.TENCENT_SECRET_KEY || '';
const ROBOFLOW_API_KEY = process.env.ROBOFLOW_API_KEY || '';
const ROBOFLOW_MODEL = process.env.ROBOFLOW_MODEL || '';
const ROBOFLOW_VERSION = process.env.ROBOFLOW_VERSION || '';

function sha1Hex(content) {
  return crypto.createHash('sha1').update(content).digest('hex');
}

function hmacSha1Hex(content, key) {
  return crypto.createHmac('sha1', key).update(content).digest('hex');
}

function safeClassName(name) {
  return String(name || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function safeExt(ext) {
  const v = String(ext || 'jpg').replace(/[^a-zA-Z0-9]/g, '');
  return v || 'jpg';
}

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, service: 'cos-signer-local' });
});

app.get('/api/cos/sign-upload', (req, res) => {
  if (!SECRET_ID || !SECRET_KEY) {
    res.status(500).json({ error: 'Missing TENCENT_SECRET_ID or TENCENT_SECRET_KEY' });
    return;
  }

  const className = safeClassName(req.query.className);
  const ext = safeExt(req.query.ext);

  const now = Math.floor(Date.now() / 1000);
  const start = now - 5;
  const end = now + 15 * 60;
  const qSignTime = `${start};${end}`;
  const qKeyTime = qSignTime;

  const rand = Math.random().toString(36).slice(2, 10);
  const key = `pattern-collector/${className}/${Date.now()}_${rand}.${ext}`;

  const encodedPath = '/' + key.split('/').map((s) => encodeURIComponent(s)).join('/');
  const host = `${BUCKET}.cos.${REGION}.myqcloud.com`;

  const httpString = `put\n${encodedPath}\n\nhost=${host}\n`;
  const httpStringSha1 = sha1Hex(httpString);

  const signKey = hmacSha1Hex(qKeyTime, SECRET_KEY);
  const stringToSign = `sha1\n${qSignTime}\n${httpStringSha1}\n`;
  const signature = hmacSha1Hex(stringToSign, signKey);

  const authorization = [
    'q-sign-algorithm=sha1',
    `q-ak=${encodeURIComponent(SECRET_ID)}`,
    `q-sign-time=${qSignTime}`,
    `q-key-time=${qKeyTime}`,
    'q-header-list=host',
    'q-url-param-list=',
    `q-signature=${signature}`,
  ].join('&');

  const uploadUrl = `https://${host}${encodedPath}?${authorization}`;
  const fileUrl = `https://${host}${encodedPath}`;

  res.json({
    uploadUrl,
    key,
    fileUrl,
    expiresAt: end,
    bucket: BUCKET,
    region: REGION,
  });
});

app.post('/api/infer', async (req, res) => {
  if (!ROBOFLOW_API_KEY || !ROBOFLOW_MODEL || !ROBOFLOW_VERSION) {
    res.status(500).json({
      error: 'Missing ROBOFLOW_API_KEY or ROBOFLOW_MODEL or ROBOFLOW_VERSION',
    });
    return;
  }

  const imageBase64 = req.body?.imageBase64;
  if (!imageBase64) {
    res.status(400).json({ error: 'Missing imageBase64' });
    return;
  }

  const endpoint = `https://serverless.roboflow.com/${ROBOFLOW_MODEL}/${ROBOFLOW_VERSION}?api_key=${encodeURIComponent(
    ROBOFLOW_API_KEY
  )}&confidence=0&overlap=100`;

  const maxAttempts = 3;
  const timeoutMs = 12000;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const rfRes = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: imageBase64,
        signal: controller.signal,
      });

      clearTimeout(timer);

      const text = await rfRes.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }

      if (!rfRes.ok) {
        const msg = `[infer] Roboflow non-2xx attempt ${attempt}/${maxAttempts}: ${rfRes.status}`;
        console.error(msg, data);

        if (attempt < maxAttempts && rfRes.status >= 500) {
          await new Promise((r) => setTimeout(r, 300 * attempt));
          continue;
        }

        res.status(rfRes.status).json({ error: 'Roboflow infer failed', attempt, detail: data });
        return;
      }

      let normalizedLabel = null;
      let normalizedConfidence = 0;

      if (Array.isArray(data?.predictions) && data.predictions.length) {
        let top = data.predictions[0];
        for (let i = 1; i < data.predictions.length; i += 1) {
          if ((data.predictions[i]?.confidence || 0) > (top?.confidence || 0)) {
            top = data.predictions[i];
          }
        }
        normalizedLabel = top?.class || top?.label || null;
        normalizedConfidence = Number(top?.confidence || 0);
      } else if (data?.predictions && typeof data.predictions === 'object') {
        Object.keys(data.predictions).forEach((k) => {
          const score = Number(data.predictions[k] || 0);
          if (score > normalizedConfidence) {
            normalizedConfidence = score;
            normalizedLabel = k;
          }
        });
      }

      if (!normalizedLabel && Array.isArray(data?.predicted_classes) && data.predicted_classes.length) {
        normalizedLabel = data.predicted_classes[0]?.class || data.predicted_classes[0]?.label || null;
        normalizedConfidence = Number(data.predicted_classes[0]?.confidence || normalizedConfidence || 0);
      }

      if (!normalizedLabel && data?.top) {
        normalizedLabel = data.top;
      }
      if (!normalizedConfidence && data?.confidence) {
        normalizedConfidence = Number(data.confidence || 0);
      }

      console.log('[infer] success keys:', Object.keys(data || {}), 'normalized:', normalizedLabel, normalizedConfidence);

      res.json({
        ...data,
        __normalized: {
          label: normalizedLabel,
          confidence: normalizedConfidence,
        },
      });
      return;
    } catch (err) {
      clearTimeout(timer);
      const lastAttempt = attempt === maxAttempts;
      console.error(`[infer] fetch failed attempt ${attempt}/${maxAttempts}:`, err?.message || err);

      if (!lastAttempt) {
        await new Promise((r) => setTimeout(r, 300 * attempt));
        continue;
      }

      res.status(500).json({
        error: err?.name === 'AbortError' ? 'Infer request timeout' : (err?.message || 'infer failed'),
        attempt,
      });
      return;
    }
  }
});

app.listen(PORT, () => {
  console.log(`COS signer listening on http://localhost:${PORT}`);
});
