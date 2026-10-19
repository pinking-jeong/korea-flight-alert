/**
 * 노선·인원 설정의 ±3일 최저가 목록과 목표가 알림 화면 (public/flexTargetUi.js)
 * - 화면 스크립트와 Pages 번들을 VM 에 함께 올려 화면 → 앱 API(번들 · 가짜 localStorage) → 프록시(가짜) 흐름을 확인한다
 * - 실제 운임 모드는 프록시의 flex-dates · target-scan(Travelpayouts)만 부르고 구글 플라이트(SerpApi)는 부르지 않는다
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { getFlexibleDateDeals } = require('../src/services/flightApiService');
const { kstToday } = require('../src/services/targetAlerts');
const { PROXY_URL, jsonResponse, loadClient, enableRealMode } = require('./helpers/client-vm');
const { makeProxyQuote, proxyTargetScanResponse, addDays, FETCHED_AT } = require('./fixtures/target-scan');

const STORE_KEY = 'SKYBELL_KR_STANDALONE_STORE_V4';
const NO_EVENT = { preventDefault() {} };
const LEG_FIELDS = [
  'airline',
  'airlineCode',
  'flightNumber',
  'fromAirportCode',
  'toAirportCode',
  'date',
  'scheduleTime',
  'stops',
  'oneWayPriceKrw',
  'searchedOn',
  'sourceUrl'
];

// 화면 스크립트 + Pages 번들 (토스트·스크롤·차트는 기록만, 앱 API 요청은 __appCalls 에 남긴다)
// 번들은 처음 열 때 예시 날짜 지정 알림·알림 이력을 넣어 두므로 지우고 빈 저장소에서 시작한다
async function loadApp(routes = {}) {
  const client = loadClient({ routes, withBundle: true });
  client.run(`
    globalThis.__toasts = [];
    showToast = (message, icon) => { globalThis.__toasts.push({ message, icon }); };
    jumpToSection = (id) => { globalThis.__jumped = id; };
    renderChartRouteSelectOptions = () => {};
    renderPriceChart = () => {};
    loadRoutePriceTrend = async () => {};
    globalThis.__pinModal = 0;
    openRealFarePinModal = () => { globalThis.__pinModal += 1; };
    globalThis.__appCalls = [];
    const handle = window.SkyBellStandaloneApi.handleRequest;
    window.SkyBellStandaloneApi.handleRequest = (url, options = {}) => {
      globalThis.__appCalls.push({ url, method: options.method || 'GET', body: options.body || null });
      return handle(url, options);
    };
  `);
  await client.context.apiFetch('/api/rules', { method: 'DELETE' });
  await client.context.apiFetch('/api/notifications', { method: 'DELETE' });
  client.run('globalThis.__appCalls = [];');
  return client;
}

const plain = (client, expr) => JSON.parse(client.run(`JSON.stringify(${expr})`));
const lastToast = (client) => plain(client, 'globalThis.__toasts[globalThis.__toasts.length - 1]');
const html = (client, id) => client.context.document.getElementById(id).innerHTML;
const text = (client, id) => client.context.document.getElementById(id).textContent;
const proxyCalls = (client, route) => client.calls.filter((c) => c.url.startsWith(`${PROXY_URL}/api/${route}`));
const serpapiCalls = (client) => client.calls.filter((c) => c.url.startsWith(`${PROXY_URL}/api/flights`));
const appCalls = (client, method, path) => plain(client, 'globalThis.__appCalls').filter((c) => c.method === method && c.url === path);
const count = (source, pattern) => (source.match(pattern) || []).length;
const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
const readStore = (client) => JSON.parse(client.context.localStorage.getItem(STORE_KEY));
const writeStore = (client, store) => client.context.localStorage.setItem(STORE_KEY, JSON.stringify(store));

function setInputs(client, values) {
  for (const [id, value] of Object.entries(values)) client.context.document.getElementById(id).value = String(value);
}

function setRouteForm(client, { origin = 'ICN', destination = 'FUK', dep = null, ret = null, adults = 1 } = {}) {
  setInputs(client, { inputOrigin: origin, inputDestination: destination, inputAdults: adults, inputChildren: 0, inputInfants: 0 });
  if (dep) setInputs(client, { inputDepDate: dep });
  if (ret) setInputs(client, { inputRetDate: ret });
  client.context.document.getElementById('inputDirectOnly').checked = true;
}

function setTargetForm(client, { targetPrice, windowDays = 90, minNights = 2, maxNights = 5 }) {
  setInputs(client, {
    inputTargetPrice: targetPrice,
    inputTargetWindow: windowDays,
    inputTargetMinNights: minNights,
    inputTargetMaxNights: maxNights
  });
}

// 어제 훑은 것처럼 바꾸고 대시보드를 다시 불러온다 (checkedToday 는 앱 API 가 계산)
async function markCheckedLongAgo(client) {
  const store = readStore(client);
  store.targetAlerts.forEach((alert) => {
    alert.lastCheckedAt = '2020-01-01T00:00:00.000Z';
  });
  writeStore(client, store);
  await client.context.loadDashboard();
}

async function waitFor(predicate, tries = 200) {
  for (let i = 0; i < tries && !predicate(); i++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(predicate(), '기다린 조건이 끝내 오지 않음');
}

// 목표가 알림 시험용 노선: 오늘+10 출발 3박 150,000원(목표가 이하) · 오늘+30 출발 3박 290,000원
const TARGET_ALERT = {
  origin: 'ICN',
  destination: 'TAO',
  targetPrice: 200000,
  windowDays: 90,
  minNights: 2,
  maxNights: 5,
  adults: 1,
  children: 0,
  infants: 0,
  directOnly: true
};
function targetRows(today = kstToday()) {
  return [
    ['OUTBOUND', addDays(today, 10), 'ICN', 80000],
    ['INBOUND', addDays(today, 13), 'ICN', 70000],
    ['OUTBOUND', addDays(today, 30), 'ICN', 150000],
    ['INBOUND', addDays(today, 33), 'ICN', 140000]
  ];
}
const targetScanRoute = (overrides = {}) => async () =>
  jsonResponse(200, { ...proxyTargetScanResponse(TARGET_ALERT, targetRows()), ...overrides });

async function createTargetAlertFromForm(client, targetPrice = TARGET_ALERT.targetPrice) {
  setRouteForm(client, { destination: TARGET_ALERT.destination });
  setTargetForm(client, { targetPrice });
  return client.context.handleCreateTargetAlert(NO_EVENT);
}

// 프록시 flex-dates 응답 — 찾은 일정 없음 (응답 순서 시험용)
function emptyFlexReply(departureDate) {
  const returnDate = addDays(departureDate, 3);
  return jsonResponse(200, {
    origin: 'ICN', originCity: '서울/인천', destination: 'TAO', destinationCity: '칭다오', departureDate, returnDate,
    flexDays: 3, comboCount: 0,
    requestedDates: { departureDate, returnDate, combinedAdultPriceKrw: null, totalPassengersPriceKrw: null },
    deals: [], realFare: true, fareSource: 'TRAVELPAYOUTS_PRICES', fetchedAt: FETCHED_AT, partial: false
  });
}

// 응답을 붙잡아 두는 시험: 잠금이 풀려 끝없이 기다리면 멈추지 않고 실패하게
const WAIT_LIMIT = { timeout: 15000 };
const element = (client, id) => client.context.document.getElementById(id);
// 마지막으로 초점을 받은 요소 (focusRowToggle 이 찾은 선택자)
const focusedKey = (client) => client.context.document.activeElement?.key || null;

test('±3일 최저가(모의 가격): 입력한 날짜 앞뒤 3일 조합 중 싼 순서로 20개, 첫 일정만 펼쳐 예약 링크·폼 적용·목표가 알림 버튼', async () => {
  const client = await loadApp();
  const dep = addDays(kstToday(), 30);
  const ret = addDays(dep, 4);
  setRouteForm(client, { dep, ret });
  await client.context.handleFlexSearch(NO_EVENT);

  const data = plain(client, 'state.flexDealsData');
  assert.equal(data.deals.length, 20);
  assert.deepEqual(data.query, { origin: 'ICN', destination: 'FUK', directOnly: true, adults: 1, children: 0, infants: 0, departureDate: dep, returnDate: ret });
  const prices = data.deals.map((d) => d.combinedAdultPriceKrw);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b), '싼 순서');
  for (const deal of data.deals) {
    assert.ok(Math.abs(daysBetween(dep, deal.departureDate)) <= 3, deal.departureDate);
    assert.ok(Math.abs(daysBetween(ret, deal.returnDate)) <= 3, deal.returnDate);
    assert.ok(deal.returnDate > deal.departureDate);
  }

  const list = html(client, 'flexResultsList');
  assert.equal(count(list, /aria-expanded=/g), 20);
  assert.equal(count(list, /aria-expanded="true"/g), 1, '첫 일정만 펼친다');
  assert.match(list, /🥇 최저/);
  assert.match(list, /data-simulated-fare-chip/);
  assert.match(list, /data-simulated-fare-note/);
  assert.match(list, /🟢 네이버 <span class="whitespace-nowrap">왕복 ↗<\/span>/);
  assert.match(list, /applyFlexDealToForm\(0\)/);
  assert.match(list, /createTargetAlertFromFlexDeal\(0\)/);
  assert.match(html(client, 'flexResultsSummary'), /입력한 일정 그대로/);
  assert.equal(html(client, 'flexFareSourceLine'), '', '모의 가격이면 출처 줄 없음');
  assert.equal(client.calls.length, 0, '프록시를 부르지 않는다');
  assert.equal(appCalls(client, 'GET', `/api/flex-dates?origin=ICN&destination=FUK&departureDate=${dep}&returnDate=${ret}&flexDays=3&limit=20&adults=1&children=0&infants=0&directOnly=true`).length, 1);

  client.context.toggleFlexDeal(0);
  assert.equal(count(html(client, 'flexResultsList'), /aria-expanded="true"/g), 0, '다시 누르면 접는다');
  client.context.toggleFlexDeal(3);
  assert.match(html(client, 'flexResultsList'), /applyFlexDealToForm\(3\)/);

  // 날짜가 거꾸로면 찾지 않고 알린다 (지난 결과는 그대로)
  setRouteForm(client, { dep: ret, ret: dep });
  assert.equal(await client.context.handleFlexSearch(NO_EVENT), null);
  assert.match(lastToast(client).message, /가는 날·오는 날을 확인하세요/);
  assert.equal(plain(client, 'state.flexDealsData.query.departureDate'), dep);
});

test('±3일 최저가(실제 운임 모드): 프록시 flex-dates(Travelpayouts)만 부르고 출처 줄·검색한 날·Aviasales 링크, 실패하면 모의 가격 + 이유', async () => {
  const dep = addDays(kstToday(), 20);
  const ret = addDays(dep, 3);
  const rows = [];
  for (let shift = -3; shift <= 3; shift++) {
    rows.push(['OUTBOUND', addDays(dep, shift), 'ICN', 100000 + (shift + 3) * 7000]);
    rows.push(['INBOUND', addDays(ret, shift), 'ICN', 90000 + (3 - shift) * 5000]);
  }
  const quote = makeProxyQuote('TAO', rows);
  let reply = jsonResponse(200, {
    ...getFlexibleDateDeals({ origin: 'ICN', destination: 'TAO', departureDate: dep, returnDate: ret, fareQuote: quote }),
    realFare: true,
    fareSource: 'TRAVELPAYOUTS_PRICES',
    fetchedAt: FETCHED_AT,
    partial: false
  });
  const client = await loadApp({ 'GET flex-dates': async () => reply });
  enableRealMode(client);
  setRouteForm(client, { destination: 'TAO', dep, ret });
  await client.context.handleFlexSearch(NO_EVENT);

  const calls = proxyCalls(client, 'flex-dates');
  assert.equal(calls.length, 1);
  const query = Object.fromEntries(new URL(calls[0].url).searchParams);
  assert.deepEqual(query, {
    origin: 'ICN', destination: 'TAO', departureDate: dep, returnDate: ret, flexDays: '3', limit: '20',
    adults: '1', children: '0', infants: '0', directOnly: 'true'
  });
  assert.equal(calls[0].options.headers['X-Access-Pin'], '2468');
  assert.equal(serpapiCalls(client).length, 0, '구글 플라이트(SerpApi) 검색 횟수를 쓰지 않는다');
  assert.equal(appCalls(client, 'GET', `/api/flex-dates?${new URL(calls[0].url).searchParams}`).length, 0, '모의 가격 엔진은 부르지 않는다');

  assert.match(html(client, 'flexFareSourceLine'), /data-fare-source-line="CACHED"/);
  const list = html(client, 'flexResultsList');
  assert.match(list, /data-cached-fare-chip/);
  assert.match(list, /data-cached-fare-note/);
  assert.match(list, /data-searched-on=/);
  assert.match(list, /Aviasales ↗/);
  // 가장 싼 조합 = 가는 날 −3일(100,000) + 오는 날 +3일(90,000)
  assert.equal(plain(client, 'state.flexDealsData.deals[0].combinedAdultPriceKrw'), 190000);
  assert.match(list, /가는 날 −3일 · 오는 날 \+3일/);

  // 프록시가 실패하면(한도 초과) 그 기능만 모의 가격으로 보여 주고 이유를 단다
  reply = jsonResponse(429, { error: 'Travelpayouts 한도 초과', code: 'TP_RATE_LIMIT' });
  await client.context.handleFlexSearch(NO_EVENT);
  assert.match(html(client, 'flexFareSourceLine'), /data-fare-source-line="FALLBACK"/);
  assert.match(html(client, 'flexFareSourceLine'), /무료 조회 한도 초과/);
  assert.match(html(client, 'flexResultsList'), /data-simulated-fare-chip/);
  assert.doesNotMatch(html(client, 'flexResultsList'), /data-searched-on=/);
});

test('±3일 최저가: 조건을 바꿔 다시 찾으면 늦게 온 옛 응답은 버린다', WAIT_LIMIT, async () => {
  const dep = addDays(kstToday(), 20);
  const pending = [];
  const client = await loadApp({ 'GET flex-dates': () => new Promise((resolve) => pending.push(resolve)) });
  enableRealMode(client);
  const reply = (departureDate) =>
    jsonResponse(200, {
      origin: 'ICN', originCity: '서울/인천', destination: 'TAO', destinationCity: '칭다오', departureDate,
      returnDate: addDays(departureDate, 3), flexDays: 3, comboCount: 0,
      requestedDates: { departureDate, returnDate: addDays(departureDate, 3), combinedAdultPriceKrw: null, totalPassengersPriceKrw: null },
      deals: [], realFare: true, fareSource: 'TRAVELPAYOUTS_PRICES', fetchedAt: FETCHED_AT, partial: false
    });

  setRouteForm(client, { destination: 'TAO', dep, ret: addDays(dep, 3) });
  const older = client.context.handleFlexSearch(NO_EVENT);
  setRouteForm(client, { destination: 'TAO', dep: addDays(dep, 7), ret: addDays(dep, 10) });
  const newer = client.context.handleFlexSearch(NO_EVENT);
  await waitFor(() => pending.length === 2);
  pending[1](reply(addDays(dep, 7)));
  await newer;
  pending[0](reply(dep));
  assert.equal(await older, null);
  assert.equal(plain(client, 'state.flexDealsData.query.departureDate'), addDays(dep, 7));
  assert.match(html(client, 'flexResultsList'), /찾지 못했습니다/, '빈 목록 안내');
});

test('목표가 알림 등록(실제 운임 모드): 프록시 target-scan 결과를 줄여 보내고 앱이 다시 검증해 저장, 알림 목록 맨 위 카드·요약 지표에 보인다', async () => {
  const client = await loadApp({ 'GET target-scan': targetScanRoute() });
  enableRealMode(client);
  const result = await createTargetAlertFromForm(client);

  // 프록시는 목표가 스캔 한 번 (구글 플라이트 검색 없음)
  const calls = proxyCalls(client, 'target-scan');
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.fromEntries(new URL(calls[0].url).searchParams), {
    origin: 'ICN', destination: 'TAO', targetPrice: '200000', days: '90', minNights: '2', maxNights: '5',
    adults: '1', children: '0', infants: '0', directOnly: 'true', limit: '20'
  });
  assert.equal(serpapiCalls(client).length, 0);

  // 앱 API 로 보낸 scanResult: 일정·편도 칸만 (예약 링크는 앱이 다시 만든다)
  const posted = appCalls(client, 'POST', '/api/target-alerts');
  assert.equal(posted.length, 1);
  const body = JSON.parse(posted[0].body);
  assert.equal(body.scanResult.sourceApi, 'TRAVELPAYOUTS_PRICES');
  assert.equal(body.scanResult.matches.length, 1);
  const match = body.scanResult.matches[0];
  assert.deepEqual(Object.keys(match).sort(), ['departureDate', 'inboundLeg', 'outboundLeg', 'returnDate']);
  assert.deepEqual(Object.keys(match.outboundLeg).sort(), [...LEG_FIELDS].sort());
  assert.ok(posted[0].body.length < 100 * 1024, '서버 JSON 한도(100kb) 안');

  const alert = plain(client, 'state.targetAlerts[0]');
  assert.equal(plain(client, 'state.targetAlerts.length'), 1);
  assert.equal(result.alert.id, alert.id);
  assert.equal(alert.isRealFare, true);
  assert.equal(alert.sourceApi, 'TRAVELPAYOUTS_PRICES');
  assert.equal(alert.matchCount, 1);
  assert.equal(alert.bestPriceKrw, 150000);
  assert.equal(alert.matches[0].departureDate, addDays(kstToday(), 10));
  const stored = readStore(client).targetAlerts[0].lastScan.matches[0];
  assert.equal(stored.bookingLinks, undefined, '저장한 일정에는 예약 링크를 두지 않는다 (보여 줄 때 다시 만든다)');
  assert.match(alert.matches[0].bookingLinks.naverUrl, /^https:\/\/flight\.naver\.com\//, '예약 링크는 앱이 만든 것');
  assert.equal(alert.matches[0].bookingLinks.bookingMeta.adults, 1);
  assert.match(stored.outboundLeg.sourceUrl, /^https:\/\/www\.aviasales\.com\/search\//);

  // 목표가 이하가 있으니 등록 즉시 카톡(미리보기) 알림
  const logs = readStore(client).notificationLogs;
  assert.equal(logs.length, 1);
  assert.equal(logs[0].alertKind, 'TARGET_PRICE');
  assert.equal(logs[0].ruleId, alert.id);
  assert.equal(logs[0].matchCount, 1);
  const toast = lastToast(client);
  assert.match(toast.message, /🎯 목표가 알림 등록: .*200,000원 이하 · 목표가 이하 1일 \(최저 150,000원\) · 카톡 알림/);
  assert.equal(client.run('globalThis.__jumped'), 'sectionWatchlist');
  // 카톡 미리보기: 목표가 알림 제목과 목표가 이하 일정 (보낸 메시지와 같은 목록)
  const preview = html(client, 'kakaoPreviewCard');
  const day = addDays(kstToday(), 10);
  const back = addDays(kstToday(), 13);
  assert.match(preview, /SkyBell KR · 🎯 목표가 알림 · 최근 검색가/);
  assert.match(preview, /🎯 목표가 200,000원 이하 1일/);
  assert.match(preview, /data-target-preview-matches/);
  assert.ok(preview.includes(`1) ${day.slice(5, 7)}/${day.slice(8)}→${back.slice(5, 7)}/${back.slice(8)} · 3박`), preview.slice(0, 200));
  assert.match(preview, /목표가 대비 -50,000원 절약!/);

  const cards = html(client, 'watchRulesContainer');
  assert.match(cards, /🎯 목표가 알림 1건/);
  assert.match(cards, /data-target-alert="talert/);
  assert.match(cards, /✅ 목표가 이하 1일/);
  assert.match(cards, /📡 최근 검색가 \(Travelpayouts/);
  assert.match(cards, /목표가보다 −50,000원/);
  assert.doesNotMatch(cards, /날짜 지정 알림/, '날짜 지정 알림이 없으면 그 제목도 없다');
  client.context.toggleTargetMatch(0, 0);
  const opened = html(client, 'watchRulesContainer');
  assert.match(opened, /data-searched-on=/);
  assert.match(opened, /Aviasales ↗/);
  assert.match(opened, /구글 편도 ↗/);

  assert.equal(text(client, 'kpiActiveCount'), '1개');
  assert.equal(text(client, 'kpiDedupeInfo'), '목표가 알림 1개');
  assert.equal(text(client, 'kpiTargetHitCount'), '1개');
  assert.equal(text(client, 'kpiLowestPrice'), '150,000원');
  assert.match(text(client, 'kpiLowestRoute'), /칭다오항공/);
  assert.equal(text(client, 'headerBadgeWatchlist'), '1건 등록');
});

test('목표가 알림 등록: 앱이 프록시 결과를 쓸 수 없다고 하면(422) 모의 가격으로 다시 등록하고, 토큰이 없으면 프록시를 부르지 않고 이유를 알린다', async () => {
  const client = await loadApp({ 'GET target-scan': targetScanRoute({ fareSource: 'SERPAPI_GOOGLE_FLIGHTS' }) });
  enableRealMode(client);
  await createTargetAlertFromForm(client);
  assert.equal(appCalls(client, 'POST', '/api/target-alerts').length, 2, '결과를 빼고 한 번 더 보낸다');
  assert.equal(plain(client, 'state.targetAlerts[0].isRealFare'), false);
  assert.equal(plain(client, 'state.targetAlerts[0].sourceApi'), 'ONEWAY_COMBO_ENGINE');
  assert.match(lastToast(client).message, /실제 운임 조회 실패\(알 수 없는 운임 출처.*\) → 모의 가격으로 목표가 알림을 등록했습니다/);
  assert.equal(lastToast(client).icon, '⚠️');

  const noToken = await loadApp({ 'GET target-scan': targetScanRoute() });
  enableRealMode(noToken, { serpapi: true, travelpayouts: false });
  await createTargetAlertFromForm(noToken);
  assert.equal(proxyCalls(noToken, 'target-scan').length, 0);
  assert.equal(plain(noToken, 'state.targetAlerts[0].isRealFare'), false);
  assert.match(lastToast(noToken).message, /Travelpayouts 토큰이 프록시에 아직 없음/);

  // 목표가가 너무 낮으면 보내지 않는다
  const low = await loadApp();
  assert.equal(await createTargetAlertFromForm(low, 5000), null);
  assert.equal(appCalls(low, 'POST', '/api/target-alerts').length, 0);
  assert.match(lastToast(low).message, /10,000원 이상/);
});

test('자동 확인: 앱을 열 때 오늘 훑지 않은 목표가 알림만 훑고, PIN 을 넣으면 모의 가격으로만 훑은 알림을 최근 검색가로 다시 훑으며, PIN 없는 실제 운임 알림은 덮어쓰지 않는다', async () => {
  const client = await loadApp({ 'GET target-scan': targetScanRoute() });
  await createTargetAlertFromForm(client);
  const id = plain(client, 'state.targetAlerts[0].id');
  assert.equal(plain(client, 'state.targetAlerts[0].checkedToday'), true);
  assert.equal(await client.context.autoScanTargetAlerts(), null, '오늘 이미 훑었으면 다시 훑지 않는다');

  await markCheckedLongAgo(client);
  const daily = await client.context.autoScanTargetAlerts();
  assert.equal(daily.checked, 1);
  assert.equal(proxyCalls(client, 'target-scan').length, 0, '모의 가격 모드는 프록시를 부르지 않는다');
  assert.match(lastToast(client).message, /오늘의 목표가 확인: 알림 1건 · 목표가 이하/);
  assert.equal(plain(client, 'state.targetAlerts[0].checkedToday'), true);

  enableRealMode(client);
  const upgraded = await client.context.autoScanTargetAlerts();
  assert.equal(upgraded.checked, 1, 'PIN 을 넣으면 오늘 모의 가격으로 훑은 알림도 최근 검색가로');
  assert.equal(proxyCalls(client, 'target-scan').length, 1);
  assert.equal(plain(client, 'state.targetAlerts[0].isRealFare'), true);
  assert.equal(await client.context.autoScanTargetAlerts(), null, '최근 검색가로 오늘 훑었으면 그만');

  client.run('realFareState.enabled = false;');
  await markCheckedLongAgo(client);
  assert.equal(await client.context.autoScanTargetAlerts(), null, 'PIN 이 없으면 실제 운임 알림은 자동으로 훑지 않는다');
  assert.equal(client.run('globalThis.__pinModal'), 0, '자동 확인은 PIN 창을 띄우지 않는다');
  assert.match(html(client, 'watchRulesContainer'), /PIN 을 넣어야 다시 훑습니다/);

  const scanned = await client.context.handleScanTargetAlert(id);
  assert.equal(scanned.needsPin, true);
  assert.equal(client.run('globalThis.__pinModal'), 1, "'지금 다시 훑기' 는 PIN 창을 연다");
  assert.equal(readStore(client).targetAlerts[0].lastCheckedAt, '2020-01-01T00:00:00.000Z', '앱 API 를 부르지 않았다');
  assert.equal(appCalls(client, 'POST', `/api/target-alerts/${id}/scan`).length, 2, '자동 확인 두 번만');
});

test('일괄 조회(실제 운임 모드): 목표가 알림은 확인 창 없이 최근 검색가로 다시 훑고, 날짜 지정 알림은 SerpApi 키가 없으면 건너뛰고·있으면 확인 창을 묻는다', async () => {
  const client = await loadApp({ 'GET target-scan': targetScanRoute() });
  enableRealMode(client);
  await createTargetAlertFromForm(client);
  client.run('globalThis.__confirms = 0; window.confirm = () => { globalThis.__confirms += 1; return false; };');

  const onlyTargets = await client.context.handleBatchCheck();
  assert.match(onlyTargets.message, /^목표가 알림 1건 · 목표가 이하 1건$/);
  assert.equal(onlyTargets.icon, '✅');
  assert.equal(onlyTargets.dashboardReloaded, true);
  assert.equal(client.run('globalThis.__confirms'), 0, '목표가 알림만 있으면 확인 창 없음');
  assert.equal(proxyCalls(client, 'target-scan').length, 2);
  assert.equal(serpapiCalls(client).length, 0);

  const dep = addDays(kstToday(), 30);
  await client.context.apiFetch('/api/rules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ origin: 'ICN', destination: 'FUK', departureDate: dep, returnDate: addDays(dep, 3), targetPrice: 300000, directOnly: true, adults: 1, children: 0, infants: 0 })
  });
  await client.context.loadDashboard();

  enableRealMode(client, { serpapi: false, travelpayouts: true });
  const noSerpapi = await client.context.handleBatchCheck();
  assert.match(noSerpapi.message, /^목표가 알림 1건 · 목표가 이하 1건 · 날짜 지정 알림 1건은 구글 플라이트\(SerpApi\) 키가 프록시에 없어 건너뜀$/);
  assert.equal(noSerpapi.icon, '⚠️');

  enableRealMode(client);
  const cancelled = await client.context.handleBatchCheck();
  assert.equal(client.run('globalThis.__confirms'), 1, '날짜 지정 알림은 SerpApi 횟수를 먼저 묻는다');
  assert.match(cancelled.message, /목표가 알림 1건 · 목표가 이하 1건 · 날짜 지정 알림 실시간 조회는 취소/);
  assert.equal(cancelled.dashboardReloaded, true);
  assert.equal(serpapiCalls(client).length, 0);

  // 목표가 알림 목록 아래에 날짜 지정 알림이 제목과 함께 온다
  assert.match(html(client, 'watchRulesContainer'), /🎯 목표가 알림 1건[\s\S]*📅 날짜 지정 알림 \(이전 방식 · 1건\)/);
  assert.equal(text(client, 'headerBadgeWatchlist'), '2건 등록');
});

test('일괄 조회(모의 가격): 목표가 알림도 다시 훑어 그 수를 알리고, 건너뛴 실제 운임 알림 수는 날짜 지정·목표가를 합쳐 알린다', async () => {
  const client = await loadApp();
  await createTargetAlertFromForm(client);
  const result = await client.context.handleBatchCheck();
  assert.equal(result.message, '일괄 조회 완료! (목표가 알림 1건 다시 훑음)');
  assert.equal(result.icon, '✅');

  client.run(`
    globalThis.__batchBody = { checkedGroups: 2, savedApiCalls: 1, notificationsSent: [], skippedRealFareRules: 2, checkedTargetAlerts: 3, skippedRealFareTargetAlerts: 1 };
    apiFetch = async () => ({ ok: true, status: 200, json: async () => globalThis.__batchBody });
    loadDashboard = async () => {};
  `);
  const mixed = await client.context.handleBatchCheck();
  assert.equal(mixed.message, '일괄 조회 완료! (2개 고유 노선 조회 · 중복 호출 1회 절약 · 목표가 알림 3건 다시 훑음 · 실제 운임 알림 3건은 PIN 을 넣어야 조회)');
  client.run('globalThis.__batchBody = { checkedGroups: 0, savedApiCalls: 0, notificationsSent: [], skippedRealFareRules: 0, checkedTargetAlerts: 0, skippedRealFareTargetAlerts: 2 };');
  const skipped = await client.context.handleBatchCheck();
  assert.equal(skipped.message, '다시 조회할 모의 가격 알림이 없습니다 · 실제 운임 알림 2건은 PIN 을 넣어야 조회');

  // 서버가 건너뛴 실패(노선·목표가 알림)는 '완료' 대신 ⚠️ 와 이유로
  client.run(`globalThis.__batchBody = { checkedGroups: 1, failedGroups: 2, savedApiCalls: 0, notificationsSent: [], skippedRealFareRules: 0,
    checkedTargetAlerts: 1, failedTargetAlerts: 1, failureReason: 'Amadeus 응답이 15초 안에 오지 않음', skippedRealFareTargetAlerts: 0 };`);
  const partial = await client.context.handleBatchCheck();
  assert.deepEqual({ message: partial.message, icon: partial.icon }, {
    message: '일괄 조회 완료! (1개 고유 노선 조회 · 중복 호출 0회 절약 · 목표가 알림 1건 다시 훑음 · 노선 2개·목표가 알림 1건 조회 실패(Amadeus 응답이 15초 안에 오지 않음))',
    icon: '⚠️'
  });
  client.run(`globalThis.__batchBody = { checkedGroups: 0, failedGroups: 3, savedApiCalls: 0, notificationsSent: [], skippedRealFareRules: 1,
    checkedTargetAlerts: 0, failedTargetAlerts: 0, failureReason: 'fetch failed', skippedRealFareTargetAlerts: 0 };`);
  const allFailed = await client.context.handleBatchCheck();
  assert.deepEqual({ message: allFailed.message, icon: allFailed.icon }, {
    message: '일괄 조회 실패: 노선 3개 조회 실패(fetch failed) · 실제 운임 알림 1건은 PIN 을 넣어야 조회',
    icon: '⚠️'
  });
});

test('목표가 알림 삭제: 한 건(두 번 눌러도 한 번) · 이미 지운 것 · 전체 삭제는 목표가 알림만 있으면 그것만 지운다', async () => {
  const client = await loadApp();
  await createTargetAlertFromForm(client, 200000);
  await createTargetAlertFromForm(client, 300000);
  const ids = plain(client, 'state.targetAlerts.map((a) => a.id)');
  assert.equal(ids.length, 2);

  await client.context.handleDeleteTargetAlert(ids[0], { detail: 2 });
  assert.equal(plain(client, 'state.targetAlerts.length'), 2, '두 번째 클릭은 무시');
  await client.context.handleDeleteTargetAlert(ids[0], { detail: 1 });
  assert.equal(plain(client, 'state.targetAlerts.length'), 1);
  assert.equal(lastToast(client).message, '목표가 알림이 삭제되었습니다.');
  await client.context.handleDeleteTargetAlert(ids[0], { detail: 1 });
  assert.match(lastToast(client).message, /이미 삭제된 목표가 알림/);

  client.run('globalThis.__questions = []; window.confirm = (q) => { globalThis.__questions.push(q); return true; };');
  await client.context.handleDeleteAllRules();
  assert.deepEqual(plain(client, 'globalThis.__questions'), ['등록된 알림 1건(목표가 알림 1건)을 모두 삭제할까요?']);
  assert.equal(lastToast(client).message, '목표가 알림 1건을 모두 삭제했습니다.');
  assert.equal(plain(client, 'state.targetAlerts.length'), 0);
  assert.equal(appCalls(client, 'DELETE', '/api/rules').length, 0, '날짜 지정 알림이 없으면 부르지 않는다');
  assert.match(html(client, 'watchRulesContainer'), /등록된 항공권 알림이 없습니다/);
});

test('카드의 목표가 알림: 그 노선·카드 가격으로, 카드 일정이 들어가는 가장 짧은 기간(1·2·3·6개월)과 그 박수가 들어가는 박수 범위로 등록한다', async () => {
  const client = await loadApp();
  client.run('globalThis.__bodies = []; submitTargetAlert = async (body) => { globalThis.__bodies.push(body); return { alert: {} }; };');
  setRouteForm(client, { origin: 'ALL_KOREA', destination: 'NRT', adults: 2 });
  const today = kstToday();
  await client.context.createTargetAlertFromDeal('PUS', 'FUK', addDays(today, 40), addDays(today, 43), 123456);
  await client.context.createTargetAlertFromDeal('ICN', 'BKK', addDays(today, 100), addDays(today, 108), 456700);
  await client.context.createTargetAlertFromDeal('GMP', 'HND', addDays(today, 5), addDays(today, 6), 99000);
  const pick = ({ origin, destination, targetPrice, windowDays, minNights, maxNights, adults }) => ({
    origin, destination, targetPrice, windowDays, minNights, maxNights, adults
  });
  assert.deepEqual(plain(client, 'globalThis.__bodies').map(pick), [
    { origin: 'PUS', destination: 'FUK', targetPrice: 123456, windowDays: 60, minNights: 2, maxNights: 5, adults: 2 },
    { origin: 'ICN', destination: 'BKK', targetPrice: 456700, windowDays: 180, minNights: 2, maxNights: 8, adults: 2 },
    { origin: 'GMP', destination: 'HND', targetPrice: 99000, windowDays: 30, minNights: 1, maxNights: 5, adults: 2 }
  ]);

  // TOP 30·귀국일표·추천 일정 카드의 버튼이 이 함수를 부른다
  const appSource = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.equal(count(appSource, /onclick="createTargetAlertFromDeal\(/g), 3);
  assert.equal(count(appSource, /quickAddDealToWatchlist|handleCreateRule/g), 0, '옛 날짜 지정 등록은 없다');
});

test('목표가 알림 카드: 이상한 id 면 버튼을 만들지 않고, 글자는 모두 이스케이프한다', async () => {
  const client = await loadApp();
  client.run(`
    state.watchRules = [];
    state.targetAlerts = [{
      id: "x');alert(1);//", routeSummary: '<img src=x onerror=alert(1)>', passengerSummaryText: '<b>2</b>', windowLabel: '<i>3</i>',
      minNights: 2, maxNights: 5, targetPrice: 100000, targetTotalPassengersPriceKrw: 100000, matches: [], matchCount: 0,
      cheapest: null, isTargetReached: false, sourceApi: 'ONEWAY_COMBO_ENGINE', isRealFare: false, lastScan: null
    }];
  `);
  client.context.renderWatchRules();
  const out = html(client, 'watchRulesContainer');
  assert.doesNotMatch(out, /<img|<b>2<\/b>|<i>3/);
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(out, /handleScanTargetAlert\(|handleDeleteTargetAlert\(/, 'id 가 앱 모양이 아니면 버튼 없음');
  assert.match(out, /아직 훑지 않음/);
});

test('메뉴 조회: 노선·인원 설정의 조회는 ±3일 목록이 떠 있을 때만 같은 조건으로 다시 찾고, 실패하면 ⚠️ 로 알린다', async () => {
  const client = await loadApp();
  client.run(`
    globalThis.__flexQueries = [];
    const noop = async () => {};
    loadAnywhereTop10 = noop;
    loadReturnDateMatrix = noop;
    loadScheduleRecommendations = noop;
    renderBenchmark2YPanel = noop;
    syncPriceChartToForm = noop;
    loadFlexDeals = async (query) => { globalThis.__flexQueries.push(query); state.flexDealsData = { error: '시험 오류', query }; };
  `);
  await client.context.refreshSection('sectionSearchForm');
  assert.equal(client.run('globalThis.__flexQueries.length'), 0, '목록이 없으면 찾지 않는다');
  assert.match(lastToast(client).message, /조회 완료/);

  const query = { origin: 'ICN', destination: 'FUK', departureDate: '2026-11-20', returnDate: '2026-11-23' };
  client.run(`state.flexDealsData = { deals: [], query: ${JSON.stringify(query)} };`);
  await client.context.refreshSection('sectionSearchForm');
  assert.deepEqual(plain(client, 'globalThis.__flexQueries'), [query], '그때 찾은 조건 그대로');
  assert.match(lastToast(client).message, /±3일 최저가: 시험 오류/);
  assert.equal(lastToast(client).icon, '⚠️');
});

test('±3일 최저가 화면: 숨겨 둔 결과 상자를 열고 오류는 요약 칸에 · 결과 한 줄은 상자 밖 알림 칸(role=status)에 · 줄을 펴도 다시 알리지 않고 누른 버튼에 초점을 돌려준다', async () => {
  const indexHtml = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
  // 숨긴 상자 안의 알림 칸은 상자를 여는 순간 채워지면 읽히지 않으므로 상자 밖(앞)에 늘 둔다 — 목록 전체가 다시 읽히지 않게 상자·목록에는 두지 않는다
  const statusAt = indexHtml.indexOf('<p id="flexResultsStatus" class="sr-only" role="status" aria-live="polite"></p>');
  assert.ok(statusAt > 0 && statusAt < indexHtml.indexOf('id="flexResultsBox"'), '알림 칸은 결과 상자 밖(앞)에');
  assert.doesNotMatch(indexHtml, /id="flexResults(Box|Summary|List)"[^>]*aria-live/);

  const client = await loadApp();
  const box = element(client, 'flexResultsBox');
  box.classList.add('hidden'); // index.html 의 처음 상태
  client.run("globalThis.__realLoadFareFeature = loadFareFeature; loadFareFeature = async () => ({ error: '시험 오류 <b>' });");
  const dep = addDays(kstToday(), 30);
  setRouteForm(client, { dep, ret: addDays(dep, 4) });
  await client.context.handleFlexSearch(NO_EVENT);
  assert.equal(box.classList.contains('hidden'), false, '오류여도 상자를 연다');
  assert.match(html(client, 'flexResultsSummary'), /data-flex-error[^>]*>⚠️ 시험 오류 &lt;b&gt;/);
  assert.equal(html(client, 'flexResultsList'), '', '오류면 목록은 비운다');
  assert.equal(text(client, 'flexResultsStatus'), '±3일 최저가를 찾지 못했습니다: 시험 오류 <b>', '알림 칸은 글자로만 (textContent)');
  assert.equal(html(client, 'flexResultsStatus'), '');

  client.run('loadFareFeature = globalThis.__realLoadFareFeature;');
  await client.context.handleFlexSearch(NO_EVENT);
  assert.doesNotMatch(html(client, 'flexResultsSummary'), /data-flex-error/);
  assert.equal(count(html(client, 'flexResultsList'), /data-row-toggle="flex:\d+"/g), 20);
  assert.equal(element(client, 'btnFlexSearch').disabled, false);
  assert.equal(element(client, 'btnFlexSearch').getAttribute('aria-busy'), 'false');
  const status = text(client, 'flexResultsStatus');
  const best = plain(client, 'state.flexDealsData.deals[0]');
  assert.equal(
    status,
    `±3일 최저가 20개를 싼 순서로 찾았습니다. 가장 싼 일정은 ${best.departureDate.slice(5, 7)}/${best.departureDate.slice(8)}~${best.returnDate.slice(5, 7)}/${best.returnDate.slice(8)} ${best.combinedAdultPriceKrw.toLocaleString('ko-KR')}원입니다.`
  );

  element(client, 'flexResultsSummary').innerHTML = 'SUMMARY-SENTINEL';
  element(client, 'flexResultsStatus').textContent = 'STATUS-SENTINEL';
  client.context.toggleFlexDeal(3);
  assert.equal(html(client, 'flexResultsSummary'), 'SUMMARY-SENTINEL', '줄을 펴도 요약 칸은 그대로');
  assert.equal(text(client, 'flexResultsStatus'), 'STATUS-SENTINEL', '줄을 펴도 결과를 다시 알리지 않는다');
  assert.match(html(client, 'flexResultsList'), /data-row-toggle="flex:3" aria-expanded="true"/);
  assert.equal(focusedKey(client), '[data-row-toggle="flex:3"]');
});

test('±3일 최저가: 찾는 중에 메뉴 조회(또는 PIN 전환)가 오면 끝난 옛 조건이 아니라 마지막으로 찾기 시작한 조건으로 다시 찾는다', WAIT_LIMIT, async () => {
  const pending = [];
  const client = await loadApp({ 'GET flex-dates': (url) => new Promise((resolve) => pending.push({ url, resolve })) });
  enableRealMode(client);
  const dep = addDays(kstToday(), 20);
  const later = addDays(dep, 7);
  setRouteForm(client, { destination: 'TAO', dep, ret: addDays(dep, 3) });
  const first = client.context.handleFlexSearch(NO_EVENT);
  await waitFor(() => pending.length === 1);
  pending[0].resolve(emptyFlexReply(dep));
  await first;

  setRouteForm(client, { destination: 'TAO', dep: later, ret: addDays(later, 3) });
  const second = client.context.handleFlexSearch(NO_EVENT);
  await waitFor(() => pending.length === 2);
  assert.equal(element(client, 'btnFlexSearch').disabled, true, '찾는 동안 버튼을 막는다');
  const refreshed = client.context.refreshFlexDealsIfShown();
  await waitFor(() => pending.length === 3);
  assert.equal(pending[2].url.searchParams.get('departureDate'), later);
  pending[1].resolve(emptyFlexReply(later));
  pending[2].resolve(emptyFlexReply(later));
  assert.equal(await second, null, '앞선 요청의 응답은 버린다');
  await refreshed;
  assert.equal(plain(client, 'state.flexDealsData.query.departureDate'), later);
  assert.equal(element(client, 'btnFlexSearch').disabled, false, '마지막 요청이 끝나면 버튼을 되돌린다');
});

test('±3일 목록의 🎯 알림: 찾은 뒤 폼을 바꿔도 목록을 찾은 조건(직항·인원)으로 등록하고, 카드 일정이 훑는 범위 밖이면 그 사실을 붙여 알린다', async () => {
  const client = await loadApp();
  const dep = addDays(kstToday(), 30);
  setRouteForm(client, { dep, ret: addDays(dep, 4), adults: 2 });
  await client.context.handleFlexSearch(NO_EVENT);
  const deal = plain(client, 'state.flexDealsData.deals[2]');

  setRouteForm(client, { origin: 'PUS', destination: 'NRT', adults: 1 });
  element(client, 'inputDirectOnly').checked = false;
  await client.context.createTargetAlertFromFlexDeal(2);
  const alert = plain(client, 'state.targetAlerts[0]');
  assert.deepEqual(
    { origin: alert.origin, destination: alert.destination, directOnly: alert.directOnly, adults: alert.adults, targetPrice: alert.targetPrice },
    { origin: 'ICN', destination: 'FUK', directOnly: true, adults: 2, targetPrice: deal.combinedAdultPriceKrw }
  );
  assert.equal(lastToast(client).icon, '🔔', '훑는 범위 안이면 덧붙이는 안내가 없다');

  const today = kstToday();
  await client.context.createTargetAlertFromDeal('ICN', 'FUK', addDays(today, 200), addDays(today, 204), 300000);
  assert.match(lastToast(client).message, / · 이 일정은 200일 뒤 출발이라 훑는 기간\(내일부터 180일\) 밖 — 그 안의 출발일만 찾습니다$/);
  assert.equal(lastToast(client).icon, '⚠️');
  await client.context.createTargetAlertFromDeal('ICN', 'FUK', today, addDays(today, 3), 300000);
  assert.match(lastToast(client).message, / · 오늘 출발 일정은 훑지 않습니다 \(알림은 내일 출발부터\)$/);
  await client.context.createTargetAlertFromDeal('ICN', 'FUK', addDays(today, 20), addDays(today, 60), 300000);
  assert.match(lastToast(client).message, / · 이 일정은 40박이라 최대 30박까지만 찾습니다$/);
  assert.equal(plain(client, 'state.targetAlerts.length'), 4);
});

test('목표가 알림 등록: 끝나기 전에 또 누르면(폼 두 번·카드) 보내지 않고, 등록하는 동안 버튼을 막았다가 끝나거나 실패하면 되돌린다', WAIT_LIMIT, async () => {
  const pending = [];
  const client = await loadApp({ 'GET target-scan': () => new Promise((resolve) => pending.push(resolve)) });
  enableRealMode(client);
  const btn = element(client, 'btnCreateTargetAlert');
  const first = createTargetAlertFromForm(client);
  await waitFor(() => pending.length === 1);
  assert.equal(btn.disabled, true);
  assert.equal(btn.getAttribute('aria-busy'), 'true');
  assert.equal(btn.textContent, '⏳ 등록 중…');

  assert.equal(await createTargetAlertFromForm(client), null);
  const today = kstToday();
  assert.equal(await client.context.createTargetAlertFromDeal('ICN', 'TAO', addDays(today, 10), addDays(today, 13), 150000), null);
  assert.deepEqual(lastToast(client), { message: '목표가 알림을 등록하는 중입니다 — 끝난 뒤에 다시 눌러 주세요.', icon: '⏳' });

  pending[0](await targetScanRoute()());
  assert.ok((await first).alert);
  assert.equal(pending.length, 1, '프록시 목표가 스캔도 한 번');
  assert.equal(appCalls(client, 'POST', '/api/target-alerts').length, 1);
  assert.equal(plain(client, 'state.targetAlerts.length'), 1);
  assert.equal(readStore(client).notificationLogs.length, 1, '카톡도 한 번');
  assert.equal(btn.disabled, false);
  assert.equal(btn.getAttribute('aria-busy'), 'false');
  assert.equal(btn.textContent, '🔔 목표가 알림 등록');

  // 등록이 실패해도 버튼과 잠금을 풀어 다시 누를 수 있다
  client.run("realFareState.enabled = false; globalThis.__realPost = postJsonToApp; postJsonToApp = async () => { throw new Error('저장 실패 시험'); };");
  assert.equal(await createTargetAlertFromForm(client, 300000), null);
  assert.deepEqual(lastToast(client), { message: '저장 실패 시험', icon: '⚠️' });
  assert.equal(btn.disabled, false);
  client.run('postJsonToApp = globalThis.__realPost;');
  assert.ok((await createTargetAlertFromForm(client, 300000)).alert, '잠금이 풀려 다시 등록된다');
  assert.equal(plain(client, 'state.targetAlerts.length'), 2);
});

test('지금 다시 훑기: 실제 운임 알림은 프록시가 실패하면 앱에 보내지 않고, 앱이 결과를 거절(422)하면 저장하지 않으며, 409 면 PIN 을 묻고 카드 버튼을 되돌린다 (지난 결과는 그대로)', async () => {
  let scanReply = targetScanRoute();
  const client = await loadApp({ 'GET target-scan': (...args) => scanReply(...args) });
  enableRealMode(client);
  await createTargetAlertFromForm(client);
  const id = plain(client, 'state.targetAlerts[0].id');
  const before = readStore(client).targetAlerts[0];
  const scanPosts = () => appCalls(client, 'POST', `/api/target-alerts/${id}/scan`).length;

  scanReply = async () => jsonResponse(429, { error: 'Travelpayouts 한도 초과', code: 'TP_RATE_LIMIT' });
  assert.equal(await client.context.handleScanTargetAlert(id), null);
  assert.match(lastToast(client).message, /^실제 운임 조회 실패\(무료 조회 한도 초과.*\) — 지난 결과를 그대로 둡니다\.$/);
  assert.equal(scanPosts(), 0, '앱에 보내지 않는다 (모의 가격으로 덮어쓰지 않게)');
  assert.deepEqual(readStore(client).targetAlerts[0], before);
  assert.match(html(client, 'watchRulesContainer'), /🔍 지금 다시 훑기/);

  scanReply = targetScanRoute({ fareSource: 'SERPAPI_GOOGLE_FLIGHTS' });
  assert.equal(await client.context.handleScanTargetAlert(id), null);
  assert.match(lastToast(client).message, /^실제 운임 결과를 쓸 수 없음\(.+\) — 지난 결과를 그대로 둡니다\.$/);
  assert.equal(scanPosts(), 1);
  assert.deepEqual(readStore(client).targetAlerts[0], before);

  // 다른 창에서 실제 운임 알림이 된 것을 모르는 화면(모의 가격으로 앎)이 PIN 없이 훑으면 앱이 409 로 막는다
  client.run('realFareState.enabled = false; state.targetAlerts[0].isRealFare = false;');
  const pinModals = client.run('globalThis.__pinModal');
  const conflict = await client.context.handleScanTargetAlert(id);
  assert.equal(conflict.needsPin, true);
  assert.equal(client.run('globalThis.__pinModal'), pinModals + 1, 'PIN 창을 연다');
  assert.equal(scanPosts(), 2);
  assert.doesNotMatch(html(client, 'watchRulesContainer'), /훑는 중…/, "'훑는 중…' 에 멈추지 않는다");
  assert.match(html(client, 'watchRulesContainer'), /🔍 지금 다시 훑기/);
  assert.deepEqual(readStore(client).targetAlerts[0], before);
});

test('자동 확인은 겹쳐 돌지 않고, 훑는 중인 알림을 또 누르면 기다리라고 알린다 (프록시도 한 번)', WAIT_LIMIT, async () => {
  const pending = [];
  let hold = false;
  const client = await loadApp({
    'GET target-scan': () => (hold ? new Promise((resolve) => pending.push(resolve)) : targetScanRoute()())
  });
  enableRealMode(client);
  await createTargetAlertFromForm(client);
  const id = plain(client, 'state.targetAlerts[0].id');
  await markCheckedLongAgo(client);

  hold = true;
  const first = client.context.autoScanTargetAlerts();
  await waitFor(() => pending.length === 1);
  assert.equal(await client.context.autoScanTargetAlerts(), null, '도는 중이면 또 돌지 않는다');
  assert.equal(await client.context.handleScanTargetAlert(id), null);
  assert.deepEqual(lastToast(client), { message: '이 목표가 알림은 지금 훑는 중입니다 — 끝나면 결과가 바로 보입니다.', icon: '⏳' });
  assert.equal(pending.length, 1);

  pending[0](await targetScanRoute()());
  assert.equal((await first).checked, 1);
  assert.equal(appCalls(client, 'POST', `/api/target-alerts/${id}/scan`).length, 1);
  hold = false;
  assert.equal(await client.context.autoScanTargetAlerts(), null, '오늘 훑었으면 그만');
});

test('목표가 알림 카드: 모두 보기·일정 줄을 펴고 접으면 aria-expanded 를 바꾸고 누른 버튼에 초점을 돌려준다', async () => {
  const client = await loadApp();
  await createTargetAlertFromForm(client, 2000000);
  const shown = plain(client, 'state.targetAlerts[0].matches.length');
  assert.ok(shown > 5, `목표가 이하 ${shown}일`);
  let cards = html(client, 'watchRulesContainer');
  assert.equal(count(cards, /data-row-toggle="target:0:\d+"/g), 5, '처음에는 5일만');
  assert.match(cards, new RegExp(`data-row-toggle="target-all:0" aria-expanded="false"[^>]*>모두 보기 \\(${shown}일\\)`));

  client.context.toggleTargetAlertAllMatches(0);
  cards = html(client, 'watchRulesContainer');
  assert.equal(count(cards, /data-row-toggle="target:0:\d+"/g), shown);
  assert.match(cards, /data-row-toggle="target-all:0" aria-expanded="true"[^>]*>접기 ▲/);
  assert.equal(focusedKey(client), '[data-row-toggle="target-all:0"]');

  client.context.toggleTargetMatch(0, 7);
  assert.match(html(client, 'watchRulesContainer'), /data-row-toggle="target:0:7" aria-expanded="true"/);
  assert.equal(focusedKey(client), '[data-row-toggle="target:0:7"]');
  client.context.toggleTargetMatch(0, 7);
  assert.match(html(client, 'watchRulesContainer'), /data-row-toggle="target:0:7" aria-expanded="false"/);
});
