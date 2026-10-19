/**
 * 목표가 알림 공유 로직 (src/services/targetAlerts.js) — 로컬 서버와 Pages 번들이 함께 쓴다
 * - 입력 검증, 모의 가격 훑기, 브라우저가 보낸 실제 운임(Travelpayouts) 결과 재검증, 알림 판단, 카카오톡 문구, 화면용 정리
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createTargetAlert,
  runTargetScan,
  applyTargetScan,
  shouldNotifyTargetAlert,
  markTargetAlertNotified,
  buildTargetAlertMessage,
  targetAlertLogEntry,
  enrichTargetAlert,
  kstToday
} = require('../src/services/targetAlerts');
const { proxyTargetScan: proxyScan, FETCHED_AT } = require('./fixtures/target-scan');

const TODAY = kstToday();
const NOW_ISO = new Date().toISOString();
const HOUR_MS = 3600000;

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const BODY = { origin: 'ICN', destination: 'TAO', targetPrice: 200000, adults: 2, children: 1, infants: 0, directOnly: true };

function newAlert(overrides = {}) {
  let seq = 0;
  return createTargetAlert({ ...BODY, ...overrides }, { nowIso: NOW_ISO, makeId: (p) => `${p}_${++seq}` });
}

function assertCode(fn, code) {
  assert.throws(fn, (err) => err.code === code, `오류 코드 ${code} 를 기대`);
}

test('목표가 알림 만들기: 기본값(3개월·2~5박·직항)과 입력 검증', () => {
  const alert = newAlert();
  assert.equal(alert.id, 'talert_1');
  assert.equal(alert.kind, 'TARGET_PRICE');
  assert.equal(alert.origin, 'ICN');
  assert.equal(alert.destination, 'TAO');
  assert.equal(alert.targetPrice, 200000);
  assert.equal(alert.windowDays, 90);
  assert.equal(alert.minNights, 2);
  assert.equal(alert.maxNights, 5);
  assert.equal(alert.directOnly, true);
  assert.equal(alert.isActive, true);
  assert.equal(alert.sourceApi, 'ONEWAY_COMBO_ENGINE');
  assert.equal(alert.lastScan, null);
  assert.deepEqual([alert.adults, alert.children, alert.infants], [2, 1, 0]);

  assert.equal(newAlert({ origin: 'all_korea', targetPrice: '186437.4' }).targetPrice, 186437, '금액은 원 단위로 반올림');
  assert.equal(newAlert({ origin: 'all_korea' }).origin, 'ALL_KOREA');
  assert.equal(newAlert({ directOnly: false }).directOnly, false);
  assert.equal(newAlert({ customDestinationCity: '<b>칭다오</b>"' }).customDestinationCity, 'b칭다오/b');
  assert.deepEqual(
    (({ windowDays, minNights, maxNights }) => [windowDays, minNights, maxNights])(newAlert({ windowDays: 180, minNights: 3, maxNights: 3 })),
    [180, 3, 3]
  );

  assertCode(() => newAlert({ origin: 'NRT' }), 'BAD_TARGET_ALERT');
  assertCode(() => newAlert({ destination: 'TOKYO' }), 'BAD_TARGET_ALERT');
  assertCode(() => newAlert({ destination: 'GMP' }), 'BAD_TARGET_ALERT');
  assertCode(() => newAlert({ origin: 'ALL_KOREA', destination: 'icn' }), 'BAD_TARGET_ALERT');
  for (const targetPrice of [0, -1, 'abc', null, 999, 25000000]) {
    assertCode(() => newAlert({ targetPrice }), 'BAD_TARGET_PRICE');
  }
  assertCode(() => newAlert({ windowDays: 5 }), 'BAD_TARGET_ALERT');
  assertCode(() => newAlert({ windowDays: 200 }), 'BAD_TARGET_ALERT');
  assertCode(() => newAlert({ windowDays: 30.5 }), 'BAD_TARGET_ALERT');
  assertCode(() => newAlert({ minNights: 4, maxNights: 3 }), 'BAD_TARGET_ALERT');
  assertCode(() => newAlert({ minNights: 0 }), 'BAD_TARGET_ALERT');
  assertCode(() => newAlert({ adults: 0 }), 'BAD_TARGET_ALERT');
  assertCode(() => newAlert({ adults: 10 }), 'BAD_TARGET_ALERT');
  assertCode(() => newAlert({ adults: 1, infants: 2 }), 'BAD_TARGET_ALERT');
});

test('모의 가격으로 훑기: 내일부터 기간 안, 박수 범위 안, 목표가 이하인 날만 하루 한 건씩 싼 순서로', () => {
  const alert = newAlert({ origin: 'ALL_KOREA', destination: 'NRT', windowDays: 30, minNights: 2, maxNights: 4, targetPrice: 19000000 });
  const scan = runTargetScan(alert, { today: TODAY });
  assert.equal(scan.sourceApi, 'ONEWAY_COMBO_ENGINE');
  assert.equal(scan.fromDate, addDays(TODAY, 1));
  assert.equal(scan.toDate, addDays(TODAY, 30));
  assert.equal(scan.scannedDays, 30);
  assert.equal(scan.matchCount, 30, '목표가가 아주 높으면 모든 날이 목표가 이하');
  assert.equal(scan.matches.length, 20, '목록은 20개까지');
  const deps = scan.matches.map((m) => m.departureDate);
  assert.equal(new Set(deps).size, deps.length, '하루 한 건');
  scan.matches.forEach((m, i) => {
    assert.ok(m.departureDate >= scan.fromDate && m.departureDate <= scan.toDate);
    assert.ok(m.stayNights >= 2 && m.stayNights <= 4);
    assert.equal(m.bookingLinks.bookingMeta.adults, 2, '예약 링크는 알림 인원으로');
    if (i > 0) assert.ok(scan.matches[i - 1].combinedAdultPriceKrw <= m.combinedAdultPriceKrw);
  });

  const median = scan.matches[10].combinedAdultPriceKrw;
  const tight = runTargetScan({ ...alert, targetPrice: median }, { today: TODAY });
  assert.ok(tight.matches.every((m) => m.combinedAdultPriceKrw <= median));
  assert.ok(tight.matchCount >= 11);
});

test('실제 운임(브라우저가 보낸 Travelpayouts 결과): 일정·편도를 다시 검증하고 예약 링크는 앱이 다시 만든다', () => {
  const alert = newAlert({ windowDays: 30, minNights: 2, maxNights: 4, targetPrice: 200000 });
  const d1 = addDays(TODAY, 5);
  const d2 = addDays(TODAY, 9);
  const raw = proxyScan(alert, [
    ['OUTBOUND', d1, 'ICN', 80000],
    ['INBOUND', addDays(d1, 3), 'ICN', 70000],
    ['OUTBOUND', d2, 'ICN', 60000],
    ['INBOUND', addDays(d2, 2), 'ICN', 75000],
    ['OUTBOUND', addDays(TODAY, 12), 'ICN', 150000],
    ['INBOUND', addDays(TODAY, 15), 'ICN', 120000]
  ]);
  assert.deepEqual(
    raw.matches.map((m) => [m.departureDate, m.combinedAdultPriceKrw]),
    [[d2, 135000], [d1, 150000]],
    '프록시 결과 (목표가를 넘는 12일 뒤 일정은 cheapest 후보일 뿐)'
  );

  const forged = JSON.parse(JSON.stringify(raw));
  forged.matches[0].bookingLinks.primaryUrl = 'https://evil.example/phish';
  forged.matches[0].outboundLeg.naverOneWayUrl = 'javascript:alert(1)';
  forged.matches[1].outboundLeg.sourceUrl = 'https://evil.example/aviasales';
  forged.matches.push(
    { ...raw.matches[0], combinedAdultPriceKrw: 1 }, // 같은 날 두 번 → 하루 한 건 (금액은 편도 합으로 다시 계산)
    { ...raw.matches[0], departureDate: addDays(TODAY, 40), returnDate: addDays(TODAY, 42) }, // 기간 밖
    { ...raw.matches[0], returnDate: addDays(d2, 9) }, // 박수 밖
    { ...raw.matches[0], inboundLeg: { ...raw.matches[0].inboundLeg, toAirportCode: 'PUS' } }, // 다른 한국 공항으로 돌아옴
    { ...raw.matches[0], outboundLeg: { ...raw.matches[0].outboundLeg, oneWayPriceKrw: 5 } }, // 금액 이상
    'not-an-object'
  );
  forged.matchCount = 99;

  const scan = runTargetScan(alert, { scanResult: forged, today: TODAY });
  assert.equal(scan.sourceApi, 'TRAVELPAYOUTS_PRICES');
  assert.equal(scan.fetchedAt, FETCHED_AT);
  assert.deepEqual(scan.matches.map((m) => [m.departureDate, m.combinedAdultPriceKrw]), [[d2, 135000], [d1, 150000]]);
  assert.equal(scan.matchCount, 2, '보낸 목록이 다 차지 않았으면(20개 미만) 보낸 개수(99) 대신 검증한 개수');
  assert.equal(scan.cheapest.combinedAdultPriceKrw, 135000);

  const full = runTargetScan(alert, { scanResult: { ...raw, matches: Array(20).fill(raw.matches[0]), matchCount: 99 }, today: TODAY });
  assert.equal(full.matches.length, 1, '같은 날은 한 건');
  assert.equal(full.matchCount, 30, '목록이 다 찼으면 목록 밖의 날은 확인할 수 없어 보낸 개수를 기간 일수(30) 안에서만 받는다');

  // 목표가 이하·가장 싼 일정은 앱이 다시 가린다: '가장 싼 일정'만 보내도 목표가 이하면 찾은 날로 센다
  const cheapestOnly = runTargetScan(alert, { scanResult: { ...raw, matches: [], matchCount: 0, cheapest: raw.matches[0] }, today: TODAY });
  assert.deepEqual(cheapestOnly.matches.map((m) => m.departureDate), [d2]);
  assert.equal(cheapestOnly.matchCount, 1);
  assert.equal(cheapestOnly.cheapest.combinedAdultPriceKrw, 135000);

  // 보낸 일정이 있는데 하나도 검증을 못 넘으면 빈 결과로 지난 결과를 지우지 않게 NO_REAL_FARES (422)
  const outOfWindow = { ...raw.matches[0], departureDate: addDays(TODAY, 40), returnDate: addDays(TODAY, 42) };
  assertCode(() => runTargetScan(alert, { scanResult: { ...raw, matches: [outOfWindow], cheapest: outOfWindow }, today: TODAY }), 'NO_REAL_FARES');

  // 직항만 찾는 알림에 경유 구간이 오면 버린다 (경유 포함 알림은 받는다)
  const withStops = { ...raw.matches[0], outboundLeg: { ...raw.matches[0].outboundLeg, stops: 2 } };
  assertCode(() => runTargetScan(alert, { scanResult: { ...raw, matches: [withStops], cheapest: withStops }, today: TODAY }), 'NO_REAL_FARES');
  const anyStops = runTargetScan({ ...alert, directOnly: false }, { scanResult: { ...raw, matches: [withStops], cheapest: null }, today: TODAY });
  assert.equal(anyStops.matches[0].outboundLeg.stops, 2);

  // 검색한 날·받아 온 시각: 이상하거나 범위 밖이면 버린다 (표시만 하는 값이라 일정은 그대로)
  const odd = JSON.parse(JSON.stringify(raw));
  odd.matches[0].outboundLeg.searchedOn = '9999-99-99';
  odd.matches[0].inboundLeg.searchedOn = addDays(TODAY, -400);
  odd.matches[1].outboundLeg.searchedOn = addDays(TODAY, 5);
  odd.fetchedAt = '+275760-09-13T00:00:00.000Z';
  const oddScan = runTargetScan(alert, { scanResult: odd, today: TODAY });
  assert.deepEqual(
    [oddScan.matches[0].outboundLeg.searchedOn, oddScan.matches[0].inboundLeg.searchedOn, oddScan.matches[1].outboundLeg.searchedOn],
    [null, null, null]
  );
  assert.equal(oddScan.fetchedAt, null);
  const stale = runTargetScan(alert, { scanResult: { ...raw, fetchedAt: new Date(Date.now() - 10 * 24 * HOUR_MS).toISOString() }, today: TODAY });
  assert.equal(stale.fetchedAt, null, '8일보다 오래된 받아 온 시각은 버린다');

  const [best, second] = scan.matches;
  assert.match(best.bookingLinks.primaryUrl, /^https:\/\/flight\.naver\.com\//, '보낸 링크 대신 앱이 만든 링크');
  assert.match(best.outboundLeg.naverOneWayUrl, /^https:\/\/flight\.naver\.com\//);
  assert.equal(best.bookingLinks.bookingMeta.adults, 2);
  assert.equal(best.totalPassengersPriceKrw, 135000 * 2 + 108000, '성인 2 + 소아 1(80%)');
  assert.equal(best.outboundLeg.searchedOn, addDays(TODAY, -1), '검색한 날은 그대로');
  assert.match(best.outboundLeg.sourceUrl, /^https:\/\/www\.aviasales\.com\/search\//, 'Aviasales 주소는 같은 모양만 남긴다');
  assert.equal(second.outboundLeg.sourceUrl, undefined, '다른 주소는 버린다');
  assert.equal(best.outboundLeg.airline, '칭다오항공');

  assertCode(() => runTargetScan(alert, { scanResult: { ...raw, sourceApi: 'SERPAPI_GOOGLE_FLIGHTS' } }), 'BAD_FARE_SOURCE');
  assertCode(() => runTargetScan(alert, { scanResult: { ...raw, sourceApi: 'MADE_UP' } }), 'BAD_FARE_SOURCE');

  const empty = runTargetScan(alert, { scanResult: { sourceApi: 'TRAVELPAYOUTS_PRICES', matches: 'x', matchCount: 7 } });
  assert.equal(empty.matchCount, 0, '검증된 일정이 없으면 보낸 개수를 믿지 않는다');
  assert.equal(empty.cheapest, null);
  assert.equal(empty.fetchedAt, null);

  // 실제 운임으로 받아 온 알림은 결과 없이(모의 가격으로) 다시 훑지 않는다
  const realAlert = applyTargetScan(alert, scan, NOW_ISO);
  assert.equal(realAlert.sourceApi, 'TRAVELPAYOUTS_PRICES');
  assert.equal(realAlert.fareFetchedAt, FETCHED_AT);
  assertCode(() => runTargetScan(realAlert, { today: TODAY }), 'REAL_FARE_NEEDS_PIN');
  assert.equal(alert.lastScan, null, '원래 알림 객체는 바꾸지 않는다');
});

test('카카오톡 알림 판단: 처음 · 더 싼 일정 · 알림 간격이 지났을 때만 (같은 값은 다시 보내지 않음)', () => {
  const now = Date.now();
  const settings = { autoNotifyOnTarget: true, cooldownHours: 12 };
  const base = newAlert({ windowDays: 30, targetPrice: 19000000 });
  const scanned = applyTargetScan(base, runTargetScan(base), NOW_ISO);
  const best = scanned.lastScan.matches[0].combinedAdultPriceKrw;

  assert.equal(shouldNotifyTargetAlert(base, { settings, nowMs: now }), false, '훑기 전');
  assert.equal(shouldNotifyTargetAlert(scanned, { settings, nowMs: now }), true, '처음');
  assert.equal(shouldNotifyTargetAlert(scanned, { settings: { autoNotifyOnTarget: false }, nowMs: now }), false);
  assert.equal(shouldNotifyTargetAlert({ ...scanned, isActive: false }, { settings, nowMs: now }), false);

  const notified = markTargetAlertNotified(scanned, new Date(now).toISOString());
  assert.equal(notified.lastNotifiedPriceKrw, best);
  assert.equal(shouldNotifyTargetAlert(notified, { settings, nowMs: now + HOUR_MS }), false, '같은 값 · 간격 안');
  assert.equal(shouldNotifyTargetAlert(notified, { settings, nowMs: now + 13 * HOUR_MS }), true, '간격이 지남');
  assert.equal(shouldNotifyTargetAlert({ ...notified, lastNotifiedPriceKrw: best + 100 }, { settings, nowMs: now + HOUR_MS }), true, '더 싼 일정');
  assert.equal(shouldNotifyTargetAlert({ ...notified, lastNotifiedAt: 'garbage' }, { settings, nowMs: now }), true);

  const noMatch = applyTargetScan(base, runTargetScan({ ...base, targetPrice: 1000 }), NOW_ISO);
  assert.equal(noMatch.lastScan.matchCount, 0);
  assert.equal(shouldNotifyTargetAlert(noMatch, { settings, nowMs: now }), false, '목표가 이하가 없으면 보내지 않음');
});

test('카카오톡 문구·이력: 목표가 이하 일정 3개와 인원 총액, 없으면 기간 최저가와 목표까지 남은 금액', () => {
  const base = newAlert({ windowDays: 30, targetPrice: 19000000 });
  const fresh = runTargetScan(base);
  const scanned = applyTargetScan(base, fresh, NOW_ISO);
  const msg = buildTargetAlertMessage(scanned);
  const best = scanned.lastScan.matches[0];

  // 저장할 때는 예약 링크를 빼 두고(알림 하나가 9만 자 넘게 커지지 않게), 보여 주거나 보낼 때 같은 링크를 다시 만든다
  assert.equal(best.bookingLinks, undefined);
  assert.equal(best.outboundLeg.naverOneWayUrl, undefined);
  assert.ok(JSON.stringify(scanned).length * 2 < JSON.stringify(fresh).length, '저장 크기가 절반 아래');
  const shown = enrichTargetAlert(scanned);
  assert.deepEqual(shown.matches, fresh.matches, '다시 만든 일정은 훑은 일정과 똑같다 (링크 포함)');
  assert.deepEqual(shown.cheapest, fresh.cheapest);
  assert.equal(msg.bookingUrl, fresh.matches[0].bookingLinks.primaryUrl);
  assert.equal(msg.outboundLeg.naverOneWayUrl, fresh.matches[0].outboundLeg.naverOneWayUrl);

  assert.equal(msg.alertKind, 'TARGET_PRICE');
  assert.equal(msg.fareKind, 'SIMULATED');
  assert.equal(msg.isSimulatedPrice, true);
  assert.equal(msg.routeSummary, '서울/인천(ICN) ↔ 칭다오 (청도)(TAO)');
  assert.equal(msg.matchCount, 30);
  assert.equal(msg.notifiedPrice, best.combinedAdultPriceKrw);
  assert.equal(msg.totalPassengersPriceKrw, best.totalPassengersPriceKrw);
  assert.equal(msg.savedAmount, 19000000 - best.combinedAdultPriceKrw);
  assert.equal(msg.topMatches.length, 3);
  assert.match(msg.scheduleSummary, / 외 목표가 이하 29일 \(직항 · 성인 2명 · 소아 1명\)$/);
  assert.match(msg.messagePreview, /^\[🎯 목표가 알림 · 모의 가격\]/);
  assert.match(msg.messagePreview, /목표가 이하 30일 발견/);
  assert.equal(msg.messagePreview.split('\n').filter((line) => /^ {2}\d\) /.test(line)).length, 3);
  assert.match(msg.templateObject.content.title, /목표가 이하 30일$/);
  const { item_content: itemContent } = msg.templateObject;
  assert.ok(itemContent.profile_text.length <= 16);
  assert.equal(itemContent.items.length, 3);
  itemContent.items.forEach(({ item, item_op: itemOp }) => {
    assert.ok(item.length <= 6, item);
    assert.ok(itemOp.length <= 14, itemOp);
  });

  const none = applyTargetScan(base, runTargetScan({ ...base, targetPrice: 1000 }), NOW_ISO);
  const noneMsg = buildTargetAlertMessage({ ...none, targetPrice: 1000 });
  assert.equal(noneMsg.matchCount, 0);
  assert.equal(noneMsg.savedAmount, 0);
  assert.match(noneMsg.messagePreview, /아직 목표가 이하 없음 — 기간 최저 [\d,]+원 \(목표까지 \+[\d,]+원\)/);
  assert.equal(noneMsg.templateObject.item_content, undefined, '목록이 없으면 항목 칸도 없음');
  assert.match(noneMsg.templateObject.content.title, /목표가 이하 아직 없음$/);

  const log = targetAlertLogEntry(scanned.id, msg, { id: 'noti_1', sentAt: NOW_ISO, status: 'KAKAO_SENT', detail: '보냄' });
  assert.equal(log.ruleId, scanned.id);
  assert.equal(log.alertKind, 'TARGET_PRICE');
  assert.equal(log.status, 'KAKAO_SENT');
  assert.equal(log.matchCount, 30);
  assert.equal(log.topMatches.length, 3);
  assert.equal(log.messagePreview, msg.messagePreview);
});

test('화면용 정리: 출발일이 지난 일정은 빼고 개수를 줄이며, 저장된 목록은 한 번만 내려보낸다', () => {
  const base = newAlert({ windowDays: 30, targetPrice: 19000000 });
  const scanned = applyTargetScan(base, runTargetScan(base), NOW_ISO);
  const view = enrichTargetAlert(scanned, { today: TODAY });
  assert.equal(view.isTargetReached, true);
  assert.equal(view.matchCount, 30);
  assert.equal(view.matches.length, 20);
  assert.equal(view.bestPriceKrw, view.matches[0].combinedAdultPriceKrw);
  assert.equal(view.lastScan.matches, undefined, '목록은 matches 로만');
  assert.equal(view.lastScan.scannedDays, 30);
  assert.equal(view.windowLabel, '1개월');
  assert.equal(view.passengerSummaryText, '성인 2명 · 소아 1명');
  assert.equal(view.routeSummary, '서울/인천(ICN) ↔ 칭다오 (청도)(TAO)');
  assert.equal(view.checkedToday, true);
  assert.equal(view.isRealFare, false);

  // 열흘 뒤에 보면: 그사이 출발일이 지난 일정은 빠진다
  const later = addDays(TODAY, 10);
  const laterView = enrichTargetAlert(scanned, { today: later });
  assert.ok(laterView.matches.every((m) => m.departureDate > later));
  const expired = scanned.lastScan.matches.filter((m) => m.departureDate <= later).length;
  assert.equal(laterView.matchCount, 30 - expired);
  assert.equal(laterView.checkedToday, false);

  const unscanned = enrichTargetAlert(base, { today: TODAY });
  assert.equal(unscanned.isTargetReached, false);
  assert.equal(unscanned.cheapest, null);
  assert.equal(unscanned.gapToTargetKrw, null);
  assert.equal(unscanned.lastScan, null);
});
