/**
 * 실제 운임 프록시 라우터 (로컬 개발 서버 = Vercel 함수와 같은 처리)
 * - 가짜 상류 API 로 SerpApi·Travelpayouts 응답을 흉내 낸다 (실제 키·네트워크 없음)
 * - PIN 은 테스트용 값이다 (실제 PIN 은 Vercel 환경 변수에만 있다)
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { startDevServer } = require('../proxy/dev-server');
const { createFakeUpstream } = require('./fixtures/fake-upstream');

const PIN = '2468';
const SITE = 'https://pinking-jeong.github.io';

function futureDate(days) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

async function startProxy({ env, upstream = createFakeUpstream(), log } = {}) {
  const server = await startDevServer({
    port: 0,
    env: env || { ACCESS_PIN: PIN, SERPAPI_KEY: upstream.keys.serpapiKey, TRAVELPAYOUTS_TOKEN: upstream.keys.travelpayoutsToken },
    fetchImpl: upstream.fetchImpl,
    failureDelayMs: 0,
    log
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(path, { method = 'GET', pin = PIN, origin = SITE, ip } = {}) {
    const headers = {};
    if (origin) headers.Origin = origin;
    if (pin !== null) headers['X-Access-Pin'] = pin;
    if (ip) headers['X-Forwarded-For'] = ip;
    const res = await fetch(base + path, { method, headers });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, body: text ? JSON.parse(text) : null };
  }
  return { server, call, upstream };
}

let main;
before(async () => {
  main = await startProxy();
});
after(() => main.server.close());

const DEP = futureDate(30);
const RET = futureDate(34);

test('CORS: 허용된 사이트의 사전 요청은 204 + 허용 헤더, 다른 사이트는 403', async () => {
  const pre = await main.call('/api/flights', { method: 'OPTIONS', pin: null });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), SITE);
  assert.match(pre.headers.get('access-control-allow-headers'), /X-Access-Pin/);
  const evil = await main.call('/api/session', { method: 'POST', origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
});

test('PIN: 없거나 틀리면 401, 맞으면 세션 확인과 공급자 설정 여부 (응답에 PIN·키 없음)', async () => {
  const none = await main.call('/api/session', { method: 'POST', pin: null, ip: '10.0.0.1' });
  assert.equal(none.status, 401);
  assert.equal(none.body.code, 'PIN_INVALID');
  const wrong = await main.call('/api/session', { method: 'POST', pin: '0000', ip: '10.0.0.1' });
  assert.equal(wrong.status, 401);
  const ok = await main.call('/api/session', { method: 'POST' });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { ok: true, providers: { serpapi: true, travelpayouts: true } });
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  for (const secret of [PIN, main.upstream.keys.serpapiKey, main.upstream.keys.travelpayoutsToken]) {
    assert.ok(!ok.text.includes(secret));
  }
});

test('틀린 PIN 은 서버 기록에 남기되, 넣은 PIN·IP 원문·맞는 PIN 은 남기지 않는다', async () => {
  const lines = [];
  const log = { warn: (...args) => lines.push(args.join(' ')), error: (...args) => lines.push(args.join(' ')) };
  const proxy = await startProxy({ log });
  try {
    for (let i = 0; i < 5; i++) await proxy.call('/api/session', { method: 'POST', pin: '97531', ip: '203.0.113.7' });
    await proxy.call('/api/session', { method: 'POST', ip: '198.51.100.2' });
    assert.equal(lines.length, 5, '맞는 PIN·잠긴 뒤 요청은 기록하지 않음');
    for (const line of lines) {
      assert.match(line, /PIN 실패/);
      assert.match(line, /"ip":"[0-9a-f]{12}"/, 'IP 는 알아볼 수 없는 표시로');
      // 표시(무작위 16진수)에 우연히 같은 숫자가 섞일 수 있어 표시를 뺀 나머지에서 찾는다
      const rest = line.replace(/"ip":"[0-9a-f]{12}"/, '');
      for (const secret of ['97531', '203.0.113.7', PIN]) assert.ok(!rest.includes(secret), `기록에 ${secret} 없음`);
    }
    const entries = lines.map((line) => JSON.parse(line.slice(line.indexOf('{'))));
    assert.equal(new Set(entries.map((e) => e.ip)).size, 1, '같은 IP 는 같은 표시');
    assert.deepEqual(entries.map((e) => e.ipFailures), [1, 2, 3, 4, 5]);
    assert.equal(entries[4].lock, 'ip');
  } finally {
    proxy.server.close();
  }
});

test('PIN 을 5번 틀린 IP 는 잠겨(429·Retry-After) 맞는 PIN 도 거절되고, 다른 IP 는 계속 쓸 수 있다', async () => {
  const proxy = await startProxy();
  try {
    for (let i = 0; i < 5; i++) {
      assert.equal((await proxy.call('/api/session', { method: 'POST', pin: '1111', ip: '10.9.9.9' })).status, 401);
    }
    const locked = await proxy.call('/api/session', { method: 'POST', ip: '10.9.9.9' });
    assert.equal(locked.status, 429);
    assert.equal(locked.body.code, 'PIN_LOCKED');
    assert.ok(Number(locked.headers.get('retry-after')) > 0);
    assert.equal((await proxy.call('/api/session', { method: 'POST', ip: '10.1.1.1' })).status, 200);
  } finally {
    proxy.server.close();
  }
});

test('PIN 이 설정되지 않은 프록시는 모든 조회를 503 으로 막고, 키가 없는 공급자는 503 PROVIDER_NOT_CONFIGURED', async () => {
  const noPin = await startProxy({ env: {} });
  try {
    const res = await noPin.call('/api/session', { method: 'POST' });
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'PIN_NOT_CONFIGURED');
  } finally {
    noPin.server.close();
  }
  const noKeys = await startProxy({ env: { ACCESS_PIN: PIN } });
  try {
    const session = await noKeys.call('/api/session', { method: 'POST' });
    assert.deepEqual(session.body.providers, { serpapi: false, travelpayouts: false });
    const flights = await noKeys.call(`/api/flights?origin=ICN&destination=NRT&departureDate=${DEP}&returnDate=${RET}`);
    assert.equal(flights.status, 503);
    assert.equal(flights.body.code, 'PROVIDER_NOT_CONFIGURED');
    const top = await noKeys.call('/api/anywhere-top10?origin=ICN');
    assert.equal(top.status, 503);
  } finally {
    noKeys.server.close();
  }
});

test('/api/flights: 구글 플라이트 편도 두 번(가는 편·오는 편) — 후보·조회 시각을 돌려주고 같은 조건은 캐시', async () => {
  const before = main.upstream.counts.serpapiSearches;
  const res = await main.call(`/api/flights?origin=ICN&destination=NRT&departureDate=${DEP}&returnDate=${RET}&directOnly=true`);
  assert.equal(res.status, 200);
  assert.equal(res.body.fareSource, 'SERPAPI_GOOGLE_FLIGHTS');
  assert.equal(res.body.realFare, true);
  assert.ok(Date.parse(res.body.fetchedAt) > 0);
  const out = res.body.outbound.candidates[0];
  assert.equal(out.fromAirportCode, 'ICN');
  assert.equal(out.toAirportCode, 'NRT');
  assert.equal(out.date, DEP);
  assert.equal(res.body.inbound.candidates[0].toAirportCode, 'ICN');
  assert.equal(main.upstream.counts.serpapiSearches - before, 2);

  const again = await main.call(`/api/flights?origin=ICN&destination=NRT&departureDate=${DEP}&returnDate=${RET}&directOnly=true`);
  assert.equal(again.body.outbound.cached, true);
  assert.equal(main.upstream.counts.serpapiSearches - before, 2, '캐시라 무료 한도를 쓰지 않는다');

  const all = await main.call(`/api/flights?origin=ALL_KOREA&destination=NRT&departureDate=${DEP}&returnDate=${RET}`);
  const froms = new Set(all.body.outbound.candidates.map((c) => c.fromAirportCode));
  assert.ok(froms.size > 1, '전국 통합은 취항 공항들을 한 번에 검색');
});

test('입력 검증: 공항 코드·날짜 형식·지난 날짜·귀국일 순서·국내 도착지는 400', async () => {
  const bad = [
    `/api/flights?origin=IC&destination=NRT&departureDate=${DEP}&returnDate=${RET}`,
    `/api/flights?origin=ICN&destination=NRT&departureDate=2020-01-01&returnDate=${RET}`,
    `/api/flights?origin=ICN&destination=NRT&departureDate=${RET}&returnDate=${DEP}`,
    `/api/flights?origin=ICN&destination=CJU&departureDate=${DEP}&returnDate=${RET}`,
    '/api/anywhere-top10?origin=ICN&region=DROP%20TABLE',
    `/api/return-date-matrix?origin=ICN&destination=NRT&departureDate=${DEP}&maxStayDays=99`
  ];
  for (const path of bad) {
    const res = await main.call(path);
    assert.equal(res.status, 400, path);
    assert.equal(res.body.code, 'BAD_REQUEST');
  }
});

test('/api/anywhere-top10: Travelpayouts 실제 운임 TOP 30 (지역 필터, 모의 2년 비교 없음)', async () => {
  const res = await main.call('/api/anywhere-top10?origin=ICN&region=%EC%9D%BC%EB%B3%B8&directOnly=true&adults=2');
  assert.equal(res.status, 200);
  assert.equal(res.body.realFare, true);
  assert.equal(res.body.fareSource, 'TRAVELPAYOUTS_PRICES');
  assert.ok(res.body.top30Deals.length > 0);
  for (const deal of res.body.top30Deals) {
    assert.equal(deal.region, '일본');
    assert.equal(deal.discountVs2YAvgPercent, null);
    assert.equal(deal.outboundLeg.fareSource, 'TRAVELPAYOUTS_PRICES');
    assert.ok(deal.totalPassengersPriceKrw >= deal.combinedAdultPriceKrw * 2);
  }
  assert.ok(res.body.tiers.top10.items.length > 0);
});

test('/api/route-stats: 앞으로 12개월 월별·요일별 실제 검색가', async () => {
  const res = await main.call('/api/route-stats?origin=ICN&destination=NRT&directOnly=true');
  assert.equal(res.status, 200);
  assert.equal(res.body.monthlyStats.length, 12);
  assert.equal(res.body.dayOfWeekStats.length, 7);
  assert.ok(res.body.summary.outboundDays > 300);
  assert.ok(res.body.summary.lowestOutbound.priceKrw > 0);
  assert.equal(res.body.fareSource, 'TRAVELPAYOUTS_PRICES');
});

test('귀국일표·추천 일정·가격 추이: 앱과 같은 계산(엔진 사본)을 실제 운임으로, 모의 2년 비교 값은 지운다', async () => {
  const matrix = await main.call(`/api/return-date-matrix?origin=ICN&destination=NRT&departureDate=${DEP}&maxStayDays=7`);
  assert.equal(matrix.status, 200);
  assert.equal(matrix.body.returnOptions.length, 7);
  assert.equal(matrix.body.benchmark2Y, null);
  assert.ok(matrix.body.returnOptions.every((o) => o.discountVs2YAvgPercent === null && o.priceGrade === null));
  assert.equal(matrix.body.outboundLeg.fareSource, 'TRAVELPAYOUTS_PRICES');

  const rec = await main.call('/api/schedule-recommendations?origin=ICN&destination=NRT&minNights=2&maxNights=5');
  assert.equal(rec.status, 200);
  assert.equal(rec.body.recommendations.length, 6);
  assert.ok(rec.body.recommendations.every((r) => r.discountVs2YAvgPercent === null && r.vsLowest2YDiffKrw === null));

  const trend = await main.call(`/api/route-price-trend?origin=ICN&destination=NRT&departureDate=${DEP}&returnDate=${RET}`);
  assert.equal(trend.status, 200);
  assert.equal(trend.body.points.length, 15);
  assert.equal(trend.body.benchmark2Y, null);
  assert.equal(trend.body.selectedPoint.departureDate, DEP);
});

test('/api/status: SerpApi 남은 검색 횟수만 (키·계정 이메일은 빼고)', async () => {
  const res = await main.call('/api/status');
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.serpapi.account.searchesLeft, 'number');
  assert.equal(res.body.travelpayouts.configured, true);
  assert.ok(!res.text.includes(main.upstream.keys.serpapiKey));
  assert.ok(!res.text.includes('example.com'));
});

test('상류 오류는 코드와 함께 502, 메시지에 토큰 없음 · 없는 경로 404 · 다른 메서드 405', async () => {
  const failing = await startProxy({ upstream: createFakeUpstream({ failTravelpayouts: true }) });
  try {
    const res = await failing.call('/api/route-stats?origin=ICN&destination=NRT');
    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'TP_ERROR');
    assert.ok(!res.text.includes(failing.upstream.keys.travelpayoutsToken));
  } finally {
    failing.server.close();
  }
  assert.equal((await main.call('/api/nothing')).status, 404);
  assert.equal((await main.call('/api/session', { method: 'GET' })).status, 405);
});
