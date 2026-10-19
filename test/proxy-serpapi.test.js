/**
 * SerpApi 구글 플라이트(편도) 요청 만들기·응답 정리·오류 처리
 * - 실제 네트워크는 부르지 않는다 (fetch 를 바꿔 끼움). 응답 모양은 serpapi.com/google-flights-api 문서 기준.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildOneWaySearchParams,
  normalizeOneWayResults,
  searchOneWay,
  summarizeAccount,
  SerpApiError
} = require('../proxy/lib/serpapi');
const { AIRLINE_CODE_TO_NAME } = require('../proxy/lib/engine/config/airports');

const KEY = 'test-serpapi-key-123';

function flightItem({ price, segments, type = 'One way' }) {
  return {
    flights: segments.map(([from, to, dep, arr, airline, no]) => ({
      departure_airport: { name: from, id: from, time: dep },
      arrival_airport: { name: to, id: to, time: arr },
      duration: 90,
      airline,
      flight_number: no,
      travel_class: 'Economy'
    })),
    total_duration: 90,
    price,
    type,
    booking_token: 'tok'
  };
}

const ICN_TAO = {
  search_metadata: { id: 'abc', status: 'Success', google_flights_url: 'https://www.google.com/travel/flights?hl=ko' },
  best_flights: [
    flightItem({ price: 139400, segments: [['ICN', 'TAO', '2027-04-12 22:55', '2027-04-12 23:40', '산둥항공', 'SC 4620']] })
  ],
  other_flights: [
    flightItem({ price: 152000, segments: [['ICN', 'TAO', '2027-04-12 08:30', '2027-04-12 09:20', '대한항공', 'KE 845']] }),
    flightItem({ price: 98000, segments: [['ICN', 'TAO', '2027-04-12 23:30', '2027-04-13 00:20', '칭다오항공', 'QW 9902']] }),
    { price: null, flights: [] }
  ],
  price_insights: { lowest_price: 98000 }
};

test('편도 검색 요청: 엔진·편도·KRW·한국어·성인 1명·직항만', () => {
  const p = buildOneWaySearchParams({ from: 'ICN', to: 'TAO', date: '2027-04-12', nonstop: true });
  assert.equal(p.get('engine'), 'google_flights');
  assert.equal(p.get('type'), '2');
  assert.equal(p.get('departure_id'), 'ICN');
  assert.equal(p.get('arrival_id'), 'TAO');
  assert.equal(p.get('outbound_date'), '2027-04-12');
  assert.equal(p.get('currency'), 'KRW');
  assert.equal(p.get('hl'), 'ko');
  assert.equal(p.get('gl'), 'kr');
  assert.equal(p.get('adults'), '1');
  assert.equal(p.get('stops'), '1');
  assert.equal(p.get('api_key'), null, '키는 보낼 때만 붙인다');
  assert.equal(p.get('no_cache'), null, '1시간 캐시(무료)를 쓰도록 no_cache 를 보내지 않는다');

  const any = buildOneWaySearchParams({ from: 'ICN,GMP', to: 'KIX', date: '2027-04-12', nonstop: false });
  assert.equal(any.get('stops'), '0');
  assert.equal(any.get('departure_id'), 'ICN,GMP');
});

test('응답 정리: 가격순, 항공사 코드·편명·시각·자정 넘김 표시, 가격 없는 항목은 버림', () => {
  const list = normalizeOneWayResults(ICN_TAO);
  assert.deepEqual(list.map((c) => c.oneWayPriceKrw), [98000, 139400, 152000]);
  assert.deepEqual(list[0], {
    airline: '칭다오항공',
    airlineCode: 'QW',
    flightNumber: 'QW9902',
    fromAirportCode: 'ICN',
    toAirportCode: 'TAO',
    date: '2027-04-12',
    departureTime: '23:30',
    arrivalTime: '00:20',
    scheduleTime: '23:30 → 00:20(+1)',
    stops: 0,
    durationMinutes: 90,
    oneWayPriceKrw: 98000
  });
  assert.equal(list[1].flightNumber, 'SC4620');
  assert.equal(list[1].scheduleTime, '22:55 → 23:40');
});

test('경유 항목은 첫 구간 편명과 경유 횟수를 남긴다', () => {
  const json = {
    other_flights: [
      flightItem({
        price: 210000,
        segments: [
          ['PUS', 'NRT', '2026-11-08 08:00', '2026-11-08 10:10', '진에어', 'LJ 201'],
          ['NRT', 'KMJ', '2026-11-08 13:00', '2026-11-08 15:00', 'ANA', 'NH 643']
        ]
      })
    ]
  };
  const [c] = normalizeOneWayResults(json);
  assert.equal(c.stops, 1);
  assert.equal(c.flightNumber, 'LJ201');
  assert.equal(c.fromAirportCode, 'PUS');
  assert.equal(c.toAirportCode, 'KMJ');
  assert.equal(c.scheduleTime, '08:00 → 15:00');
});

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    const { status = 200, body } = handler(String(url));
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { impl, calls };
}

test('외부 값은 형식을 확인한다: 공항 코드·출발 시각이 틀리면 버리고, 편명·도착 시각·소요 시간은 안전한 값만 남긴다', () => {
  const json = {
    best_flights: [
      flightItem({ price: 100000, segments: [['IC<N', 'TAO', '2027-04-12 08:00', '2027-04-12 09:00', '산둥항공', 'SC 1']] }),
      flightItem({ price: 100001, segments: [['ICN', 'TAO', '<b>2027-04-12</b>', '2027-04-12 09:00', '산둥항공', 'SC 2']] }),
      flightItem({ price: 100002, segments: [['ICN', 'TAO', '2027-04-12 08:00', 'soon"<x>', '산둥항공', 'SC 3<script>']] }),
      { ...flightItem({ price: 100003, segments: [['ICN', 'TAO', '2027-04-12 08:00', '2027-04-12 09:00', '산둥항공', 'X'.repeat(500)]] }), total_duration: 'Infinity' },
      flightItem({ price: 100004, segments: [['icn', 'tao', '2027-04-12 08:00', '2027-04-12 09:00', '산둥항공', 'TW 9']] })
    ]
  };
  const list = normalizeOneWayResults(json);
  assert.deepEqual(list.map((c) => c.oneWayPriceKrw), [100002, 100003, 100004], '공항 코드·출발 시각이 틀린 항목은 버림');
  const [badArrival, longNumber, lowerCase] = list;
  assert.equal(badArrival.arrivalTime, '--:--');
  assert.equal(badArrival.scheduleTime, '08:00 → --:--');
  assert.equal(badArrival.flightNumber, '', '형식이 틀린 편명은 비움');
  assert.equal(badArrival.airlineCode, '');
  assert.equal(longNumber.flightNumber, '', '너무 긴 편명은 비움');
  assert.equal(longNumber.durationMinutes, 90, '소요 시간이 숫자가 아니면 구간 합');
  assert.equal(lowerCase.fromAirportCode, 'ICN');
  assert.equal(lowerCase.toAirportCode, 'TAO');
  assert.equal(lowerCase.flightNumber, 'TW9');
  for (const c of list) {
    for (const v of Object.values(c)) assert.ok(!/[<>"'`&]/.test(String(v)), `안전하지 않은 글자: ${v}`);
  }
});

test('검색은 키를 붙여 search.json 을 부르고 결과·실제 검색 시각을 돌려준다 (쓰지 않는 외부 주소는 넘기지 않음)', async () => {
  const body = { ...ICN_TAO, search_metadata: { ...ICN_TAO.search_metadata, created_at: '2026-10-19 03:04:05 UTC' } };
  const f = fakeFetch(() => ({ body }));
  const out = await searchOneWay({ apiKey: KEY, fetchImpl: f.impl, from: 'ICN', to: 'TAO', date: '2027-04-12', nonstop: true });
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].startsWith('https://serpapi.com/search.json?'));
  assert.ok(f.calls[0].includes(`api_key=${KEY}`));
  assert.equal(out.candidates.length, 3);
  assert.equal('googleFlightsUrl' in out, false);
  // SerpApi 는 같은 검색을 1시간 캐시하므로 '조회 시각'은 SerpApi 가 실제로 검색한 시각이다
  assert.equal(out.searchedAt, '2026-10-19T03:04:05.000Z');

  const noStamp = await searchOneWay({ apiKey: KEY, fetchImpl: fakeFetch(() => ({ body: ICN_TAO })).impl, from: 'ICN', to: 'TAO', date: '2027-04-12', nonstop: true });
  assert.equal(noStamp.searchedAt, null);
});

test('항공사 이름은 앱 이름표를 먼저 쓰고(다른 화면과 같은 이름), 이름표에 없는 코드만 구글 표기를 쓴다', () => {
  const json = {
    best_flights: [
      flightItem({ price: 154900, segments: [['TAE', 'NRT', '2026-11-09 15:00', '2026-11-09 17:10', 'Trinity Airways', 'TW 257']] }),
      flightItem({ price: 160000, segments: [['ICN', 'TAO', '2026-11-09 22:55', '2026-11-09 23:40', '산둥항공', 'SC 4620']] }),
      flightItem({ price: 170000, segments: [['ICN', 'TAO', '2026-11-09 23:30', '2026-11-10 00:20', '칭다오항공', 'QW 9902']] })
    ]
  };
  const [tw, sc, qw] = normalizeOneWayResults(json);
  assert.equal(tw.airline, AIRLINE_CODE_TO_NAME.TW, '같은 TW 편이 화면마다 다른 이름으로 보이지 않게');
  assert.equal(sc.airline, AIRLINE_CODE_TO_NAME.SC);
  assert.equal(AIRLINE_CODE_TO_NAME.QW, undefined, '시험 전제: QW 는 이름표에 없음');
  assert.equal(qw.airline, '칭다오항공');
});

test('항공사 이름 등 외부 글자에서 태그·따옴표를 빼고 길이를 자른다', () => {
  const json = {
    best_flights: [
      flightItem({ price: 100000, segments: [['ICN', 'TAO', '2027-04-12 08:00', '2027-04-12 09:00', '<script>"x"</script>'.repeat(5), 'QW 1']] })
    ]
  };
  const [c] = normalizeOneWayResults(json);
  assert.ok(!/[<>"]/.test(c.airline));
  assert.ok(c.airline.length <= 40);
});

test('결과 없음은 오류가 아니라 빈 목록, 키 오류·한도 초과·기타 오류는 키를 드러내지 않는 오류로', async () => {
  const empty = fakeFetch(() => ({ body: { search_metadata: { status: 'Success' }, error: "Google Flights hasn't returned any results for this query." } }));
  const none = await searchOneWay({ apiKey: KEY, fetchImpl: empty.impl, from: 'CJU', to: 'KMJ', date: '2026-11-08', nonstop: true });
  assert.deepEqual(none.candidates, []);

  const cases = [
    [401, { error: 'Invalid API key.' }, 'SERPAPI_AUTH'],
    [429, { error: 'Your account has run out of searches.' }, 'SERPAPI_LIMIT'],
    [500, { error: 'Something went wrong' }, 'SERPAPI_ERROR'],
    [200, { search_metadata: { status: 'Error' }, error: 'Unsupported departure_id' }, 'SERPAPI_ERROR']
  ];
  for (const [status, body, code] of cases) {
    const f = fakeFetch(() => ({ status, body }));
    await assert.rejects(
      searchOneWay({ apiKey: KEY, fetchImpl: f.impl, from: 'ICN', to: 'TAO', date: '2027-04-12', nonstop: true }),
      (err) => {
        assert.ok(err instanceof SerpApiError);
        assert.equal(err.code, code);
        assert.ok(!String(err.message).includes(KEY), '메시지에 키 없음');
        assert.ok(!String(err.message).includes('serpapi.com/search'), '메시지에 요청 주소 없음');
        return true;
      }
    );
  }

  const network = async () => { throw new Error(`connect ECONNREFUSED https://serpapi.com/search.json?api_key=${KEY}`); };
  await assert.rejects(
    searchOneWay({ apiKey: KEY, fetchImpl: network, from: 'ICN', to: 'TAO', date: '2027-04-12', nonstop: true }),
    (err) => err.code === 'SERPAPI_NETWORK' && !String(err.message).includes(KEY)
  );
});

test('계정 정보는 남은 횟수만 남기고 키·이메일은 버린다', () => {
  const summary = summarizeAccount({
    api_key: KEY,
    account_email: 'someone@example.com',
    plan_name: 'Free Plan',
    searches_per_month: 250,
    plan_searches_left: 241,
    total_searches_left: 241,
    this_month_usage: 9,
    this_hour_searches: 2,
    account_rate_limit_per_hour: 50
  });
  assert.deepEqual(summary, {
    planName: 'Free Plan',
    searchesPerMonth: 250,
    searchesLeft: 241,
    thisMonthUsage: 9,
    thisHourSearches: 2,
    hourlyLimit: 50
  });
  assert.ok(!JSON.stringify(summary).includes(KEY));
  assert.ok(!JSON.stringify(summary).includes('example.com'));
});

test('계정 요약의 외부 값도 정리한다: 요금제 이름은 태그를 빼고, 숫자가 아닌 횟수는 비운다', () => {
  const summary = summarizeAccount({
    plan_name: '<img src=x onerror=alert(1)>Free Plan',
    searches_per_month: '250',
    total_searches_left: 'many',
    this_month_usage: null,
    this_hour_searches: { n: 1 }
  });
  assert.ok(!/[<>"']/.test(summary.planName));
  assert.equal(summary.searchesPerMonth, 250);
  assert.equal(summary.searchesLeft, null);
  assert.equal(summary.thisMonthUsage, null);
  assert.equal(summary.thisHourSearches, null);
  assert.equal(summary.hourlyLimit, null);
});
