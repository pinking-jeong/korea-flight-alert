/**
 * GitHub Pages(서버 없음)에서 쓰이는 브라우저 내장 엔진(standaloneEngine.js) 회귀 테스트
 * - 번들을 메모리에서 생성해 가짜 localStorage 위에서 실행합니다 (public/, docs/ 파일은 건드리지 않음)
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { buildStandaloneSource } = require('../scripts/build-standalone');
const { fetchLowestRoundTripPrice } = require('../src/services/flightApiService');

const LEGACY_KEY_V3 = 'SKYBELL_KR_STANDALONE_STORE_V3';
const CURRENT_KEY = 'SKYBELL_KR_STANDALONE_STORE_V4';

function futureDate(days) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

function createLocalStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key)
  };
}

function loadEngine(storage = createLocalStorage()) {
  const fakeWindow = {
    location: { origin: 'https://pinking-jeong.github.io', pathname: '/korea-flight-alert/' }
  };
  // eslint-disable-next-line no-new-func
  new Function('window', 'localStorage', buildStandaloneSource())(fakeWindow, storage);
  return { api: fakeWindow.SkyBellStandaloneApi, storage };
}

async function call(api, method, url, body) {
  const options = { method };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  const res = await api.handleRequest(url, options);
  return { status: res.status, ok: res.ok, body: await res.json() };
}

function extractFrontendApiPaths() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const re = /apiFetch\(\s*[`'"](\/api\/[^`'"?]*)/g;
  const found = new Set();
  let m;
  while ((m = re.exec(src))) {
    found.add(m[1].replace(/\$\{[^}]+\}/g, ':id'));
  }
  return [...found];
}

test('번들이 프런트엔드가 호출하는 모든 /api 경로를 처리한다 (Pages에서 404 없음)', async () => {
  const { api } = loadEngine();
  const dep = futureDate(30);
  const ret = futureDate(33);

  const handled = [];
  const expectHandled = async (method, pathTemplate, url, body) => {
    const res = await call(api, method, url, body);
    assert.notEqual(res.status, 404, `${method} ${url} → 404 ${JSON.stringify(res.body)}`);
    handled.push(pathTemplate);
    return res;
  };

  await expectHandled('GET', '/api/meta', '/api/meta');
  await expectHandled('POST', '/api/custom-destinations', '/api/custom-destinations', {
    code: 'HEL', city: '헬싱키', country: '핀란드', region: '유럽', avg2YKrw: 980000
  });
  await expectHandled('GET', '/api/anywhere-top10', '/api/anywhere-top10?origin=ALL_KOREA&region=ALL&sortBy=LOWEST_PRICE&limit=30');
  await expectHandled('GET', '/api/return-date-matrix', `/api/return-date-matrix?origin=ICN&destination=FUK&departureDate=${dep}`);
  await expectHandled('GET', '/api/schedule-recommendations', '/api/schedule-recommendations?origin=ICN&destination=FUK&minNights=3&maxNights=5');
  await expectHandled('GET', '/api/route-price-trend', `/api/route-price-trend?origin=ICN&destination=FUK&departureDate=${dep}&returnDate=${ret}`);
  await expectHandled('GET', '/api/dashboard', '/api/dashboard');

  const created = await expectHandled('POST', '/api/rules', '/api/rules', {
    origin: 'ICN', destination: 'FUK', departureDate: dep, returnDate: ret,
    targetPrice: 300000, directOnly: true, adults: 1, children: 0, infants: 0
  });
  const ruleId = created.body.rule.id;
  await expectHandled('POST', '/api/rules/:id/check', `/api/rules/${ruleId}/check`, {});
  const notified = await expectHandled('POST', '/api/rules/:id/notify', `/api/rules/${ruleId}/notify`);
  await expectHandled('DELETE', '/api/notifications/:id', `/api/notifications/${notified.body.notificationResult.id}`);
  await expectHandled('DELETE', '/api/notifications', '/api/notifications');
  await expectHandled('POST', '/api/batch-check', '/api/batch-check');
  await expectHandled('GET', '/api/settings', '/api/settings');
  await expectHandled('POST', '/api/settings', '/api/settings', { preferredDataSource: 'AUTO' });
  await expectHandled('DELETE', '/api/rules/:id', `/api/rules/${ruleId}`);
  await expectHandled('DELETE', '/api/rules', '/api/rules');

  for (const frontendPath of extractFrontendApiPaths()) {
    assert.ok(handled.includes(frontendPath), `app.js가 부르는 ${frontendPath} 경로가 이 테스트에 없습니다`);
  }
});

test('가격 추이는 요청한 도착 도시를 따른다 (도쿄 나리타 고정 아님)', async () => {
  const { api } = loadEngine();
  const dep = futureDate(30);
  const ret = futureDate(34);
  const trend = async (dest) =>
    (await call(api, 'GET', `/api/route-price-trend?origin=ICN&destination=${dest}&departureDate=${dep}&returnDate=${ret}`)).body;

  const fuk = await trend('FUK');
  const bkk = await trend('BKK');

  assert.equal(fuk.destination, 'FUK');
  assert.match(fuk.destinationCity, /후쿠오카/);
  assert.equal(bkk.destination, 'BKK');
  assert.equal(fuk.stayNights, 4);
  assert.equal(fuk.points.length, 15);
  assert.ok(fuk.points.some((p) => p.isSelectedDate && p.departureDate === dep));
  assert.notDeepEqual(
    fuk.points.map((p) => p.combinedAdultPriceKrw),
    bkk.points.map((p) => p.combinedAdultPriceKrw)
  );
});

test('카카오톡 알림 이력은 한 건씩, 또는 전체를 삭제할 수 있다', async () => {
  const { api } = loadEngine();
  const ruleId = (await call(api, 'GET', '/api/dashboard')).body.watchRules[0].id;
  await call(api, 'POST', `/api/rules/${ruleId}/notify`);
  await call(api, 'POST', `/api/rules/${ruleId}/notify`);
  const before = (await call(api, 'GET', '/api/dashboard')).body.notificationLogs;
  assert.ok(before.length >= 2);

  const target = before[0];
  const del = await call(api, 'DELETE', `/api/notifications/${target.id}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.deletedId, target.id);

  const afterOne = (await call(api, 'GET', '/api/dashboard')).body.notificationLogs;
  assert.equal(afterOne.length, before.length - 1);
  assert.ok(!afterOne.some((n) => n.id === target.id));

  const missing = await call(api, 'DELETE', '/api/notifications/noti_does_not_exist');
  assert.equal(missing.status, 404);

  const all = await call(api, 'DELETE', '/api/notifications');
  assert.equal(all.status, 200);
  assert.equal(all.body.deletedCount, afterOne.length);
  const emptied = (await call(api, 'GET', '/api/dashboard')).body;
  assert.equal(emptied.notificationLogs.length, 0);
  assert.equal(emptied.notificationLogsTotal, 0);
});

test('Pages 엔진이 남기는 카카오톡 알림 이력도 모의 가격임을 표시한다 (서버와 같은 기준)', async () => {
  const { api } = loadEngine();
  const ruleId = (await call(api, 'GET', '/api/dashboard')).body.watchRules[0].id;
  const notified = (await call(api, 'POST', `/api/rules/${ruleId}/notify`)).body.notificationResult;

  assert.equal(notified.isSimulatedPrice, true);
  assert.match(notified.messagePreview, /모의 가격/);

  // 마지막 조회가 실제 운임 출처(Amadeus 운영 환경)였던 규칙의 수동 알림에는 모의 표시를 붙이지 않는다
  const { api: liveApi, storage } = loadEngine();
  const liveRuleId = (await call(liveApi, 'GET', '/api/dashboard')).body.watchRules[0].id;
  const saved = JSON.parse(storage.getItem(CURRENT_KEY));
  saved.watchRules.find((r) => r.id === liveRuleId).sourceApi = 'AMADEUS_ONEWAY_COMBO';
  storage.setItem(CURRENT_KEY, JSON.stringify(saved));
  const live = (await call(liveApi, 'POST', `/api/rules/${liveRuleId}/notify`)).body.notificationResult;
  assert.equal(live.isSimulatedPrice, false);
  assert.doesNotMatch(live.messagePreview, /모의/);
});

test('V3 브라우저 저장소의 규칙·이력·알림·사용자 도시를 V4로 옮겨 보존한다', async () => {
  const legacyRule = {
    id: 'rule_user_kept',
    origin: 'PUS',
    destination: 'TPE',
    departureDate: futureDate(40),
    returnDate: futureDate(44),
    directOnly: true,
    adults: 2,
    children: 0,
    infants: 0,
    targetPrice: 230000,
    currentLowestPrice: 241000,
    isActive: true,
    outboundLeg: { airline: '제주항공', airlineCode: '7C', oneWayPriceKrw: 120000 },
    inboundLeg: { airline: '티웨이항공', airlineCode: 'TW', oneWayPriceKrw: 121000 }
  };
  const legacyStore = {
    schemaVersion: 3,
    customDestinations: [
      {
        code: 'HEL',
        city: '헬싱키',
        country: '핀란드',
        region: '유럽',
        basePriceKrw: 980000,
        flightDuration: '직접 등록 노선',
        benchmark2Y: { avg2YKrw: 980000, lowest2YKrw: 529000, top10Deal2YKrw: 706000, peakHigh2YKrw: 1686000 }
      }
    ],
    settings: { preferredDataSource: 'AUTO', cooldownHours: 6 },
    watchRules: [legacyRule],
    priceHistories: [{ id: 'ph_kept', ruleId: 'rule_user_kept', priceKrw: 241000, recordedAt: new Date().toISOString() }],
    notificationLogs: [{ id: 'noti_kept', ruleId: 'rule_user_kept', routeSummary: '부산 ↔ 타이베이', notifiedPrice: 241000 }],
    apiQuotaStats: { simulationCallsThisMonth: 42 }
  };
  const storage = createLocalStorage({ [LEGACY_KEY_V3]: JSON.stringify(legacyStore) });
  const { api } = loadEngine(storage);

  const dashboard = (await call(api, 'GET', '/api/dashboard')).body;
  assert.deepEqual(dashboard.watchRules.map((r) => r.id), ['rule_user_kept']);
  assert.deepEqual(dashboard.notificationLogs.map((n) => n.id), ['noti_kept']);
  assert.equal(dashboard.historiesByRule.rule_user_kept.length, 1);

  const settings = (await call(api, 'GET', '/api/settings')).body;
  assert.equal(settings.cooldownHours, 6);

  const meta = (await call(api, 'GET', '/api/meta')).body;
  const hel = meta.destinations.find((d) => d.code === 'HEL');
  assert.ok(hel, '사용자 도시 HEL이 남아 있어야 함');
  assert.equal(hel.benchmark2Y.avg2YKrw, 980000);
  assert.equal(hel.benchmark2Y.monthlyStats2Y.length, 12);
  assert.equal(hel.benchmark2Y.dayOfWeekStats2Y.length, 7);

  const saved = JSON.parse(storage.getItem(CURRENT_KEY));
  assert.equal(saved.schemaVersion, 4);
});

function staleV3Rule(overrides = {}) {
  return {
    id: 'rule_stale',
    origin: 'PUS',
    destination: 'TPE',
    departureDate: futureDate(40),
    returnDate: futureDate(44),
    directOnly: true,
    adults: 2,
    children: 0,
    infants: 0,
    targetPrice: 100000,
    currentLowestPrice: 999999,
    previousPrice: 888888,
    isActive: true,
    ...overrides
  };
}

test('V3에서 옮겨 온 규칙의 옛 가격은 첫 조회 때 알림 없이 현재 엔진 가격으로 맞춘다', async () => {
  const rule = staleV3Rule();
  const storage = createLocalStorage({
    [LEGACY_KEY_V3]: JSON.stringify({
      schemaVersion: 3, settings: {}, customDestinations: [], watchRules: [rule], priceHistories: [], notificationLogs: []
    })
  });
  const { api } = loadEngine(storage);

  const dashboard = (await call(api, 'GET', '/api/dashboard')).body;
  const migrated = dashboard.watchRules.find((r) => r.id === 'rule_stale');
  const { offer } = await fetchLowestRoundTripPrice(rule, {});
  assert.equal(migrated.currentLowestPrice, offer.priceKrw);
  assert.equal(migrated.previousPrice, 888888, '이전 가격 기록은 그대로');
  assert.equal(dashboard.notificationLogsTotal, 0, '조용히 맞춤 (알림 없음)');
  assert.equal(JSON.parse(storage.getItem(CURRENT_KEY)).watchRules[0].needsReprice, undefined);
});

// 규칙에 저장되는 가격 관련 필드 ↔ 조회 결과(offer) 필드 (서버판 schedulerService.applyOfferToRule 과 같은 목록)
const RULE_OFFER_FIELDS = [
  ['currentLowestPrice', 'priceKrw'],
  ['sameAirlineBundledPriceKrw', 'sameAirlineBundledPriceKrw'],
  ['mixMatchSavingsKrw', 'mixMatchSavingsKrw'],
  ['isDifferentAirlineCombo', 'isDifferentAirlineCombo'],
  ['outboundLeg', 'outboundLeg'],
  ['inboundLeg', 'inboundLeg'],
  ['latestAirline', 'airline'],
  ['latestAirlineCode', 'airlineCode'],
  ['flightNumber', 'flightNumber'],
  ['baggageInfo', 'baggageInfo'],
  ['departureTime', 'departureTime'],
  ['returnTime', 'returnTime'],
  ['sourceApi', 'sourceApi'],
  ['fareFetchedAt', 'fareFetchedAt'],
  ['bookingLinks', 'bookingLinks']
];
const STALE_OFFER_FIELDS = {
  sameAirlineBundledPriceKrw: 999999, mixMatchSavingsKrw: 999999, isDifferentAirlineCombo: 'stale',
  outboundLeg: { flightNumber: 'XX001' }, inboundLeg: { flightNumber: 'XX002' }, latestAirline: 'stale',
  latestAirlineCode: 'XX', flightNumber: 'XX000', baggageInfo: 'stale', departureTime: '00:00',
  returnTime: '00:00', sourceApi: 'stale', fareFetchedAt: 'stale', bookingLinks: { naverUrl: 'stale' }
};

function poisonStoredRule(storage, ruleId) {
  const saved = JSON.parse(storage.getItem(CURRENT_KEY));
  Object.assign(saved.watchRules.find((r) => r.id === ruleId), STALE_OFFER_FIELDS);
  storage.setItem(CURRENT_KEY, JSON.stringify(saved));
}

function assertStoredRuleMatchesOffer(storage, ruleId, offer, label) {
  const stored = JSON.parse(storage.getItem(CURRENT_KEY)).watchRules.find((r) => r.id === ruleId);
  const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
  for (const [ruleKey, offerKey] of RULE_OFFER_FIELDS) {
    assert.deepEqual(stored[ruleKey], plain(offer[offerKey]), `${label}: ${ruleKey}`);
  }
}

test('옮겨 온 규칙·재조회·일괄 조회 모두 서버와 같은 가격 관련 필드를 새 조회 결과로 맞춘다 (절약액·편명·시간 등)', async () => {
  const rule = staleV3Rule(STALE_OFFER_FIELDS);
  const storage = createLocalStorage({
    [LEGACY_KEY_V3]: JSON.stringify({
      schemaVersion: 3, settings: {}, customDestinations: [], watchRules: [rule], priceHistories: [], notificationLogs: []
    })
  });
  const { api } = loadEngine(storage);
  const { offer } = await fetchLowestRoundTripPrice(rule, {});

  await call(api, 'GET', '/api/dashboard');
  assertStoredRuleMatchesOffer(storage, 'rule_stale', offer, '옮겨 온 규칙');

  poisonStoredRule(storage, 'rule_stale');
  assert.equal((await call(api, 'POST', '/api/rules/rule_stale/check', {})).status, 200);
  assertStoredRuleMatchesOffer(storage, 'rule_stale', offer, '재조회');

  poisonStoredRule(storage, 'rule_stale');
  assert.equal((await call(api, 'POST', '/api/batch-check')).status, 200);
  assertStoredRuleMatchesOffer(storage, 'rule_stale', offer, '일괄 조회');
});

test('V3 저장소의 문자열 버전·빠진 배열·잘못된 규칙도 사용자 데이터만 옮기고, 손상된 V4 저장소는 따로 보관한다', async () => {
  const storage = createLocalStorage({
    [LEGACY_KEY_V3]: JSON.stringify({ schemaVersion: '3', settings: {}, watchRules: [null, 'broken', staleV3Rule({ id: 'rule_ok' })] })
  });
  const { api } = loadEngine(storage);
  const dashboard = (await call(api, 'GET', '/api/dashboard')).body;
  assert.deepEqual(dashboard.watchRules.map((r) => r.id), ['rule_ok']);
  assert.equal(dashboard.notificationLogsTotal, 0, '샘플 알림을 끼워 넣지 않음');
  assert.deepEqual(Object.keys(dashboard.historiesByRule), [], '샘플 가격 이력을 끼워 넣지 않음');

  const broken = '{"schemaVersion":4,"watchRules":[{"id":"precious_rule"';
  const corruptStorage = createLocalStorage({ [CURRENT_KEY]: broken });
  const { api: corruptApi } = loadEngine(corruptStorage);
  assert.equal((await call(corruptApi, 'GET', '/api/dashboard')).status, 200);
  assert.equal(corruptStorage.getItem(`${CURRENT_KEY}_CORRUPT_BACKUP`), broken);
});

test('모든 도착 도시가 월별 12개·요일별 7개의 가는 편/오는 편 평균을 제공한다', async () => {
  const { api } = loadEngine();
  const meta = (await call(api, 'GET', '/api/meta')).body;
  assert.ok(meta.destinations.length >= 70);
  for (const dest of meta.destinations) {
    const { monthlyStats2Y, dayOfWeekStats2Y } = dest.benchmark2Y;
    assert.equal(monthlyStats2Y.length, 12, `${dest.code} 월별 통계`);
    assert.equal(dayOfWeekStats2Y.length, 7, `${dest.code} 요일별 통계`);
    for (const row of [...monthlyStats2Y, ...dayOfWeekStats2Y]) {
      assert.ok(row.outboundAvgKrw > 0 && row.inboundAvgKrw > 0, `${dest.code} ${row.label} 값`);
    }
  }
});
