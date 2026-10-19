/**
 * 화면의 실제 운임 모드 (public/realFares.js) — 브라우저 없이 app.js 와 함께 VM 에 올려 확인한다
 * - 프록시 응답 정리(외부 글자를 믿지 않음) · PIN 은 머리글로만 · 실패하면 그 기능만 모의 가격
 * - 최근 검색가 카드에서 바로 등록하면 그 카드 값을 쓰고(SerpApi 횟수 안 씀), 아니면 구글 플라이트 실시간
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PROXY_URL = 'http://proxy.test';

function fakeElement() {
  return {
    textContent: '',
    innerHTML: '',
    value: '',
    className: '',
    dataset: {},
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {},
    querySelector: () => null,
    closest: () => null,
    focus() {},
    select() {}
  };
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    dump: () => Object.fromEntries(map)
  };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// routes: { 'GET anywhere-top10': (url, options) => response | Error }
function loadClient({ routes = {} } = {}) {
  const calls = [];
  const elements = new Map();
  const context = {
    window: { SKYBELL_PROXY_URL: PROXY_URL, addEventListener() {} },
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, fakeElement());
        return elements.get(id);
      },
      activeElement: null
    },
    sessionStorage: memoryStorage(),
    localStorage: memoryStorage(),
    console: { log() {}, error() {}, warn() {} },
    // 토스트(4.3초)·요청 시간 제한 타이머가 테스트 프로세스를 붙잡지 않게 한다
    setTimeout: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref();
      return timer;
    },
    clearTimeout,
    AbortController,
    URL,
    URLSearchParams,
    async fetch(url, options = {}) {
      calls.push({ url: String(url), options });
      const u = new URL(String(url));
      const key = `${options.method || 'GET'} ${u.pathname.replace(/^\/api\//, '')}`;
      const handler = routes[key];
      if (!handler) return jsonResponse(404, { error: '없는 경로', code: 'NOT_FOUND' });
      const result = await handler(u, options);
      if (result instanceof Error) throw result;
      return result;
    }
  };
  vm.createContext(context);
  for (const file of ['app.js', 'realFares.js', 'menuRefresh.js']) {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8'), context, { filename: file });
  }
  const run = (code) => vm.runInContext(code, context);
  return { context, calls, run };
}

function enableRealMode(client, providers = { serpapi: true, travelpayouts: true }) {
  client.run(`realFareState.enabled = true; realFareState.pin = '2468'; realFareState.providers = ${JSON.stringify(providers)};`);
  client.context.sessionStorage.setItem('SKYBELL_REAL_FARE_PIN', '2468');
}

const simulatedResponse = (body) => async () => jsonResponse(200, body);

test('프록시 응답 정리: 태그·따옴표·& 를 지우고, 숫자 칸은 숫자만, 링크는 https 만, __proto__ 는 버린다', () => {
  const { context } = loadClient();
  const raw = JSON.parse(
    JSON.stringify({
      airline: '<img src=x onerror=alert(1)>대한"항공\'&`\\',
      combinedAdultPriceKrw: '1);alert(1);//',
      oneWayPriceKrw: '123000',
      stayNights: 3,
      rank: Infinity,
      sourceUrl: 'https://www.aviasales.com/search/ICN2011NRT1?t=A&marker=1',
      naverOneWayUrl: 'javascript:alert(1)',
      officialBookingUrl: 'https://example.com/"><script>',
      nested: { tiers: [{ label: 'TOP 10', items: [{ destinationCity: '도쿄<b>' }] }] },
      partial: true,
      fetchedAt: null
    })
  );
  raw.__proto__polluter = JSON.parse('{"__proto__": {"polluted": true}, "safe": 1}');

  const out = context.sanitizeProxyValue(raw);
  assert.equal(out.airline, 'img src=x onerror=alert(1)대한항공');
  assert.equal(out.combinedAdultPriceKrw, null, '숫자가 아닌 가격은 버린다 (onclick 인자로 들어가므로)');
  assert.equal(out.oneWayPriceKrw, 123000);
  assert.equal(out.stayNights, 3);
  assert.equal(out.rank, null);
  assert.equal(out.sourceUrl, 'https://www.aviasales.com/search/ICN2011NRT1?t=A&marker=1', 'https 주소의 & 는 남긴다');
  assert.equal(out.naverOneWayUrl, '');
  assert.equal(out.officialBookingUrl, '');
  assert.equal(out.nested.tiers[0].items[0].destinationCity, '도쿄b');
  assert.equal(out.partial, true);
  assert.equal(out.fetchedAt, null);
  assert.equal(out.__proto__polluter.safe, 1);
  assert.equal(out.__proto__polluter.polluted, undefined, '__proto__ 키로 원형을 바꾸지 못한다');
  assert.equal({}.polluted, undefined);
});

test('프록시 호출: PIN 은 X-Access-Pin 머리글로만 보내고 주소에는 넣지 않으며, 오류 코드를 그대로 전한다', async () => {
  const client = loadClient({
    routes: {
      'POST session': async (_u, options) =>
        options.headers['X-Access-Pin'] === '2468'
          ? jsonResponse(200, { ok: true, providers: { serpapi: true, travelpayouts: false } })
          : jsonResponse(401, { error: 'PIN 이 맞지 않습니다.', code: 'PIN_INVALID' }),
      'GET status': async () => new TypeError('Failed to fetch')
    }
  });
  const ok = await client.context.proxyFetch('session', { method: 'POST', pin: '2468' });
  assert.deepEqual(JSON.parse(JSON.stringify(ok)), { ok: true, providers: { serpapi: true, travelpayouts: false } });
  assert.equal(client.calls[0].url, `${PROXY_URL}/api/session`);
  assert.ok(!client.calls[0].url.includes('2468'));
  assert.equal(client.calls[0].options.credentials, 'omit');

  await assert.rejects(client.context.proxyFetch('session', { method: 'POST', pin: '1111' }), (err) => err.code === 'PIN_INVALID' && err.status === 401);
  await assert.rejects(client.context.proxyFetch('status', { pin: '2468' }), (err) => err.code === 'NETWORK');
});

test('조회량 많은 기능: 실제 운임 모드면 프록시 값, 실패하거나 토큰이 없으면 그 기능만 모의 가격 + 이유', async () => {
  const realTop = { realFare: true, fareSource: 'TRAVELPAYOUTS_PRICES', tiers: {}, origin: 'ICN' };
  let failTp = false;
  const client = loadClient({
    routes: {
      'GET anywhere-top10': async () =>
        failTp ? jsonResponse(502, { error: 'Travelpayouts 오류 (HTTP 500)', code: 'TP_ERROR' }) : jsonResponse(200, realTop)
    }
  });
  const params = new URLSearchParams({ origin: 'ICN', region: 'ALL' });
  const simulated = simulatedResponse({ tiers: {}, origin: 'ICN', simulated: true });

  // 모드 꺼짐 → 프록시를 부르지 않는다
  const off = await client.context.loadFareFeature('anywhere-top10', params, simulated);
  assert.equal(off.simulated, true);
  assert.equal(off.realFareFallback, undefined);
  assert.equal(client.calls.length, 0);

  enableRealMode(client);
  const real = await client.context.loadFareFeature('anywhere-top10', params, simulated);
  assert.equal(real.realFare, true);
  assert.match(client.calls[0].url, /\/api\/anywhere-top10\?origin=ICN&region=ALL$/);
  assert.equal(client.calls[0].options.headers['X-Access-Pin'], '2468');

  failTp = true;
  const failed = await client.context.loadFareFeature('anywhere-top10', params, simulated);
  assert.equal(failed.simulated, true);
  assert.match(failed.realFareFallback, /Travelpayouts 오류/);

  enableRealMode(client, { serpapi: true, travelpayouts: false });
  const noToken = await client.context.loadFareFeature('anywhere-top10', params, simulated);
  assert.equal(noToken.simulated, true);
  assert.match(noToken.realFareFallback, /토큰/);
});

test('PIN 이 바뀌어 401 이 오면 실제 운임 모드를 끄고 저장한 PIN 도 지운다', async () => {
  const client = loadClient({
    routes: { 'GET route-price-trend': async () => jsonResponse(401, { error: 'PIN 이 맞지 않습니다.', code: 'PIN_INVALID' }) }
  });
  enableRealMode(client);
  const data = await client.context.loadFareFeature('route-price-trend', new URLSearchParams(), simulatedResponse({ points: [] }));
  assert.match(data.realFareFallback, /PIN/);
  assert.equal(client.run('realFareState.enabled'), false);
  assert.equal(client.run('realFareState.pin'), '');
  assert.equal(client.context.sessionStorage.getItem('SKYBELL_REAL_FARE_PIN'), null);
});

test('알림 등록 후보: 최근 검색가 카드면 그 편도 두 장(SerpApi 안 씀), 아니면 구글 플라이트 실시간, 키가 없으면 이유', async () => {
  const flights = {
    realFare: true,
    fareSource: 'SERPAPI_GOOGLE_FLIGHTS',
    fetchedAt: '2026-10-19T03:04:05.000Z',
    outbound: { candidates: [{ oneWayPriceKrw: 88000, date: '2026-11-20', fromAirportCode: 'ICN', toAirportCode: 'NRT', airline: '제주항공' }] },
    inbound: { candidates: [{ oneWayPriceKrw: 91000, date: '2026-11-24', fromAirportCode: 'NRT', toAirportCode: 'ICN', airline: '대한항공' }] }
  };
  const client = loadClient({ routes: { 'GET flights': async () => jsonResponse(200, flights) } });
  const out = { date: '2026-11-20', fromAirportCode: 'PUS', toAirportCode: 'FUK', oneWayPriceKrw: 51000, fareSource: 'TRAVELPAYOUTS_PRICES' };
  const back = { date: '2026-11-23', fromAirportCode: 'FUK', toAirportCode: 'PUS', oneWayPriceKrw: 49000, fareSource: 'TRAVELPAYOUTS_PRICES' };
  client.run(`state.anywhereTop10Data = ${JSON.stringify({
    realFare: true,
    fetchedAt: '2026-10-19T01:00:00.000Z',
    tiers: { top10: { items: [{ origin: 'PUS', destination: 'FUK', departureDate: '2026-11-20', returnDate: '2026-11-23', outboundLeg: out, inboundLeg: back }] }, top20: { items: [] }, top30: { items: [] } }
  })};`);

  // 모드 꺼짐 → 후보 없음 (모의 가격)
  const off = await client.context.prepareRuleExternalCandidates({ origin: 'PUS', destination: 'FUK', departureDate: '2026-11-20', returnDate: '2026-11-23', directOnly: true });
  assert.equal(off.externalCandidates, null);
  assert.equal(off.fallbackReason, null);

  enableRealMode(client);
  const cached = await client.context.prepareRuleExternalCandidates(
    { origin: 'PUS', destination: 'FUK', departureDate: '2026-11-20', returnDate: '2026-11-23', directOnly: true },
    { preferCachedDeal: true }
  );
  assert.equal(cached.externalCandidates.sourceApi, 'TRAVELPAYOUTS_PRICES');
  assert.equal(cached.externalCandidates.outbound[0].oneWayPriceKrw, 51000);
  assert.equal(cached.externalCandidates.inbound[0].date, '2026-11-23');
  assert.equal(client.calls.length, 0, '카드 값으로 등록하면 구글 플라이트를 부르지 않는다');

  const live = await client.context.prepareRuleExternalCandidates(
    { origin: 'ICN', destination: 'NRT', departureDate: '2026-11-20', returnDate: '2026-11-24', directOnly: false },
    { preferCachedDeal: true }
  );
  assert.equal(live.externalCandidates.sourceApi, 'SERPAPI_GOOGLE_FLIGHTS');
  assert.equal(live.externalCandidates.fetchedAt, '2026-10-19T03:04:05.000Z');
  assert.equal(live.externalCandidates.outbound[0].oneWayPriceKrw, 88000);
  assert.match(client.calls[0].url, /\/api\/flights\?origin=ICN&destination=NRT&departureDate=2026-11-20&returnDate=2026-11-24&directOnly=false$/);

  enableRealMode(client, { serpapi: false, travelpayouts: true });
  const noKey = await client.context.prepareRuleExternalCandidates({ origin: 'ICN', destination: 'NRT', departureDate: '2026-11-20', returnDate: '2026-11-24', directOnly: true });
  assert.equal(noKey.externalCandidates, null);
  assert.match(noKey.fallbackReason, /SerpApi/);
});

test('프록시 호출 시간 제한: timeoutMs 가 지나면 끊고 NETWORK 오류 (시작 시 PIN 확인이 화면을 오래 막지 않게)', async () => {
  const client = loadClient({
    routes: {
      'POST session': (_u, options) =>
        new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))))
    }
  });
  const started = Date.now();
  await assert.rejects(
    client.context.proxyFetch('session', { method: 'POST', pin: '2468', timeoutMs: 30 }),
    (err) => err.code === 'NETWORK'
  );
  assert.ok(Date.now() - started < 5000);
  assert.ok(client.run('REAL_FARE_SESSION_TIMEOUT_MS') <= 10000, 'PIN 확인은 10초 안에 끝낸다');
});

test('구글 플라이트 결과가 없으면: 등록은 모의 가격으로 넘기며 이유를 주고, 재조회는 기존 가격을 그대로 둔다', async () => {
  const emptyOutbound = {
    realFare: true,
    fareSource: 'SERPAPI_GOOGLE_FLIGHTS',
    fetchedAt: '2026-10-19T03:04:05.000Z',
    outbound: { candidates: [] },
    inbound: { candidates: [{ oneWayPriceKrw: 91000, date: '2026-11-24', fromAirportCode: 'NRT', toAirportCode: 'ICN' }] }
  };
  const client = loadClient({ routes: { 'GET flights': async () => jsonResponse(200, emptyOutbound) } });
  enableRealMode(client);
  const route = { origin: 'ICN', destination: 'NRT', departureDate: '2026-11-20', returnDate: '2026-11-24', directOnly: true };

  const prepared = await client.context.prepareRuleExternalCandidates(route);
  assert.equal(prepared.externalCandidates, null, '빈 목록을 서버에 보내 등록이 실패하지 않게');
  assert.match(prepared.fallbackReason, /검색 결과가 없음/);
  await assert.rejects(client.context.fetchRecheckCandidates({ ...route, id: 'rule_1' }), /검색 결과가 없음.*기존 가격/);
});

test('PIN 없이 실제 운임 규칙을 재조회하면 서버를 부르지 않고(모의 가격으로 덮어쓰지 않음) PIN 창을 연다', async () => {
  const client = loadClient();
  client.run(`
    state.watchRules = [{ id: 'rule_live', sourceApi: 'SERPAPI_GOOGLE_FLIGHTS', origin: 'ICN', destination: 'NRT', departureDate: '2026-11-20', returnDate: '2026-11-24', isActive: true }];
    globalThis.__pinModalOpened = 0;
    openRealFarePinModal = () => { globalThis.__pinModalOpened += 1; };
  `);
  await client.context.handleCheckRule('rule_live');
  assert.equal(client.run('globalThis.__pinModalOpened'), 1);
  assert.equal(client.calls.length, 0, '재조회 요청을 보내지 않는다');
});

test('실제 운임 모드면 2년 기준이 없는 제목을 바꾼다 (시세표·가격 추이), 끄면 원래 제목', () => {
  const client = loadClient();
  const text = (id) => client.context.document.getElementById(id).textContent;
  enableRealMode(client);
  client.run('syncRealFareControls()');
  assert.match(text('benchmarkSectionTitle'), /12개월 실제 검색가/);
  assert.match(text('priceChartSectionTitle'), /실제 검색가/);
  assert.doesNotMatch(text('priceChartSectionTitle'), /2년/);
  client.run('realFareState.enabled = false; syncRealFareControls();');
  assert.match(text('priceChartSectionTitle'), /2년 기준선/);
});

test('모의 일괄 조회: 다시 조회한 모의 알림이 없으면 "0개 노선·절약" 대신 건너뛴 실제 운임 알림 수만 알린다', async () => {
  const client = loadClient();
  client.run(`
    globalThis.__toasts = [];
    showToast = (message) => { globalThis.__toasts.push(message); };
    loadDashboard = async () => {};
    globalThis.__batchBody = { checkedGroups: 0, savedApiCalls: 1, notificationsSent: [], skippedRealFareRules: 2 };
    apiFetch = async () => ({ ok: true, status: 200, json: async () => globalThis.__batchBody });
  `);
  await client.context.handleBatchCheck();
  const skippedOnly = client.run('globalThis.__toasts[globalThis.__toasts.length - 1]');
  assert.match(skippedOnly, /실제 운임 알림 2건은 PIN 을 넣어야 조회/);
  assert.doesNotMatch(skippedOnly, /0개 고유 노선|절약/);

  client.run('globalThis.__batchBody = { checkedGroups: 0, savedApiCalls: 0, notificationsSent: [], skippedRealFareRules: 0 };');
  await client.context.handleBatchCheck();
  assert.equal(client.run('globalThis.__toasts[globalThis.__toasts.length - 1]'), '조회할 활성 알림이 없습니다.');

  client.run('globalThis.__batchBody = { checkedGroups: 3, savedApiCalls: 1, notificationsSent: [], skippedRealFareRules: 2 };');
  await client.context.handleBatchCheck();
  assert.match(client.run('globalThis.__toasts[globalThis.__toasts.length - 1]'), /3개 고유 노선 조회 · 중복 호출 1회 절약 · 실제 운임 알림 2건은 PIN 을 넣어야 조회/);
});

test('가격 출처 표시: 모의 / 최근 검색가 / 실시간(조회 시각) 칩과 안내가 서로 다르다', () => {
  const { context } = loadClient();
  assert.match(context.fareChipHtml(undefined), /data-simulated-fare-chip/);
  assert.match(context.fareChipHtml('TRAVELPAYOUTS_PRICES'), /data-cached-fare-chip[^>]*>최근 검색가/);
  assert.match(context.fareChipHtml('SERPAPI_GOOGLE_FLIGHTS', '2026-10-19T03:04:05.000Z'), /data-live-fare-chip[^>]*>실시간 /);
  assert.match(context.bookingNoteHtml('TRAVELPAYOUTS_PRICES'), /실시간 아님/);
  assert.match(context.bookingNoteHtml('SERPAPI_GOOGLE_FLIGHTS', '2026-10-19T03:04:05.000Z'), /실시간 조회가 \(/);
  assert.match(context.bookingNoteHtml('SIMULATED'), /모의 값/);
  assert.equal(context.fareSourceLinkHtml({ sourceUrl: 'javascript:alert(1)' }), '');
  assert.match(context.fareSourceLinkHtml({ sourceUrl: 'https://www.aviasales.com/search/A?t=1&m=2' }), /href="https:\/\/www\.aviasales\.com\/search\/A\?t=1&amp;m=2"/);
});

/**
 * 메뉴별 조회 — 메뉴 머리글의 '🔍 조회' 는 그 메뉴 값만 다시 불러오고, 머리글 '전체 조회' 는 모든 메뉴 + 알림 일괄 조회
 */
const SECTION_IDS = ['sectionKpi', 'sectionSearchForm', 'sectionBenchmark2Y', 'sectionExplorer', 'sectionWatchlist', 'sectionPriceChart', 'sectionKakaoPreview'];

// 메뉴 로더를 호출 기록만 남기는 가짜로 바꾼다 (접고 펴는 화면 처리·토스트도 기록만)
function stubMenuLoaders(client) {
  client.run(`
    globalThis.__calls = [];
    globalThis.__toasts = [];
    const track = (name) => async () => { globalThis.__calls.push(name); };
    loadDashboard = track('loadDashboard');
    loadAnywhereTop10 = track('loadAnywhereTop10');
    loadReturnDateMatrix = track('loadReturnDateMatrix');
    loadScheduleRecommendations = track('loadScheduleRecommendations');
    loadRoutePriceTrend = track('loadRoutePriceTrend');
    handleBatchCheck = async () => { globalThis.__calls.push('handleBatchCheck'); return { message: '일괄 조회 완료! (1개 고유 노선 조회)', icon: '✅' }; };
    renderBenchmark2YPanel = () => { globalThis.__calls.push('renderBenchmark2YPanel'); };
    updatePassengerTotalPreview = () => {};
    renderWatchRules = () => {};
    applySectionCollapseDom = () => {};
    showToast = (message, icon) => { globalThis.__toasts.push({ message, icon }); };
  `);
}

const sortedCalls = (client) => [...client.run('globalThis.__calls')].sort();
const lastToast = (client) => client.run('globalThis.__toasts[globalThis.__toasts.length - 1]');

test('메뉴별 조회: 각 메뉴의 조회는 그 메뉴 로더만 부르고, 접혀 있으면 펼친다 (노선·인원 설정은 결과가 다른 메뉴에 나오므로 그대로)', async () => {
  const client = loadClient();
  stubMenuLoaders(client);
  const expected = {
    sectionKpi: ['loadDashboard'],
    sectionSearchForm: ['loadAnywhereTop10', 'loadReturnDateMatrix', 'loadRoutePriceTrend', 'loadScheduleRecommendations', 'renderBenchmark2YPanel'],
    sectionBenchmark2Y: ['renderBenchmark2YPanel'],
    sectionExplorer: ['loadAnywhereTop10', 'loadReturnDateMatrix', 'loadScheduleRecommendations'],
    sectionWatchlist: ['handleBatchCheck'],
    sectionPriceChart: ['loadRoutePriceTrend'],
    sectionKakaoPreview: ['loadDashboard']
  };
  assert.deepEqual(Object.keys(expected), SECTION_IDS);
  for (const [sectionId, calls] of Object.entries(expected)) {
    client.run('globalThis.__calls = []; globalThis.__toasts = [];');
    await client.context.refreshSection(sectionId);
    assert.deepEqual(sortedCalls(client), [...calls].sort(), sectionId);
    const collapsed = client.run(`state.collapsedSections.${sectionId}`);
    assert.equal(collapsed, sectionId === 'sectionSearchForm', `${sectionId} 펼침 상태`);
    if (sectionId !== 'sectionWatchlist') {
      assert.match(lastToast(client).message, /조회 완료/, `${sectionId} 완료 안내`);
    }
  }
});

test('메뉴별 조회: 노선·인원 설정의 조회는 가격 추이 차트를 폼 노선으로 되돌리고 TOP 30 출발 공항도 폼에 맞춘다', async () => {
  const client = loadClient();
  stubMenuLoaders(client);
  client.run(`
    document.getElementById('inputOrigin').value = 'PUS';
    document.getElementById('anywhereOriginSelect').value = 'ALL_KOREA';
    state.chartRouteMode = 'rule_1';
    state.selectedRuleId = 'rule_1';
  `);
  await client.context.refreshSection('sectionSearchForm');
  assert.equal(client.run(`document.getElementById('anywhereOriginSelect').value`), 'PUS');
  assert.equal(client.run('state.chartRouteMode'), 'FORM');
  assert.equal(client.run('state.selectedRuleId'), null);
});

test('메뉴별 조회: 조회 중에 같은 버튼을 또 누르면 한 번만 돌고, 버튼은 조회 중 표시 후 되돌아온다', async () => {
  const client = loadClient();
  stubMenuLoaders(client);
  // 첫 호출만 붙잡아 두고 그다음 호출은 바로 끝낸다 (막는 장치가 없으면 멈추지 않고 실패하게)
  client.run(`
    globalThis.__release = null;
    loadRoutePriceTrend = () => {
      globalThis.__calls.push('loadRoutePriceTrend');
      if (globalThis.__calls.length > 1) return Promise.resolve();
      return new Promise((resolve) => { globalThis.__release = resolve; });
    };
  `);
  const first = client.context.refreshSection('sectionPriceChart');
  const btn = client.context.document.getElementById('btnRefresh_sectionPriceChart');
  assert.equal(btn.disabled, true);
  assert.match(btn.textContent, /조회 중/);
  await client.context.refreshSection('sectionPriceChart');
  client.run('globalThis.__release()');
  await first;
  assert.deepEqual(sortedCalls(client), ['loadRoutePriceTrend']);
  assert.equal(btn.disabled, false);
  assert.match(btn.textContent, /조회/);
  assert.doesNotMatch(btn.textContent, /조회 중/);
});

test('메뉴별 조회: 로더가 실패하면 그 메뉴 이름과 이유를 알리고, 탐색기는 한 탭이 실패해도 나머지 탭을 불러온다', async () => {
  const client = loadClient();
  stubMenuLoaders(client);
  client.run(`loadReturnDateMatrix = async () => { globalThis.__calls.push('loadReturnDateMatrix'); throw new Error('엔진 응답 없음'); };`);
  await client.context.refreshSection('sectionExplorer');
  assert.deepEqual(sortedCalls(client), ['loadAnywhereTop10', 'loadReturnDateMatrix', 'loadScheduleRecommendations']);
  const toast = lastToast(client);
  assert.match(toast.message, /조회 실패.*엔진 응답 없음/);
  assert.equal(toast.icon, '⚠️');
  assert.equal(client.context.document.getElementById('btnRefresh_sectionExplorer').disabled, false);
});

test('메뉴별 조회: 실제 운임 모드의 시세표 조회는 같은 노선이라도 저장해 둔 결과를 버리고 다시 받아 온다', async () => {
  let hits = 0;
  const client = loadClient({
    routes: {
      'GET route-stats': async () => {
        hits += 1;
        return jsonResponse(200, { summary: {}, stats: [], fetchedAt: '2026-10-19T09:00:00.000Z' });
      }
    }
  });
  enableRealMode(client);
  client.run('applySectionCollapseDom = () => {}; showToast = () => {}; drawRealBenchmark = () => {};');
  await client.context.refreshSection('sectionBenchmark2Y');
  assert.equal(hits, 1, '접혀 있던 시세표를 펼치고 받아 온다');
  client.run('renderBenchmark2YPanel()');
  assert.equal(hits, 1, '노선이 그대로면 평소에는 저장해 둔 결과를 쓴다');
  await client.context.refreshSection('sectionBenchmark2Y');
  assert.equal(hits, 2, '조회 버튼은 다시 받아 온다');
});

test('전체 조회: 알림 일괄 조회와 모든 메뉴 값을 다시 불러오고, 메뉴는 펼치지 않으며 결과를 한 번에 알린다', async () => {
  const client = loadClient();
  stubMenuLoaders(client);
  await client.context.refreshAllSections();
  const calls = sortedCalls(client);
  for (const name of ['loadDashboard', 'renderBenchmark2YPanel', 'loadAnywhereTop10', 'loadReturnDateMatrix', 'loadScheduleRecommendations', 'loadRoutePriceTrend']) {
    assert.ok(calls.includes(name), `${name} 를 부른다`);
  }
  assert.equal(calls.filter((c) => c === 'handleBatchCheck').length, 1, '알림 일괄 조회는 한 번');
  for (const id of SECTION_IDS) assert.equal(client.run(`state.collapsedSections.${id}`), true, `${id} 는 접힌 그대로`);
  const toast = lastToast(client);
  assert.match(toast.message, /전체 조회 완료/);
  assert.match(toast.message, /일괄 조회 완료! \(1개 고유 노선 조회\)/, '알림 일괄 조회 결과를 함께 알린다');
  assert.equal(client.context.document.getElementById('btnBatchCheck').disabled, false);
});

test('전체 조회: 실제 운임 모드에서 알림 실시간 조회를 취소해도 메뉴 값은 다시 불러온다', async () => {
  const client = loadClient();
  stubMenuLoaders(client);
  client.run(`handleBatchCheck = async () => { globalThis.__calls.push('handleBatchCheck'); return null; };`);
  await client.context.refreshAllSections();
  const calls = sortedCalls(client);
  assert.ok(calls.includes('loadAnywhereTop10') && calls.includes('loadDashboard'));
  assert.match(lastToast(client).message, /전체 조회 완료/);
});

test('알림 일괄 조회: 결과 문구를 돌려주고(전체 조회가 함께 알림), 진행 중이면 또 돌리지 않는다', async () => {
  const client = loadClient();
  client.run(`
    globalThis.__toasts = [];
    showToast = (message) => { globalThis.__toasts.push(message); };
    loadDashboard = async () => {};
    globalThis.__release = null;
    globalThis.__fetches = 0;
    // 첫 호출만 붙잡아 두고 그다음 호출은 바로 끝낸다 (막는 장치가 없으면 멈추지 않고 실패하게)
    apiFetch = () => {
      globalThis.__fetches += 1;
      const res = { ok: true, status: 200, json: async () => ({ checkedGroups: 2, savedApiCalls: 0, notificationsSent: [] }) };
      if (globalThis.__fetches > 1) return Promise.resolve(res);
      return new Promise((resolve) => { globalThis.__release = () => resolve(res); });
    };
  `);
  const first = client.context.handleBatchCheck();
  const second = client.context.handleBatchCheck();
  assert.match(client.run('globalThis.__toasts[globalThis.__toasts.length - 1]'), /이미/);
  client.run('globalThis.__release()');
  const [result, again] = await Promise.all([first, second]);
  assert.match(result.message, /일괄 조회 완료! \(2개 고유 노선 조회/);
  assert.equal(result.icon, '✅');
  assert.equal(result.dashboardReloaded, true, '대시보드를 다시 불러왔다고 알린다 (전체 조회가 또 부르지 않게)');
  assert.equal(again.message, result.message, '두 번째 호출은 진행 중인 일괄 조회가 끝나기를 기다려 같은 결과를 받는다');
  assert.equal(client.run('globalThis.__fetches'), 1, '일괄 조회 요청은 한 번');
});

// 실제 로더를 그대로 쓰고 화면 그리기만 뺀다 (로더가 스스로 삼키는 실패를 refreshSection 이 알아채는지 보려고)
function stubRendersOnly(client) {
  client.run(`
    globalThis.__toasts = [];
    showToast = (message, icon) => { globalThis.__toasts.push({ message, icon }); };
    applySectionCollapseDom = () => {};
    renderAnywhereTop10 = () => {};
    renderReturnDateMatrix = () => {};
    renderScheduleRecommendations = () => {};
    renderChartRouteSelectOptions = () => {};
    renderPriceChart = () => {};
  `);
}

test('메뉴별 조회: 로더가 실패를 삼켜도(가격 추이 오류) 완료 대신 ⚠️ 와 이유를 알린다', async () => {
  const client = loadClient();
  stubRendersOnly(client);
  client.run(`apiFetch = async () => { throw new Error('엔진 응답 없음'); };`);
  await client.context.refreshSection('sectionPriceChart');
  const toast = lastToast(client);
  assert.equal(toast.icon, '⚠️');
  assert.match(toast.message, /가격 추이.*엔진 응답 없음/);
  assert.doesNotMatch(toast.message, /조회 완료/);
});

test('메뉴별 조회: 실제 운임 모드에서 Travelpayouts 한도 초과로 모의 가격을 대신 보이면 ⚠️ 로 그 탭과 이유를 알린다', async () => {
  const client = loadClient({
    routes: {
      'GET anywhere-top10': async () => jsonResponse(429, { error: '조회 한도', code: 'TP_RATE_LIMIT' }),
      'GET return-date-matrix': async () => jsonResponse(200, { realFare: true, returnOptions: [] }),
      'GET schedule-recommendations': async () => jsonResponse(200, { realFare: true, schedules: [] })
    }
  });
  enableRealMode(client);
  stubRendersOnly(client);
  client.run(`apiFetch = async () => ({ ok: true, status: 200, json: async () => ({ simulated: true, tiers: {} }) });`);
  await client.context.refreshSection('sectionExplorer');
  const toast = lastToast(client);
  assert.equal(toast.icon, '⚠️');
  assert.match(toast.message, /TOP 30.*무료 조회 한도 초과.*모의 가격/);
  assert.doesNotMatch(toast.message, /조회 완료/);
});

test('메뉴별 조회: 조회 중 PIN 이 바뀌어 모의 가격으로 돌아가면 그 안내를 완료 안내로 덮지 않는다', async () => {
  const client = loadClient({
    routes: { 'GET route-price-trend': async () => jsonResponse(401, { error: 'PIN 이 맞지 않습니다.', code: 'PIN_INVALID' }) }
  });
  enableRealMode(client);
  stubRendersOnly(client);
  client.run(`apiFetch = async () => ({ ok: true, status: 200, json: async () => ({ points: [] }) });`);
  await client.context.refreshSection('sectionPriceChart');
  assert.equal(client.run('realFareState.enabled'), false);
  assert.match(lastToast(client).message, /PIN 이 바뀌었거나 맞지 않아 모의 가격으로 돌아갑니다/);
});

test('전체 조회: 알림 일괄 조회가 대시보드를 다시 불러왔으면 또 부르지 않고, 취소했으면 한 번 부른다', async () => {
  const client = loadClient();
  stubMenuLoaders(client);
  const dashboardLoads = () => client.run('globalThis.__calls.filter((c) => c === "loadDashboard").length');
  client.run(`handleBatchCheck = async () => ({ message: '일괄 조회 완료!', icon: '✅', dashboardReloaded: true });`);
  await client.context.refreshAllSections();
  assert.equal(dashboardLoads(), 0);
  client.run(`globalThis.__calls = []; handleBatchCheck = async () => null;`);
  await client.context.refreshAllSections();
  assert.equal(dashboardLoads(), 1);
});

test('전체 조회: 메뉴 하나가 모의 가격으로 대신했으면 ✅ 대신 ⚠️ 로 그 이유를 함께 알린다', async () => {
  const client = loadClient();
  stubMenuLoaders(client);
  client.run(`loadRoutePriceTrend = async () => { state.routeTrendError = '엔진 응답 없음'; };`);
  await client.context.refreshAllSections();
  const toast = lastToast(client);
  assert.equal(toast.icon, '⚠️');
  assert.match(toast.message, /전체 조회 완료.*가격 추이.*엔진 응답 없음/);
});

test('대시보드: 늦게 도착한 옛 응답이 나중에 시작한 조회 결과를 덮지 않는다', async () => {
  const client = loadClient();
  client.run(`
    renderStatusAndKpis = () => {};
    renderWatchRules = () => {};
    renderChartRouteSelectOptions = () => {};
    renderPriceChart = () => {};
    renderKakaoPreviewAndLogs = () => {};
    loadRoutePriceTrend = async () => {};
    globalThis.__pending = [];
    apiFetch = () => new Promise((resolve) => { globalThis.__pending.push(resolve); });
  `);
  const body = (id) => ({ ok: true, status: 200, json: async () => ({ watchRules: [{ id }], notificationLogs: [], statusSummary: {} }) });
  const older = client.context.loadDashboard();
  const newer = client.context.loadDashboard();
  client.run('globalThis.__pending')[1](body('newer'));
  await newer;
  client.run('globalThis.__pending')[0](body('older'));
  await older;
  assert.deepEqual([...client.run('state.watchRules.map((r) => r.id)')], ['newer']);
});

test('메뉴 머리글마다 조회 버튼이 있고 눌러도 메뉴가 접히거나 펴지지 않으며, 머리글 전체 조회는 모든 메뉴를 부른다', () => {
  for (const dir of ['public', 'docs']) {
    const html = fs.readFileSync(path.join(__dirname, '..', dir, 'index.html'), 'utf8');
    const toastTag = html.match(/<div id="toastBanner"[^>]*>/);
    assert.ok(toastTag && toastTag[0].includes('role="status"') && toastTag[0].includes('aria-live="polite"'), `${dir}: 결과 안내를 화면 읽기 프로그램도 읽는다`);
    for (const id of SECTION_IDS) {
      const tag = html.match(new RegExp(`<button[^>]*id="btnRefresh_${id}"[^>]*>`));
      assert.ok(tag, `${dir}: ${id} 조회 버튼`);
      assert.ok(tag[0].includes(`onclick="event.stopPropagation(); refreshSection('${id}')"`), `${dir}: ${id} 조회 버튼은 접기와 따로`);
      assert.ok(tag[0].includes('type="button"'), `${dir}: ${id} 는 폼을 제출하지 않는다`);
    }
    const batchTag = html.match(/<button[^>]*id="btnBatchCheck"[^>]*>/);
    assert.ok(batchTag && batchTag[0].includes('onclick="refreshAllSections()"'), `${dir}: 전체 조회`);
  }
});
