// Cloudflare Worker: sign COS PUT upload URL for WeChat Mini Program
// Deploy this worker and set secrets:
// wrangler secret put TENCENT_SECRET_ID
// wrangler secret put TENCENT_SECRET_KEY
// Optional vars: ALLOWED_ORIGIN, BUCKET, REGION

function hmacSha1Hex(message, secret) {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  ).then((key) => crypto.subtle.sign('HMAC', key, enc.encode(message))).then((buf) => {
    const arr = new Uint8Array(buf);
    return [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');
  });
}

async function sha1Hex(content) {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-1', enc.encode(content));
  const arr = new Uint8Array(buf);
  return [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeClassName(name) {
  return String(name || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function buildCorsHeaders(origin, allowedOrigin = '*') {
  return {
    'Access-Control-Allow-Origin': allowedOrigin === '*' ? '*' : origin || allowedOrigin,
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const corsHeaders = buildCorsHeaders(origin, env.ALLOWED_ORIGIN || '*');

    if (request.method === 'OPTIONS') {
      return new Response('', { status: 204, headers: corsHeaders });
    }

    if (url.pathname !== '/api/cos/sign-upload') {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    if (request.method !== 'GET') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    const bucket = env.BUCKET || 'miniapp-assets-cupi-1327655007';
    const region = env.REGION || 'ap-guangzhou';
    const secretId = env.TENCENT_SECRET_ID;
    const secretKey = env.TENCENT_SECRET_KEY;

    if (!secretId || !secretKey) {
      return new Response(JSON.stringify({ error: 'Worker secret not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    const className = safeClassName(url.searchParams.get('className'));
    const ext = (url.searchParams.get('ext') || 'jpg').replace(/[^a-zA-Z0-9]/g, '') || 'jpg';
    const now = Math.floor(Date.now() / 1000);
    const expireSeconds = 15 * 60;
    const start = now - 5;
    const end = now + expireSeconds;

    const rand = Math.random().toString(36).slice(2, 10);
    const key = `pattern-collector/${className}/${Date.now()}_${rand}.${ext}`;

    const encodedPath = '/' + key.split('/').map((s) => encodeURIComponent(s)).join('/');
    const host = `${bucket}.cos.${region}.myqcloud.com`;

    const qSignTime = `${start};${end}`;
    const qKeyTime = qSignTime;
    const qHeaderList = 'host';
    const qUrlParamList = '';

    const httpString = `put\n${encodedPath}\n\nhost=${host}\n`;
    const httpStringSha1 = await sha1Hex(httpString);

    const signKey = await hmacSha1Hex(qKeyTime, secretKey);
    const stringToSign = `sha1\n${qSignTime}\n${httpStringSha1}\n`;
    const signature = await hmacSha1Hex(stringToSign, signKey);

    const authorization = [
      'q-sign-algorithm=sha1',
      `q-ak=${encodeURIComponent(secretId)}`,
      `q-sign-time=${qSignTime}`,
      `q-key-time=${qKeyTime}`,
      `q-header-list=${qHeaderList}`,
      `q-url-param-list=${qUrlParamList}`,
      `q-signature=${signature}`,
    ].join('&');

    const uploadUrl = `https://${host}${encodedPath}?${authorization}`;
    const fileUrl = `https://${host}${encodedPath}`;

    return new Response(
      JSON.stringify({
        uploadUrl,
        key,
        fileUrl,
        expiresAt: end,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      }
    );
  },
};