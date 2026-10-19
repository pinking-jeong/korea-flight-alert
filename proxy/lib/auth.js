/**
 * PIN 검증과 추측 잠금
 * - PIN 값은 Vercel 환경변수 ACCESS_PIN 에만 둔다 (공개 저장소·페이지 코드에는 없다).
 * - 네 자리 PIN 은 경우의 수가 1만 개뿐이라, 틀린 횟수로 잠근다:
 *   한 IP 가 15분 안에 5번 틀리면 그 IP 를 15분, 모든 IP 를 합쳐 10분 안에 30번 틀리면 PIN 입력 전체를 10분 막는다.
 * - 잠금 기록은 함수 인스턴스 메모리에 있다 (인스턴스가 바뀌면 초기화) — 지키는 것은 무료 API 한도뿐이라 이 정도로 둔다.
 */
const crypto = require('crypto');

const IP_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES_PER_IP = 5;
const IP_LOCK_MS = 15 * 60 * 1000;
const GLOBAL_WINDOW_MS = 10 * 60 * 1000;
const MAX_GLOBAL_FAILURES = 30;
const GLOBAL_LOCK_MS = 10 * 60 * 1000;
const MAX_TRACKED_IPS = 5000;

function digest(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest();
}

// 길이가 같은 해시끼리 비교해 비교 시간으로 PIN 이 새지 않게 한다
function pinMatches(candidate, pin) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  return crypto.timingSafeEqual(digest(candidate), digest(pin));
}

function createPinGuard({ pin, now = Date.now }) {
  const failuresByIp = new Map();
  let globalFailures = [];
  let globalLockedUntil = 0;

  function lockedResult(untilMs) {
    return { ok: false, status: 429, retryAfterSec: Math.max(1, Math.ceil((untilMs - now()) / 1000)) };
  }

  function forgetOldIps() {
    if (failuresByIp.size <= MAX_TRACKED_IPS) return;
    const t = now();
    for (const [ip, entry] of failuresByIp) {
      if (entry.lockedUntil <= t && t - entry.firstAt > IP_WINDOW_MS) failuresByIp.delete(ip);
    }
  }

  // 기록용으로 이번 실패까지의 횟수와 이번에 건 잠금('ip'·'global')을 돌려준다
  function recordFailure(ip) {
    const t = now();
    const entry = failuresByIp.get(ip);
    const fresh = !entry || t - entry.firstAt > IP_WINDOW_MS;
    const count = fresh ? 1 : entry.count + 1;
    const ipLocked = count >= MAX_FAILURES_PER_IP;
    failuresByIp.set(ip, {
      count,
      firstAt: fresh ? t : entry.firstAt,
      lockedUntil: ipLocked ? t + IP_LOCK_MS : fresh ? 0 : entry.lockedUntil
    });
    forgetOldIps();

    globalFailures = [...globalFailures.filter((at) => t - at <= GLOBAL_WINDOW_MS), t];
    const recentFailures = globalFailures.length;
    const globalLocked = recentFailures >= MAX_GLOBAL_FAILURES;
    if (globalLocked) {
      globalLockedUntil = t + GLOBAL_LOCK_MS;
      globalFailures = [];
    }
    return { ipFailures: count, recentFailures, lock: globalLocked ? 'global' : ipLocked ? 'ip' : null };
  }

  function check(ip, candidate) {
    if (!pin) return { ok: false, status: 503 };
    const t = now();
    if (globalLockedUntil > t) return lockedResult(globalLockedUntil);
    const entry = failuresByIp.get(ip);
    if (entry && entry.lockedUntil > t) return lockedResult(entry.lockedUntil);

    if (pinMatches(candidate, pin)) {
      failuresByIp.delete(ip);
      return { ok: true };
    }
    return { ok: false, status: 401, ...recordFailure(ip) };
  }

  return { check };
}

// 기록용 IP 표시 — 함수 인스턴스마다 새 무작위 키로 HMAC 을 만들어, 기록만 보고는 IP 를 되찾을 수 없게 한다
function createIpTagger() {
  const key = crypto.randomBytes(32);
  return (ip) => crypto.createHmac('sha256', key).update(String(ip)).digest('hex').slice(0, 12);
}

function clientIpOf(req) {
  const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  if (forwarded) return forwarded;
  const real = String(req.headers?.['x-real-ip'] || '').trim();
  if (real) return real;
  return req.socket?.remoteAddress || 'unknown';
}

module.exports = { createPinGuard, clientIpOf, createIpTagger };
