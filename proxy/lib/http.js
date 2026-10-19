/**
 * 응답·CORS 공통 처리
 * - PIN 이 필요한 응답이므로 CDN·브라우저 캐시에 남기지 않는다 (no-store).
 * - 허용 목록에 없는 브라우저 출처는 실제 API 를 부르기 전에 403 으로 끊는다.
 */
const DEFAULT_ALLOWED_ORIGINS = ['https://pinking-jeong.github.io', 'http://localhost:3000', 'http://127.0.0.1:3000'];

function parseAllowedOrigins(value) {
  const list = String(value || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return list.length ? list : DEFAULT_ALLOWED_ORIGINS;
}

// Vercel 함수와 일반 Node http 서버(로컬 개발·E2E)에서 모두 쓰도록 statusCode 를 직접 정한다
function sendJson(res, status, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.statusCode = status;
  res.end(JSON.stringify(body));
  return res;
}

// 처리를 여기서 끝냈으면 true (사전 요청이거나 허용되지 않은 출처)
function applyCors(req, res, allowedOrigins) {
  const origin = req.headers?.origin;
  res.setHeader('Vary', 'Origin');
  if (origin && !allowedOrigins.includes(origin)) {
    sendJson(res, 403, { error: '허용되지 않은 출처입니다.' });
    return true;
  }
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Access-Pin');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true;
  }
  return false;
}

module.exports = { DEFAULT_ALLOWED_ORIGINS, parseAllowedOrigins, sendJson, applyCors };
