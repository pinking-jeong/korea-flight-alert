/**
 * Travelpayouts 데이터 API (prices_for_dates) 요청·정리·환산·오류 처리
 * - 실제 네트워크는 부르지 않는다. 응답 모양은 공식 문서(Aviasales Data API, 2026-09-06 갱신)와 Postman 예시 기준.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createTravelpayoutsClient,
  normalizeTickets,
  aviasalesUrl,
  searchedOnFromLink,
  TravelpayoutsError
} = require('../proxy/lib/travelpayouts');
const { createTtlCache } = require('../proxy/lib/cache');

const TOKEN = 'tp-test-token-xyz';

function ticket(overrides = {}) {
  return {
    origin: 'SEL',
    destination: 'TYO',
    origin_airport: 'ICN',
    destination_airport: 'NRT',
    price: 123400,
    airline: 'KE',
    flight_number: '703',
    departure_at: '2026-11-14T08:55:00+09:00',
    transfers: 0,
    return_transfers: 0,
    duration: 145,
    duration_to: 145,
    link: '/search/ICN1411NRT1?t=KE17631043001763113000000145ICNNRT_abc_123400&search_date=19102026',
    ...overrides
  };
}

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url: String(url), headers: options.headers || {} });
    const { status = 200, body } = handler(String(url));
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { impl, calls };
}

test('편도 운임 요청: 토큰은 헤더로만, 원화·편도·가격순·최대 1000개, 시장(market)은 설정했을 때만', async () => {
  const f = fakeFetch(() => ({ body: { success: true, currency: 'krw', data: [ticket()] } }));
  const tp = createTravelpayoutsClient({ token: TOKEN, fetchImpl: f.impl });
  await tp.fetchTickets({ origin: 'ICN', destination: 'NRT', month: '2026-11', direct: true });
  const { url, headers } = f.calls[0];
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://api.travelpayouts.com/aviasales/v3/prices_for_dates');
  assert.equal(u.searchParams.get('origin'), 'ICN');
  assert.equal(u.searchParams.get('destination'), 'NRT');
  assert.equal(u.searchParams.get('departure_at'), '2026-11');
  assert.equal(u.searchParams.get('one_way'), 'true');
  assert.equal(u.searchParams.get('direct'), 'true');
  assert.equal(u.searchParams.get('currency'), 'krw');
  assert.equal(u.searchParams.get('sorting'), 'price');
  assert.equal(u.searchParams.get('limit'), '1000');
  assert.equal(u.searchParams.get('market'), null);
  assert.equal(u.searchParams.get('token'), null, '토큰은 주소에 넣지 않는다');
  assert.ok(!url.includes(TOKEN));
  assert.equal(headers['X-Access-Token'], TOKEN);

  const anywhere = fakeFetch(() => ({ body: { success: true, currency: 'krw', data: [] } }));
  const tp2 = createTravelpayoutsClient({ token: TOKEN, fetchImpl: anywhere.impl, market: 'us' });
  await tp2.fetchTickets({ origin: 'ICN', month: '2026-11', unique: true });
  const u2 = new URL(anywhere.calls[0].url);
  assert.equal(u2.searchParams.get('destination'), null, '도착지를 비우면 이 공항에서 가는 모든 곳');
  assert.equal(u2.searchParams.get('unique'), 'true');
  assert.equal(u2.searchParams.get('market'), 'us');
});

test('응답 정리: 요청한 달 밖(가까운 날짜 대체)·왕복·잘못된 값은 버리고 현지 날짜·시각·편명을 쓴다', () => {
  const body = {
    success: true,
    currency: 'krw',
    data: [
      ticket(),
      ticket({ departure_at: '2026-12-01T09:00:00+09:00', price: 50000 }),
      ticket({ return_at: '2026-11-18T10:00:00+09:00', price: 60000 }),
      ticket({ price: 0 }),
      ticket({ price: 'abc' }),
      ticket({ origin_airport: 'ICN1', price: 70000 }),
      ticket({ departure_at: '2026-11-30T23:40:00+09:00', price: 99000, airline: 'TW', flight_number: '201', transfers: 1, duration_to: 300 })
    ]
  };
  const list = normalizeTickets(body, 1, { month: '2026-11', now: Date.parse('2026-10-19T12:00:00Z') });
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], {
    originAirport: 'ICN',
    destinationAirport: 'NRT',
    originCity: 'SEL',
    destinationCity: 'TYO',
    date: '2026-11-14',
    departureTime: '08:55',
    priceKrw: 123400,
    airlineCode: 'KE',
    flightNumber: 'KE703',
    transfers: 0,
    durationMinutes: 145,
    sourceUrl: 'https://www.aviasales.com/search/ICN1411NRT1?t=KE17631043001763113000000145ICNNRT_abc_123400&search_date=19102026',
    searchedOn: '2026-10-19'
  });
  assert.equal(list[1].date, '2026-11-30', '현지 시각 기준 날짜 (UTC 로 바꾸지 않는다)');
  assert.equal(list[1].transfers, 1);
});

test('검색한 날: 출처 링크의 search_date(일월년 8자리)를 YYYY-MM-DD 로, 없거나 없는 날짜·내일보다 뒤·1년보다 앞이면 null', () => {
  const now = Date.parse('2026-10-19T12:00:00Z');
  const on = (link, at = now) => searchedOnFromLink(link, at);
  assert.equal(on('/search/ICN1411NRT1?t=KE_x&search_date=16102026&expected_price=1'), '2026-10-16');
  assert.equal(on('/ICN1411NRT1?search_date=19102026'), '2026-10-19');
  assert.equal(on('/search/ICN1411NRT1?t=KE_x'), null, '값이 없으면');
  assert.equal(on('/search/ICN1411NRT1?search_date=32102026'), null, '32일');
  assert.equal(on('/search/ICN1411NRT1?search_date=16132026'), null, '13월');
  // 날짜 계산이 다음 달로 넘겨 버리는 없는 날 (09-31 → 10-01, 평년 02-29 → 03-01 — 둘 다 범위 안이라 날짜 꼴 검사로만 걸러진다)
  assert.equal(on('/search/ICN1411NRT1?search_date=31092026'), null, '9월 31일');
  assert.equal(on('/search/ICN1411NRT1?search_date=29022026'), null, '평년 2월 29일');
  assert.equal(on('/search/ICN1411NRT1?search_date=29022028', Date.parse('2028-03-01T00:00:00Z')), '2028-02-29', '윤년');
  assert.equal(on('/search/ICN1411NRT1?search_date=1610202'), null, '7자리');
  assert.equal(on('/search/ICN1411NRT1?x_search_date=16102026'), null, '다른 이름의 값');
  assert.equal(on(undefined), null);
  // 검색 시각은 한국보다 늦은 시간대의 날짜라 하루 앞선 날까지는 받고, 그보다 뒤·1년(366일)보다 앞은 엉뚱한 값으로 본다
  assert.equal(on('/x?search_date=20102026'), '2026-10-20');
  assert.equal(on('/x?search_date=21102026'), null);
  assert.equal(on('/x?search_date=01019999'), null);
  assert.equal(on('/x?search_date=19102025'), '2025-10-19');
  assert.equal(on('/x?search_date=17102025'), null);
  assert.equal(on('/x?search_date=01010000'), null);
  const [noDate] = normalizeTickets({ data: [ticket({ link: '/search/ICN1411NRT1?t=KE' })] }, 1, { month: '2026-11', now });
  assert.equal(noDate.searchedOn, null);
});

test('검색한 날의 기준 시각은 클라이언트에 넘긴 시계(now)를 따른다', async () => {
  const f = fakeFetch(() => ({ body: { success: true, currency: 'krw', data: [ticket({ link: '/search/ICN1411NRT1?t=KE&search_date=01012030' })] } }));
  const at2030 = createTravelpayoutsClient({ token: TOKEN, fetchImpl: f.impl, now: () => Date.parse('2030-01-02T00:00:00Z') });
  assert.equal((await at2030.fetchTickets({ origin: 'ICN', destination: 'NRT', month: '2026-11' })).value[0].searchedOn, '2030-01-01');
  const at2026 = createTravelpayoutsClient({ token: TOKEN, fetchImpl: f.impl, now: () => Date.parse('2026-10-19T00:00:00Z') });
  assert.equal((await at2026.fetchTickets({ origin: 'ICN', destination: 'NRT', month: '2026-11' })).value[0].searchedOn, null, '2026년에 2030년 검색은 없다');
});

test('Aviasales 링크는 /search/ 가 있든 없든 같은 주소로 만들고, 이상한 값은 버린다', () => {
  assert.equal(aviasalesUrl('/MOW1409LED1?t=N4_x&search_date=29072021'), 'https://www.aviasales.com/search/MOW1409LED1?t=N4_x&search_date=29072021');
  assert.equal(aviasalesUrl('/search/MOW1409LED1?t=N4'), 'https://www.aviasales.com/search/MOW1409LED1?t=N4');
  assert.equal(aviasalesUrl('javascript:alert(1)'), null);
  assert.equal(aviasalesUrl('//evil.example/x'), null);
  assert.equal(aviasalesUrl(''), null);
});

test('원화가 아닌 통화로 오면 공개 환율표(루블 기준)로 원화 환산하고, 환율표는 한 번만 받는다', async () => {
  const f = fakeFetch((url) => {
    if (url.includes('currency.json')) return { body: { rub: 1, krw: 0.0625, usd: 84 } };
    return { body: { success: true, currency: 'rub', data: [ticket({ price: 1000 })] } };
  });
  const tp = createTravelpayoutsClient({ token: TOKEN, fetchImpl: f.impl });
  const first = await tp.fetchTickets({ origin: 'ICN', destination: 'NRT', month: '2026-11' });
  assert.equal(first.value[0].priceKrw, 16000);
  await tp.fetchTickets({ origin: 'ICN', destination: 'NRT', month: '2026-12' });
  assert.equal(f.calls.filter((c) => c.url.includes('currency.json')).length, 1);

  const noCurrency = fakeFetch(() => ({ body: { success: true, data: [ticket()] } }));
  await assert.rejects(
    createTravelpayoutsClient({ token: TOKEN, fetchImpl: noCurrency.impl }).fetchTickets({ origin: 'ICN', destination: 'NRT', month: '2026-11' }),
    (err) => err instanceof TravelpayoutsError && err.code === 'TP_ERROR'
  );
});

test('같은 요청은 캐시에서 돌려주고(조회 시각 유지), 오류는 토큰을 드러내지 않는 코드로 바꾼다', async () => {
  let now = 1_000_000;
  const f = fakeFetch(() => ({ body: { success: true, currency: 'krw', data: [ticket()] } }));
  const tp = createTravelpayoutsClient({ token: TOKEN, fetchImpl: f.impl, cache: createTtlCache({ now: () => now }) });
  const a = await tp.fetchTickets({ origin: 'ICN', destination: 'NRT', month: '2026-11' });
  now += 60_000;
  const b = await tp.fetchTickets({ origin: 'ICN', destination: 'NRT', month: '2026-11' });
  assert.equal(f.calls.length, 1);
  assert.equal(a.cached, false);
  assert.equal(b.cached, true);
  assert.equal(b.storedAt, a.storedAt);

  const cases = [
    [401, 'TP_AUTH'],
    [403, 'TP_AUTH'],
    [429, 'TP_RATE_LIMIT'],
    [500, 'TP_ERROR']
  ];
  for (const [status, code] of cases) {
    const bad = fakeFetch(() => ({ status, body: null }));
    await assert.rejects(
      createTravelpayoutsClient({ token: TOKEN, fetchImpl: bad.impl }).fetchTickets({ origin: 'ICN', destination: 'NRT', month: '2026-11' }),
      (err) => err.code === code && !String(err.message).includes(TOKEN)
    );
  }
  const refused = fakeFetch(() => ({ body: { success: false, error: `bad token ${TOKEN}` } }));
  await assert.rejects(
    createTravelpayoutsClient({ token: TOKEN, fetchImpl: refused.impl }).fetchTickets({ origin: 'ICN', destination: 'NRT', month: '2026-11' }),
    (err) => err.code === 'TP_ERROR' && !String(err.message).includes(TOKEN)
  );
  const down = async () => {
    throw new Error(`getaddrinfo ENOTFOUND ${TOKEN}`);
  };
  await assert.rejects(
    createTravelpayoutsClient({ token: TOKEN, fetchImpl: down }).fetchTickets({ origin: 'ICN', destination: 'NRT', month: '2026-11' }),
    (err) => err.code === 'TP_NETWORK' && !String(err.message).includes(TOKEN)
  );
});

test('항공사 이름: 한국어 이름표 → 공개 항공사 목록의 영어 이름 → 코드 순, 목록을 못 받아도 오류 없이 코드', async () => {
  const f = fakeFetch((url) => {
    if (url.endsWith('/data/ko/airlines.json')) {
      return {
        body: [
          { code: 'QW', name: null, name_translations: { en: 'Qingdao Airlines' } },
          { code: 'N4', name: 'Nordwind <b>', name_translations: { en: 'Nordwind Airlines' } }
        ]
      };
    }
    return { body: { success: true, currency: 'krw', data: [] } };
  });
  const tp = createTravelpayoutsClient({ token: TOKEN, fetchImpl: f.impl });
  const names = await tp.resolveAirlineNames(['KE', 'QW', 'N4', 'ZZ']);
  assert.equal(names.get('KE'), '대한항공');
  assert.equal(names.get('QW'), 'Qingdao Airlines');
  assert.equal(names.get('N4'), 'Nordwind b');
  assert.equal(names.get('ZZ'), 'ZZ');

  const offline = createTravelpayoutsClient({
    token: TOKEN,
    fetchImpl: async () => {
      throw new Error('offline');
    }
  });
  const fallback = await offline.resolveAirlineNames(['QW']);
  assert.equal(fallback.get('QW'), 'QW');
});
