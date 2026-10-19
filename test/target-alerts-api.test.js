/**
 * 노선·인원 설정 메뉴의 두 기능 API — 로컬 서버와 Pages 내장 엔진이 같은 결과를 내야 한다
 * - GET /api/flex-dates: 입력한 일정 ±3일 최저가 20개 (모의 가격 · 실제 운임은 프록시 flex-dates)
 * - /api/target-alerts: 날짜 없이 희망 목표가만 정하는 알림 (등록·다시 훑기·카톡·삭제·일괄 조회)
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skybell-target-alerts-test-'));
process.env.SKYBELL_DATA_DIR = dataDir;

const app = require('../src/server');
const { buildStandaloneSource } = require('../scripts/build-standalone');
const { kstToday } = require('../src/services/targetAlerts');
const { proxyTargetScan, addDays, FETCHED_AT } = require('./fixtures/target-scan');

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

const TODAY = kstToday();
const HIGH_TARGET = 5000000; // 모의 가격이 늘 목표가 이하가 되는 금액

async function serverCall(method, url, body) {
  const options = { method };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  const res = await fetch(`${base}${url}`, options);
  return { status: res.status, body: await res.json() };
}

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key)
  };
}

function loadStandaloneCall(initial = {}, storage = memoryStorage(initial)) {
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

async function dashboardAlert(call, id) {
  const dash = await call('GET', '/api/dashboard');
  return dash.body.targetAlerts.find((a) => a.id === id);
}

for (const [label, makeCall] of [
  ['로컬 서버', () => serverCall],
  ['Pages 내장 엔진', () => loadStandaloneCall()]
]) {
  test(`${label}: ±3일 최저가 — 입력한 일정 앞뒤 3일 조합 중 싼 순서로 20개, 날짜가 틀리면 400`, async () => {
    const call = makeCall();
    const dep = addDays(TODAY, 30);
    const ret = addDays(dep, 4);
    const res = await call('GET', `/api/flex-dates?origin=ICN&destination=FUK&departureDate=${dep}&returnDate=${ret}&adults=2&directOnly=true`);
    assert.equal(res.status, 200);
    assert.equal(res.body.flexDays, 3);
    assert.equal(res.body.deals.length, 20);
    assert.ok(res.body.comboCount >= 40);
    assert.equal(res.body.requestedDates.departureDate, dep);
    assert.ok(res.body.requestedDates.combinedAdultPriceKrw > 0);
    res.body.deals.forEach((d, i) => {
      assert.ok(Math.abs(d.depShiftDays) <= 3 && Math.abs(d.retShiftDays) <= 3);
      assert.equal(d.bookingLinks.bookingMeta.adults, 2);
      if (i > 0) assert.ok(res.body.deals[i - 1].combinedAdultPriceKrw <= d.combinedAdultPriceKrw);
    });

    const bad = await call('GET', `/api/flex-dates?origin=ICN&destination=FUK&departureDate=${ret}&returnDate=${dep}`);
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'BAD_DATE');
  });

  test(`${label}: 목표가 알림(모의) — 등록하면 곧바로 훑어 목표가 이하 일정과 카톡 미리보기, 같은 값은 다시 알리지 않음`, async () => {
    const call = makeCall();
    const created = await call('POST', '/api/target-alerts', {
      origin: 'ALL_KOREA',
      destination: 'FUK',
      targetPrice: HIGH_TARGET,
      windowDays: 30,
      minNights: 2,
      maxNights: 4,
      adults: 2,
      children: 0,
      infants: 0,
      directOnly: true
    });
    assert.equal(created.status, 201);
    const { alert } = created.body;
    assert.match(alert.id, /^talert_/);
    assert.equal(alert.kind, 'TARGET_PRICE');
    assert.equal(alert.isTargetReached, true);
    assert.equal(alert.matchCount, 30);
    assert.equal(alert.matches.length, 20);
    assert.equal(alert.isRealFare, false);
    assert.equal(alert.lastScan.scannedDays, 30);
    assert.equal(alert.lastScan.fromDate, addDays(TODAY, 1));
    assert.equal(alert.checkedToday, true);
    assert.ok(alert.matches.every((m) => m.stayNights >= 2 && m.stayNights <= 4));
    assert.equal(created.body.notificationResult.alertKind, 'TARGET_PRICE');
    assert.equal(created.body.notificationResult.ruleId, alert.id);
    assert.equal(created.body.notificationResult.matchCount, 30);
    assert.equal(created.body.notificationResult.fareKind, 'SIMULATED');

    const stored = await dashboardAlert(call, alert.id);
    assert.equal(stored.matchCount, 30);
    assert.equal(stored.lastNotifiedPriceKrw, alert.matches[0].combinedAdultPriceKrw);
    const dash = await call('GET', '/api/dashboard');
    assert.ok(dash.body.apiQuotaStats.activeTargetAlertsCount >= 1);
    assert.ok(dash.body.notificationLogs.some((n) => n.ruleId === alert.id && n.alertKind === 'TARGET_PRICE'));

    const rescanned = await call('POST', `/api/target-alerts/${alert.id}/scan`, {});
    assert.equal(rescanned.status, 200);
    assert.equal(rescanned.body.alert.bestPriceKrw, alert.bestPriceKrw);
    assert.equal(rescanned.body.notificationResult, null, '같은 값 · 알림 간격 안이면 다시 보내지 않음');

    const manual = await call('POST', `/api/target-alerts/${alert.id}/notify`);
    assert.equal(manual.status, 200);
    assert.equal(manual.body.notificationResult.alertKind, 'TARGET_PRICE');
    assert.match(manual.body.notificationResult.messagePreview, /목표가 이하 30일 발견/);

    const deleted = await call('DELETE', `/api/target-alerts/${alert.id}`);
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.deletedId, alert.id);
    assert.equal(await dashboardAlert(call, alert.id), undefined);
    assert.equal((await call('DELETE', `/api/target-alerts/${alert.id}`)).status, 404);
  });

  test(`${label}: 목표가 알림 입력 오류는 400(코드 포함), 없는 알림은 404, 목표가 이하가 없으면 알리지 않음`, async () => {
    const call = makeCall();
    const body = { origin: 'ICN', destination: 'FUK', targetPrice: 300000 };
    const badPrice = await call('POST', '/api/target-alerts', { ...body, targetPrice: 0 });
    assert.equal(badPrice.status, 400);
    assert.equal(badPrice.body.code, 'BAD_TARGET_PRICE');
    const badWindow = await call('POST', '/api/target-alerts', { ...body, windowDays: 400 });
    assert.equal(badWindow.status, 400);
    assert.equal(badWindow.body.code, 'BAD_TARGET_ALERT');
    const badNights = await call('POST', '/api/target-alerts', { ...body, minNights: 5, maxNights: 2 });
    assert.equal(badNights.status, 400);
    const badInfants = await call('POST', '/api/target-alerts', { ...body, adults: 1, infants: 2 });
    assert.equal(badInfants.status, 400);

    assert.equal((await call('POST', '/api/target-alerts/talert_missing/scan', {})).status, 404);
    assert.equal((await call('POST', '/api/target-alerts/talert_missing/notify')).status, 404);
    assert.equal((await call('DELETE', '/api/target-alerts/talert_missing')).status, 404);

    const cheapTarget = await call('POST', '/api/target-alerts', { ...body, targetPrice: 1000, windowDays: 14 });
    assert.equal(cheapTarget.status, 201);
    assert.equal(cheapTarget.body.alert.isTargetReached, false);
    assert.equal(cheapTarget.body.alert.matchCount, 0);
    assert.ok(cheapTarget.body.alert.cheapest.combinedAdultPriceKrw > 1000);
    assert.equal(cheapTarget.body.alert.gapToTargetKrw, cheapTarget.body.alert.cheapest.combinedAdultPriceKrw - 1000);
    assert.equal(cheapTarget.body.notificationResult, null);
  });

  test(`${label}: 실제 운임(Travelpayouts 결과) 목표가 알림 — 출처·검색한 날 유지, 결과 없이 다시 훑기 409, 출처가 다르면 422, 일괄 조회는 건너뜀`, async () => {
    const call = makeCall();
    const body = { origin: 'ICN', destination: 'TAO', targetPrice: 200000, windowDays: 30, minNights: 2, maxNights: 4, adults: 1 };
    const d1 = addDays(TODAY, 6);
    const scanResult = proxyTargetScan(body, [
      ['OUTBOUND', d1, 'ICN', 80000],
      ['INBOUND', addDays(d1, 3), 'ICN', 70000],
      ['OUTBOUND', addDays(TODAY, 10), 'ICN', 150000],
      ['INBOUND', addDays(TODAY, 12), 'ICN', 120000]
    ]);
    scanResult.matches[0].bookingLinks.primaryUrl = 'https://evil.example/phish';

    const created = await call('POST', '/api/target-alerts', { ...body, scanResult });
    assert.equal(created.status, 201);
    const { alert } = created.body;
    assert.equal(alert.sourceApi, 'TRAVELPAYOUTS_PRICES');
    assert.equal(alert.fareFetchedAt, FETCHED_AT);
    assert.equal(alert.isRealFare, true);
    assert.equal(alert.matchCount, 1);
    assert.equal(alert.matches[0].departureDate, d1);
    assert.equal(alert.matches[0].combinedAdultPriceKrw, 150000);
    assert.equal(alert.matches[0].outboundLeg.searchedOn, addDays(TODAY, -1));
    assert.match(alert.matches[0].bookingLinks.primaryUrl, /^https:\/\/flight\.naver\.com\//, '보낸 링크 대신 앱이 만든 링크');
    assert.equal(alert.cheapest.combinedAdultPriceKrw, 150000);
    assert.equal(created.body.notificationResult.fareKind, 'CACHED');

    const noPin = await call('POST', `/api/target-alerts/${alert.id}/scan`, {});
    assert.equal(noPin.status, 409);
    assert.equal(noPin.body.code, 'REAL_FARE_NEEDS_PIN');
    assert.equal((await dashboardAlert(call, alert.id)).lastCheckedAt, alert.lastCheckedAt, '409 는 알림을 바꾸지 않는다');

    const countBefore = (await call('GET', '/api/dashboard')).body.targetAlerts.length;
    const forged = await call('POST', '/api/target-alerts', { ...body, scanResult: { ...scanResult, sourceApi: 'SERPAPI_GOOGLE_FLIGHTS' } });
    assert.equal(forged.status, 422);
    assert.equal(forged.body.code, 'BAD_FARE_SOURCE');
    assert.equal((await call('GET', '/api/dashboard')).body.targetAlerts.length, countBefore, '실패한 등록은 알림을 만들지 않는다');

    const cheaper = proxyTargetScan(body, [
      ['OUTBOUND', d1, 'ICN', 60000],
      ['INBOUND', addDays(d1, 3), 'ICN', 70000]
    ]);
    const rescanned = await call('POST', `/api/target-alerts/${alert.id}/scan`, { scanResult: cheaper });
    assert.equal(rescanned.status, 200);
    assert.equal(rescanned.body.alert.bestPriceKrw, 130000);
    assert.equal(rescanned.body.notificationResult.notifiedPrice, 130000, '더 싼 일정이 나오면 알림 간격 안이어도 알린다');

    const batch = await call('POST', '/api/batch-check');
    assert.equal(batch.status, 200);
    assert.ok(batch.body.skippedRealFareTargetAlerts >= 1);
    assert.equal((await dashboardAlert(call, alert.id)).lastCheckedAt, rescanned.body.alert.lastCheckedAt, '일괄 조회가 실제 운임 알림을 모의 가격으로 덮지 않는다');
  });

  test(`${label}: 일괄 조회는 모의 목표가 알림을 다시 훑고, 같은 값이면 다시 알리지 않는다`, async () => {
    const call = makeCall();
    const created = await call('POST', '/api/target-alerts', { origin: 'PUS', destination: 'KIX', targetPrice: HIGH_TARGET, windowDays: 30 });
    assert.equal(created.status, 201);
    const id = created.body.alert.id;
    const batch = await call('POST', '/api/batch-check');
    assert.equal(batch.status, 200);
    assert.ok(batch.body.checkedTargetAlerts >= 1);
    assert.ok(!batch.body.notificationsSent.some((n) => n.ruleId === id));
    assert.equal((await dashboardAlert(call, id)).matchCount, 30);

    const cleared = await call('DELETE', '/api/target-alerts');
    assert.equal(cleared.status, 200);
    assert.ok(cleared.body.deletedCount >= 1);
    assert.equal((await call('GET', '/api/dashboard')).body.targetAlerts.length, 0);
  });
}

test('Pages 내장 엔진: 목표가 알림이 생기기 전 V4 저장소도 그대로 열린다 (빈 목록)', async () => {
  const oldStore = {
    schemaVersion: 4,
    customDestinations: [],
    settings: { cooldownHours: 12, autoNotifyOnTarget: true },
    watchRules: [],
    priceHistories: [],
    notificationLogs: [],
    apiQuotaStats: {}
  };
  const call = loadStandaloneCall({ SKYBELL_KR_STANDALONE_STORE_V4: JSON.stringify(oldStore) });
  const dash = await call('GET', '/api/dashboard');
  assert.equal(dash.status, 200);
  assert.deepEqual(dash.body.targetAlerts, []);
  const created = await call('POST', '/api/target-alerts', { origin: 'ICN', destination: 'NRT', targetPrice: HIGH_TARGET, windowDays: 30 });
  assert.equal(created.status, 201);
});

// 서버 저장소(store.json)를 직접 고친다 (시험 준비용) — 돌려놓을 값을 돌려준다
function patchServerStore(patch) {
  const file = path.join(dataDir, 'store.json');
  const store = JSON.parse(fs.readFileSync(file, 'utf8'));
  const restore = JSON.parse(JSON.stringify(store.settings));
  patch(store);
  fs.writeFileSync(file, JSON.stringify(store));
  return () => {
    const now = JSON.parse(fs.readFileSync(file, 'utf8'));
    now.settings = restore;
    fs.writeFileSync(file, JSON.stringify(now));
  };
}

function readServerStore() {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8'));
}

test('로컬 서버 저장소 순서 큐: 일괄 조회가 카카오톡 전송을 기다리는 동안 들어온 다시 훑기·등록을 옛 사본으로 덮어쓰지 않는다', async () => {
  await serverCall('DELETE', '/api/target-alerts');
  const bodyA = { origin: 'ICN', destination: 'TAO', targetPrice: 200000, windowDays: 30, minNights: 2, maxNights: 4, adults: 1 };
  const alertA = (await serverCall('POST', '/api/target-alerts', bodyA)).body.alert;
  const alertB = (await serverCall('POST', '/api/target-alerts', { origin: 'PUS', destination: 'KIX', targetPrice: HIGH_TARGET, windowDays: 30 })).body.alert;
  // B 는 다음 일괄 조회에서 카톡을 보내고(가짜 토큰), A 는 이번에 보내지 않는다
  const restoreSettings = patchServerStore((store) => {
    store.settings.kakaoAccessToken = 'dummy-token-for-test';
    store.targetAlerts.find((a) => a.id === alertB.id).lastNotifiedAt = null;
    Object.assign(store.targetAlerts.find((a) => a.id === alertA.id), { lastNotifiedAt: new Date().toISOString(), lastNotifiedPriceKrw: 1 });
  });
  const realFetch = global.fetch;
  let kakaoSends = 0;
  global.fetch = async (url, options) => {
    if (String(url).includes('kapi.kakao.com')) {
      kakaoSends += 1;
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { ok: true, status: 200, json: async () => ({ result_code: 0 }), text: async () => '' };
    }
    return realFetch(url, options);
  };
  try {
    const batch = serverCall('POST', '/api/batch-check');
    await new Promise((resolve) => setTimeout(resolve, 80)); // 일괄 조회가 저장소를 읽고 카톡 전송을 기다리는 사이
    const d1 = addDays(TODAY, 6);
    const scanResult = proxyTargetScan(bodyA, [
      ['OUTBOUND', d1, 'ICN', 80000],
      ['INBOUND', addDays(d1, 3), 'ICN', 70000]
    ]);
    const [scanned, created, batchRes] = await Promise.all([
      serverCall('POST', `/api/target-alerts/${alertA.id}/scan`, { scanResult }),
      serverCall('POST', '/api/target-alerts', { origin: 'ICN', destination: 'NRT', targetPrice: 1000, windowDays: 30 }),
      batch
    ]);
    assert.equal(batchRes.status, 200);
    assert.ok(kakaoSends >= 1, '일괄 조회가 카톡 전송을 기다리는 경우를 시험한다');
    assert.equal(scanned.status, 200);
    assert.equal(created.status, 201);
    const stored = readServerStore();
    assert.equal(
      stored.targetAlerts.find((a) => a.id === alertA.id).sourceApi,
      'TRAVELPAYOUTS_PRICES',
      '실제 운임 결과가 일괄 조회의 옛 사본(모의 가격)으로 되돌아가지 않는다'
    );
    assert.ok(stored.targetAlerts.some((a) => a.id === created.body.alert.id), '그사이 등록한 알림이 사라지지 않는다');
  } finally {
    global.fetch = realFetch;
    restoreSettings();
    await serverCall('DELETE', '/api/target-alerts');
  }
});

test('로컬 서버 일괄 조회: 한 노선의 조회가 실패해도(외부 API 장애·시간 초과) 목표가 알림은 계속 훑고, 실패한 노선 수와 이유를 돌려준다', async () => {
  const created = await serverCall('POST', '/api/target-alerts', { origin: 'ICN', destination: 'FUK', targetPrice: HIGH_TARGET, windowDays: 30 });
  assert.equal(created.status, 201);
  const id = created.body.alert.id;
  assert.ok(readServerStore().watchRules.some((r) => r.isActive), '조회할 날짜 지정 알림(예시)이 있어야 한다');
  const restoreSettings = patchServerStore((store) => {
    Object.assign(store.settings, { preferredDataSource: 'AMADEUS', amadeusClientId: 'x', amadeusClientSecret: 'y' });
    store.targetAlerts.find((a) => a.id === id).lastCheckedAt = '2020-01-01T00:00:00.000Z';
  });
  const realFetch = global.fetch;
  const amadeusSignals = [];
  // Amadeus 가 응답하지 않아 시간 제한(AbortSignal.timeout)에 걸린 것처럼
  global.fetch = async (url, options) => {
    if (String(url).includes('amadeus.com')) {
      amadeusSignals.push(options?.signal);
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }
    return realFetch(url, options);
  };
  try {
    const batch = await serverCall('POST', '/api/batch-check');
    assert.equal(batch.status, 200);
    assert.ok(batch.body.checkedTargetAlerts >= 1);
    assert.notEqual(readServerStore().targetAlerts.find((a) => a.id === id).lastCheckedAt, '2020-01-01T00:00:00.000Z');
    assert.equal(batch.body.checkedGroups, 0, '실패한 노선은 조회한 것으로 세지 않는다');
    assert.ok(batch.body.failedGroups >= 1);
    assert.equal(batch.body.failedTargetAlerts, 0);
    assert.match(batch.body.failureReason, /Amadeus 응답이 15초 안에 오지 않음/);
    assert.ok(amadeusSignals.length >= 1 && amadeusSignals.every((signal) => signal instanceof AbortSignal), 'Amadeus 요청마다 시간 제한');
  } finally {
    global.fetch = realFetch;
    restoreSettings();
    await serverCall('DELETE', '/api/target-alerts');
  }
});

test('Pages 내장 엔진: 브라우저 저장소에 저장하지 못하면 등록됐다고 하지 않고 507 로 알린다', async () => {
  const storage = memoryStorage();
  const call = loadStandaloneCall({}, storage);
  assert.equal((await call('GET', '/api/dashboard')).status, 200);
  const setItem = storage.setItem;
  storage.setItem = () => {
    const err = new Error('The quota has been exceeded.');
    err.name = 'QuotaExceededError';
    throw err;
  };
  const res = await call('POST', '/api/target-alerts', { origin: 'ICN', destination: 'FUK', targetPrice: HIGH_TARGET, windowDays: 30 });
  assert.equal(res.status, 507);
  assert.equal(res.body.code, 'STORAGE_FULL');
  assert.match(res.body.error, /저장하지 못했습니다/);
  storage.setItem = setItem;
  assert.equal((await call('GET', '/api/dashboard')).body.targetAlerts.length, 0, '저장하지 못한 알림은 없다');
});
