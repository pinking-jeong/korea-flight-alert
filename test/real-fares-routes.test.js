/**
 * 실제 운임 후보(externalCandidates)를 받는 규칙 등록·재조회 — 로컬 서버와 Pages 내장 엔진이 같은 결과를 내야 한다
 * 카카오톡 알림 문구도 출처(모의 / 실시간 / 최근 검색가)를 구분한다
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skybell-real-fares-test-'));
process.env.SKYBELL_DATA_DIR = dataDir;

const app = require('../src/server');
const { buildStandaloneSource } = require('../scripts/build-standalone');
const { fetchLowestRoundTripPrice } = require('../src/services/flightApiService');
const { buildKakaoAlertTemplate } = require('../src/services/kakaoService');
const { createNotificationLogEntry } = require('../src/services/schedulerService');

let server;
let base;

before(() => {
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function futureDate(days) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

const DEP = futureDate(40);
const RET = futureDate(43);
const FETCHED_AT = '2026-10-19T03:04:00.000Z';

function external(outPrice, { sourceApi = 'SERPAPI_GOOGLE_FLIGHTS', inPrice = 100000 } = {}) {
  return {
    sourceApi,
    fetchedAt: FETCHED_AT,
    outbound: [
      { airline: '칭다오항공', airlineCode: 'QW', flightNumber: 'QW9902', fromAirportCode: 'ICN', toAirportCode: 'TAO', date: DEP, scheduleTime: '23:30 → 00:20(+1)', stops: 0, oneWayPriceKrw: outPrice }
    ],
    inbound: [
      { airline: '칭다오항공', airlineCode: 'QW', flightNumber: 'QW9901', fromAirportCode: 'TAO', toAirportCode: 'ICN', date: RET, scheduleTime: '01:20 → 03:55', stops: 0, oneWayPriceKrw: inPrice }
    ]
  };
}

const RULE_BODY = { origin: 'ICN', destination: 'TAO', departureDate: DEP, returnDate: RET, targetPrice: 150000, directOnly: true, adults: 1 };

// 다른 날짜의 규칙용 실제 운임 후보 (시험끼리 같은 노선 조건으로 묶이지 않게 날짜를 바꿔 쓴다)
function externalFor({ dep, ret, outPrice, inPrice = 100000, sourceApi = 'SERPAPI_GOOGLE_FLIGHTS' }) {
  const base = external(outPrice, { sourceApi, inPrice });
  return {
    ...base,
    outbound: base.outbound.map((leg) => ({ ...leg, date: dep })),
    inbound: base.inbound.map((leg) => ({ ...leg, date: ret }))
  };
}

async function serverCall(method, url, body) {
  const options = { method };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  const res = await fetch(`${base}${url}`, options);
  return { status: res.status, body: await res.json() };
}

function loadStandaloneCall() {
  const map = new Map();
  const storage = {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key)
  };
  const fakeWindow = { location: { origin: 'https://pinking-jeong.github.io', pathname: '/korea-flight-alert/' } };
  // eslint-disable-next-line no-new-func
  new Function('window', 'localStorage', buildStandaloneSource())(fakeWindow, storage);
  return async (method, url, body) => {
    const options = { method };
    if (body !== undefined) {
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify(body);
    }
    const res = await fakeWindow.SkyBellStandaloneApi.handleRequest(url, options);
    return { status: res.status, body: await res.json() };
  };
}

for (const [label, makeCall] of [
  ['로컬 서버', () => serverCall],
  ['Pages 내장 엔진', loadStandaloneCall]
]) {
  test(`${label}: 실제 운임으로 등록·재조회하면 그 가격·출처·조회 시각이 남고, 결과가 없으면 422 로 규칙을 바꾸지 않는다`, async () => {
    const call = makeCall();
    const created = await call('POST', '/api/rules', { ...RULE_BODY, externalCandidates: external(98000) });
    assert.equal(created.status, 201);
    assert.equal(created.body.rule.currentLowestPrice, 198000);
    assert.equal(created.body.rule.sourceApi, 'SERPAPI_GOOGLE_FLIGHTS');
    assert.equal(created.body.rule.fareFetchedAt, FETCHED_AT);
    assert.equal(created.body.rule.outboundLeg.flightNumber, 'QW9902');
    const ruleId = created.body.rule.id;

    const checked = await call('POST', `/api/rules/${ruleId}/check`, { externalCandidates: external(90000, { sourceApi: 'TRAVELPAYOUTS_PRICES' }) });
    assert.equal(checked.status, 200);
    assert.equal(checked.body.offer.priceKrw, 190000);
    assert.equal(checked.body.rule.currentLowestPrice, 190000);
    assert.equal(checked.body.rule.previousPrice, 198000);
    assert.equal(checked.body.rule.sourceApi, 'TRAVELPAYOUTS_PRICES');

    const empty = await call('POST', `/api/rules/${ruleId}/check`, {
      externalCandidates: { sourceApi: 'SERPAPI_GOOGLE_FLIGHTS', fetchedAt: FETCHED_AT, outbound: [], inbound: [] }
    });
    assert.equal(empty.status, 422);
    assert.match(empty.body.error, /실제 운임/);

    const rulesBefore = (await call('GET', '/api/dashboard')).body.watchRules.length;
    const unknown = await call('POST', '/api/rules', { ...RULE_BODY, externalCandidates: { ...external(98000), sourceApi: 'MADE_UP' } });
    assert.equal(unknown.status, 422);

    const dashboard = await call('GET', '/api/dashboard');
    const stored = dashboard.body.watchRules.find((r) => r.id === ruleId);
    assert.equal(stored.currentLowestPrice, 190000, '실패한 조회는 가격을 바꾸지 않는다');
    assert.equal(dashboard.body.watchRules.length, rulesBefore, '실패한 등록은 규칙을 만들지 않는다');
    const history = dashboard.body.historiesByRule[ruleId].map((h) => h.sourceApi);
    assert.deepEqual(history, ['SERPAPI_GOOGLE_FLIGHTS', 'TRAVELPAYOUTS_PRICES']);
  });

  test(`${label}: 실제 운임 규칙은 후보 없이 다시 조회하면 409 로 거절하고, 같은 조건 모의 규칙 조회·일괄 조회도 덮어쓰지 않는다 (급락 시뮬레이션만 예외)`, async () => {
    const call = makeCall();
    const dep = futureDate(60);
    const ret = futureDate(63);
    const body = { ...RULE_BODY, departureDate: dep, returnDate: ret, targetPrice: 50000 };
    const real = await call('POST', '/api/rules', { ...body, externalCandidates: externalFor({ dep, ret, outPrice: 98000 }) });
    assert.equal(real.status, 201);
    const realId = real.body.rule.id;
    const sim = await call('POST', '/api/rules', body);
    assert.equal(sim.status, 201);
    assert.notEqual(sim.body.rule.sourceApi, 'SERPAPI_GOOGLE_FLIGHTS', '같은 조건의 모의 규칙');

    const refused = await call('POST', `/api/rules/${realId}/check`, {});
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'REAL_FARE_NEEDS_PIN');
    assert.match(refused.body.error, /PIN/);

    assert.equal((await call('POST', `/api/rules/${sim.body.rule.id}/check`, {})).status, 200);
    const batch = await call('POST', '/api/batch-check');
    assert.equal(batch.status, 200);
    assert.ok(batch.body.skippedRealFareRules >= 1, '일괄 조회가 건너뛴 실제 운임 규칙 수');

    const stored = (await call('GET', '/api/dashboard')).body.watchRules.find((r) => r.id === realId);
    assert.equal(stored.sourceApi, 'SERPAPI_GOOGLE_FLIGHTS');
    assert.equal(stored.currentLowestPrice, 198000);
    assert.equal(stored.fareFetchedAt, FETCHED_AT);

    const simulated = await call('POST', `/api/rules/${realId}/check`, { forceTargetHit: true });
    assert.equal(simulated.status, 200, '급락 시뮬레이션은 사용자가 고른 모의 동작이라 그대로 된다');
    assert.notEqual(simulated.body.rule.sourceApi, 'SERPAPI_GOOGLE_FLIGHTS');
  });

  test(`${label}: 일괄 조회 표시(respectCooldown)가 있으면 알림 간격 안에 다시 알리지 않는다`, async () => {
    const call = makeCall();
    const dep = futureDate(70);
    const ret = futureDate(73);
    const candidates = externalFor({ dep, ret, outPrice: 98000 });
    const created = await call('POST', '/api/rules', { ...RULE_BODY, departureDate: dep, returnDate: ret, targetPrice: 300000, externalCandidates: candidates });
    assert.equal(created.status, 201);
    assert.ok(created.body.notificationResult, '등록 즉시 목표가 이하라 알림');
    const ruleId = created.body.rule.id;

    const batchLike = await call('POST', `/api/rules/${ruleId}/check`, { externalCandidates: candidates, respectCooldown: true });
    assert.equal(batchLike.status, 200);
    assert.equal(batchLike.body.notificationResult, null, '알림 간격(12시간) 안이라 다시 알리지 않음');
    const manual = await call('POST', `/api/rules/${ruleId}/check`, { externalCandidates: candidates });
    assert.ok(manual.body.notificationResult, '직접 누른 재조회는 예전처럼 알림');
  });
}

test('로컬 서버: 카카오톡 전송이 실패해도 받아 온 가격은 저장하고 실패를 따로 알린다', async () => {
  const dep = futureDate(80);
  const ret = futureDate(83);
  const body = { ...RULE_BODY, departureDate: dep, returnDate: ret, targetPrice: 300000 };
  // 카카오 토큰이 있는 것처럼 두고, 카카오로 가는 요청만 실패시킨다 (실제 네트워크 없음)
  await serverCall('POST', '/api/settings', { kakaoAccessToken: 'test-kakao-token' });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, options) =>
    String(url).includes('kakao.com') ? Promise.reject(new Error('kakao down')) : realFetch(url, options);
  try {
    const created = await serverCall('POST', '/api/rules', { ...body, externalCandidates: externalFor({ dep, ret, outPrice: 98000 }) });
    assert.equal(created.status, 201, '알림이 실패해도 규칙은 만든다');
    assert.equal(created.body.notificationResult, null);
    assert.match(created.body.notificationError, /카카오톡/);

    const checked = await serverCall('POST', `/api/rules/${created.body.rule.id}/check`, {
      externalCandidates: externalFor({ dep, ret, outPrice: 90000 })
    });
    assert.equal(checked.status, 200);
    assert.equal(checked.body.rule.currentLowestPrice, 190000, '받아 온 가격은 저장');
    assert.match(checked.body.notificationError, /카카오톡/);
  } finally {
    globalThis.fetch = realFetch;
    await serverCall('POST', '/api/settings', { clearKakaoToken: true });
  }
});

test('카카오톡 알림: 최근 검색가(Travelpayouts)와 실시간 조회가(구글 플라이트)를 모의 가격과 구분해 밝힌다', async () => {
  const rule = { ...RULE_BODY, id: 'rule_kakao' };
  const { offer: cached } = await fetchLowestRoundTripPrice(rule, {}, { externalCandidates: external(98000, { sourceApi: 'TRAVELPAYOUTS_PRICES' }) });
  const builtCached = buildKakaoAlertTemplate(rule, cached);
  assert.equal(builtCached.isSimulatedPrice, false);
  assert.equal(builtCached.fareKind, 'CACHED');
  assert.match(builtCached.templateObject.content.title, /최근 검색가/);
  assert.match(builtCached.templateObject.content.description, /최근 이용자 검색/);
  assert.match(builtCached.messagePreview, /최근 검색가/);
  assert.doesNotMatch(builtCached.messagePreview, /모의/);

  const { offer: live } = await fetchLowestRoundTripPrice(rule, {}, { externalCandidates: external(98000) });
  const builtLive = buildKakaoAlertTemplate(rule, live);
  assert.equal(builtLive.fareKind, 'LIVE');
  assert.match(builtLive.templateObject.content.description, /실시간 조회가 \(10\/19 12:04 조회\)/, '조회 시각은 한국 시간');
  assert.doesNotMatch(builtLive.templateObject.content.title, /모의|최근 검색가/);
  assert.equal(builtLive.templateObject.item_content.items[4].item, '같은 항공사 편도 대비');

  const { offer: simulated } = await fetchLowestRoundTripPrice(rule, {});
  const builtSimulated = buildKakaoAlertTemplate(rule, simulated);
  assert.equal(builtSimulated.fareKind, 'SIMULATED');
  assert.equal(builtSimulated.templateObject.item_content.items[4].item, '왕복묶음 대비');

  const entry = createNotificationLogEntry(rule.id, builtCached, new Date().toISOString());
  assert.equal(entry.fareKind, 'CACHED');
  assert.equal(entry.isSimulatedPrice, false);
});

test('Pages 엔진의 알림 이력도 출처 종류를 남기고, 최근 검색가는 미리보기에 밝힌다', async () => {
  const call = loadStandaloneCall();
  const created = await call('POST', '/api/rules', {
    ...RULE_BODY,
    targetPrice: 300000,
    externalCandidates: external(98000, { sourceApi: 'TRAVELPAYOUTS_PRICES' })
  });
  assert.equal(created.status, 201);
  const noti = created.body.notificationResult;
  assert.equal(noti.fareKind, 'CACHED');
  assert.equal(noti.isSimulatedPrice, false);
  assert.match(noti.messagePreview, /최근 검색가/);
});
