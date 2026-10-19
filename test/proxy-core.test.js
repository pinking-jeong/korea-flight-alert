/**
 * 실제 운임 프록시(proxy/, Vercel 함수)의 공통 부품: PIN 검증·잠금, CORS, 입력 검증, 캐시
 * - PIN 값은 저장소에 두지 않는다. 테스트는 아무 값('2468')이나 넣어 쓴다.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createPinGuard, clientIpOf, createIpTagger } = require('../proxy/lib/auth');
const { applyCors, parseAllowedOrigins } = require('../proxy/lib/http');
const { parseIata, parseDate, parseIntInRange, parseBool, parseMonth } = require('../proxy/lib/validate');
const { createTtlCache } = require('../proxy/lib/cache');

function clock(start = Date.UTC(2026, 9, 19, 1, 0, 0)) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('PIN 이 맞으면 통과, 틀리면 401, 설정이 없으면 모두 막는다(503)', () => {
  const c = clock();
  const guard = createPinGuard({ pin: '2468', now: c.now });
  assert.deepEqual(guard.check('1.1.1.1', '2468'), { ok: true });
  const wrong = guard.check('1.1.1.1', '0000');
  assert.equal(wrong.ok, false);
  assert.equal(wrong.status, 401);
  assert.equal(guard.check('1.1.1.1', '').status, 401, '빈 PIN');
  assert.equal(guard.check('1.1.1.1', undefined).status, 401, 'PIN 없음');

  const unset = createPinGuard({ pin: '', now: c.now });
  assert.equal(unset.check('1.1.1.1', '').status, 503);
  assert.equal(unset.check('1.1.1.1', '2468').status, 503);
});

test('한 IP 가 5번 틀리면 15분 잠기고(맞는 PIN 도 거절), 다른 IP 는 그대로 쓸 수 있다', () => {
  const c = clock();
  const guard = createPinGuard({ pin: '2468', now: c.now });
  const results = [];
  for (let i = 0; i < 5; i += 1) results.push(guard.check('9.9.9.9', String(1000 + i)));
  assert.deepEqual(results.map((r) => r.status), [401, 401, 401, 401, 401]);
  assert.deepEqual(results.map((r) => r.ipFailures), [1, 2, 3, 4, 5], '기록용 실패 횟수');
  assert.deepEqual(results.map((r) => r.lock), [null, null, null, null, 'ip'], '5번째에 그 IP 를 잠금');

  const locked = guard.check('9.9.9.9', '2468');
  assert.equal(locked.status, 429);
  assert.ok(locked.retryAfterSec > 0 && locked.retryAfterSec <= 15 * 60);
  assert.deepEqual(guard.check('8.8.8.8', '2468'), { ok: true }, '다른 IP');

  c.advance(15 * 60 * 1000 + 1);
  assert.deepEqual(guard.check('9.9.9.9', '2468'), { ok: true }, '잠금이 풀린 뒤');
});

test('맞게 입력하면 그 IP 의 실패 횟수가 초기화된다', () => {
  const c = clock();
  const guard = createPinGuard({ pin: '2468', now: c.now });
  for (let i = 0; i < 4; i += 1) guard.check('7.7.7.7', 'x');
  assert.deepEqual(guard.check('7.7.7.7', '2468'), { ok: true });
  for (let i = 0; i < 4; i += 1) assert.equal(guard.check('7.7.7.7', 'x').status, 401);
});

test('여러 IP 로 나눠 추측해도 10분 안에 30번 틀리면 모든 PIN 입력을 10분 잠근다', () => {
  const c = clock();
  const guard = createPinGuard({ pin: '2468', now: c.now });
  const results = [];
  for (let i = 0; i < 30; i += 1) results.push(guard.check(`10.0.0.${i}`, '0000'));
  assert.equal(results[28].recentFailures, 29);
  assert.equal(results[28].lock, null);
  assert.equal(results[29].recentFailures, 30);
  assert.equal(results[29].lock, 'global', '30번째에 PIN 입력 전체를 잠금');
  const blocked = guard.check('10.0.1.1', '2468');
  assert.equal(blocked.status, 429);
  c.advance(10 * 60 * 1000 + 1);
  assert.deepEqual(guard.check('10.0.1.1', '2468'), { ok: true });
});

test('기록용 IP 표시: 같은 IP 는 같은 표시, 원문은 드러나지 않고, 인스턴스(키)가 다르면 달라진다', () => {
  const tag = createIpTagger();
  assert.match(tag('203.0.113.7'), /^[0-9a-f]{12}$/);
  assert.equal(tag('203.0.113.7'), tag('203.0.113.7'));
  assert.notEqual(tag('203.0.113.7'), tag('203.0.113.8'));
  assert.notEqual(createIpTagger()('203.0.113.7'), tag('203.0.113.7'), '키는 인스턴스마다 새로 만든다');
});

test('클라이언트 IP 는 x-forwarded-for 의 첫 값, 없으면 x-real-ip, 그것도 없으면 socket 주소', () => {
  assert.equal(clientIpOf({ headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' } }), '203.0.113.5');
  assert.equal(clientIpOf({ headers: { 'x-real-ip': '198.51.100.7' } }), '198.51.100.7');
  assert.equal(clientIpOf({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }), '127.0.0.1');
});

function fakeRes() {
  const headers = {};
  return {
    statusCode: 200,
    headers,
    ended: false,
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    status(code) { this.statusCode = code; return this; },
    end() { this.ended = true; return this; },
    json(body) { this.body = body; this.ended = true; return this; }
  };
}

test('CORS: 허용 목록의 출처만 그대로 돌려주고, 사전 요청(OPTIONS)은 204 로 끝낸다', () => {
  const allowed = parseAllowedOrigins('https://pinking-jeong.github.io, http://localhost:3000');
  const res = fakeRes();
  const handled = applyCors({ method: 'GET', headers: { origin: 'https://pinking-jeong.github.io' } }, res, allowed);
  assert.equal(handled, false, 'GET 은 계속 처리');
  assert.equal(res.headers['access-control-allow-origin'], 'https://pinking-jeong.github.io');
  assert.match(res.headers['access-control-allow-headers'], /X-Access-Pin/);
  assert.match(res.headers.vary, /Origin/);

  const pre = fakeRes();
  assert.equal(applyCors({ method: 'OPTIONS', headers: { origin: 'http://localhost:3000' } }, pre, allowed), true);
  assert.equal(pre.statusCode, 204);
  assert.ok(pre.ended);

  const evil = fakeRes();
  assert.equal(applyCors({ method: 'GET', headers: { origin: 'https://evil.example' } }, evil, allowed), true);
  assert.equal(evil.statusCode, 403);
  assert.equal(evil.headers['access-control-allow-origin'], undefined);

  const noOrigin = fakeRes();
  assert.equal(applyCors({ method: 'GET', headers: {} }, noOrigin, allowed), false, '브라우저가 아닌 호출은 PIN 으로만 막는다');
});

test('입력 검증: 공항 코드·날짜(오늘~330일)·정수 범위·참거짓·연월', () => {
  const today = '2026-10-19';
  assert.deepEqual(parseIata('icn'), { ok: true, value: 'ICN' });
  assert.equal(parseIata('IC').ok, false);
  assert.equal(parseIata('ICN,GMP').ok, false);
  assert.equal(parseIata('<i>').ok, false);

  assert.deepEqual(parseDate('2026-11-08', { today }), { ok: true, value: '2026-11-08' });
  assert.equal(parseDate('2026-10-18', { today }).ok, false, '과거');
  assert.equal(parseDate('2027-09-30', { today }).ok, false, '330일 넘음');
  assert.equal(parseDate('2026-02-30', { today }).ok, false, '없는 날짜');
  assert.equal(parseDate('2026/11/08', { today }).ok, false);

  assert.deepEqual(parseIntInRange('3', { min: 1, max: 12 }), { ok: true, value: 3 });
  assert.equal(parseIntInRange('13', { min: 1, max: 12 }).ok, false);
  assert.equal(parseIntInRange('2.5', { min: 1, max: 12 }).ok, false);
  assert.deepEqual(parseIntInRange(undefined, { min: 1, max: 12, fallback: 6 }), { ok: true, value: 6 });

  assert.deepEqual(parseBool('true'), { ok: true, value: true });
  assert.deepEqual(parseBool('false'), { ok: true, value: false });
  assert.deepEqual(parseBool(undefined, true), { ok: true, value: true });
  assert.equal(parseBool('yes').ok, false);

  assert.deepEqual(parseMonth('2026-11', { today }), { ok: true, value: '2026-11' });
  assert.equal(parseMonth('2026-09', { today }).ok, false, '지난 달');
  assert.equal(parseMonth('2026-13', { today }).ok, false);
});

test('캐시: 시간이 지나면 버리고, 개수가 넘치면 가장 오래 안 쓴 것부터 버리며, 같은 키 동시 요청은 한 번만 불러온다', async () => {
  const c = clock();
  const cache = createTtlCache({ maxEntries: 2, now: c.now });
  cache.set('a', 1, 1000);
  cache.set('b', 2, 1000);
  assert.equal(cache.get('a'), 1);
  cache.set('c', 3, 1000); // b 가 가장 오래 안 쓴 것
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 1);
  c.advance(1001);
  assert.equal(cache.get('a'), undefined, '만료');

  let calls = 0;
  const loader = async () => { calls += 1; await new Promise((r) => setTimeout(r, 5)); return 'v'; };
  const [x, y] = await Promise.all([cache.getOrLoad('k', 1000, loader), cache.getOrLoad('k', 1000, loader)]);
  assert.equal(x.value, 'v');
  assert.equal(y.value, 'v');
  assert.equal(calls, 1);
  const again = await cache.getOrLoad('k', 1000, loader);
  assert.equal(again.cached, true);
  assert.equal(calls, 1);

  const failing = async () => { throw new Error('boom'); };
  await assert.rejects(cache.getOrLoad('bad', 1000, failing), /boom/);
  assert.equal(cache.get('bad'), undefined, '실패는 캐시하지 않는다');
});
