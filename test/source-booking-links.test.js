/**
 * 가격을 가져온 곳에서 '그 항공편'을 여는 예약 링크 (public/realFares.js) — 기대값은 2026-10-20 실제 사이트에서 확인한 것
 * - 최근 검색가(Travelpayouts) → 값이 나온 Aviasales 공유 링크(항공편 서명 t·기대 가격) + currency=krw:
 *   열면 그 항공편의 판매처별 가격 창이 원화로 뜬다 (BKK→TAE TW106: Farera ₩143,552 · City.Travel · Wingie …)
 * - 실시간(구글 플라이트 · SerpApi) → 구글 '선택한 항공편' 예약 화면 (tfs 구간 안 필드 4 = 출발·날짜·도착·항공사·편 번호):
 *   같은 TW106 이 '예약 옵션: Trinity Airways ₩186,956 · Jettzy ₩197,814' 로 열린다
 * - 모의 가격은 편명이 계산식이라 특정 항공편 링크를 만들지 않는다 (지금처럼 '구글 편도' 노선 검색)
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildBookingLinks } = require('../src/config/airports');
const { aviasalesUrl } = require('../proxy/lib/travelpayouts');
const { loadClient } = require('./helpers/client-vm');

// 10-19 실제 TOP 30 응답의 Travelpayouts link (공개 공유 링크 — 토큰·제휴 표시 없음)
const REAL_TP_LINK =
  'https://www.aviasales.com/search/BKK1211TAE1?t=TW17944506001794476400000310BKKTAE_062399a58371f846939bff23ec0cad0c_10712&search_date=19102026&expected_price_uuid=01a15381-5445-8031-6073-fa1e096082f4&static_fare_key=TY%7CP1_JW%7CH1%7CL0%7CCH0%7CR0%7CTBC0&itinerary_key=e8BBhddvlQ4vvjffe25tPA&expected_price_source=share&expected_price_currency=krw&expected_price=171340';
// 10-20 구글에서 '선택한 항공편 · 예약 옵션' 화면이 열린 tfs (BKK→TAE 2026-11-12 TW106 · 성인 1 · 직항 · 편도)
const REAL_BOOKING_TFS = 'CBwQAhpBEgoyMDI2LTExLTEyIh8KA0JLSxIKMjAyNi0xMS0xMhoDVEFFKgJUVzIDMTA2KABqBwgBEgNCS0tyBwgBEgNUQUVAAUgBcAGCAQsI____________AZgBAg';

const TW106 = {
  airline: '트리니티항공',
  airlineCode: 'TW',
  flightNumber: 'TW106',
  fromAirportCode: 'BKK',
  toAirportCode: 'TAE',
  date: '2026-11-12',
  stops: 0,
  oneWayPriceKrw: 171340,
  searchedOn: '2026-10-19',
  sourceUrl: REAL_TP_LINK,
  fareSource: 'TRAVELPAYOUTS_PRICES'
};
const ROUTE_URL = 'https://www.google.com/travel/flights/search?tfs=ROUTE&hl=ko&curr=KRW';

// 시험용 프로토콜 버퍼 해독기 — tfs 가 쓰는 두 형식(varint · 길이가 붙은 바이트)만
function readVarint(bytes, start) {
  let value = 0;
  let shift = 0;
  let pos = start;
  for (;;) {
    const b = bytes[pos++];
    value += (b & 0x7f) * 2 ** shift;
    if (b < 0x80) return [value, pos];
    shift += 7;
  }
}

function decodeMessage(bytes) {
  const fields = [];
  let pos = 0;
  while (pos < bytes.length) {
    let key;
    [key, pos] = readVarint(bytes, pos);
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (wire === 0) {
      let value;
      [value, pos] = readVarint(bytes, pos);
      fields.push({ field, value });
    } else if (wire === 2) {
      let length;
      [length, pos] = readVarint(bytes, pos);
      fields.push({ field, value: Buffer.from(bytes.subarray(pos, pos + length)) });
      pos += length;
    } else {
      throw new Error(`해독기가 모르는 형식 ${wire}`);
    }
  }
  return fields;
}

const valuesOf = (fields, n) => fields.filter((f) => f.field === n).map((f) => f.value);
const textOf = (fields, n) => valuesOf(fields, n).map((v) => v.toString('utf8'));
const tfsOf = (url) => new URL(url).searchParams.get('tfs');
const tfsFields = (url) => decodeMessage(Buffer.from(tfsOf(url), 'base64url'));
const attr = (url) => url.replace(/&/g, '&amp;');
const countOf = (html, re) => (html.match(re) || []).length;

test('Aviasales 가격 출처 링크: Travelpayouts 공유 링크(항공편 서명·기대 가격)는 그대로 두고 원화(currency=krw)만 붙인다', () => {
  const { context } = loadClient();
  assert.equal(context.aviasalesTicketUrl(REAL_TP_LINK), `${REAL_TP_LINK}&currency=krw`);
  // expected_price_currency 는 통화 칸이 아니다 — 이미 currency 가 있으면 건드리지 않는다
  assert.equal(context.aviasalesTicketUrl(`${REAL_TP_LINK}&currency=usd`), `${REAL_TP_LINK}&currency=usd`);
  assert.equal(context.aviasalesTicketUrl('https://www.aviasales.com/search/ICN1411NRT1'), 'https://www.aviasales.com/search/ICN1411NRT1?currency=krw');
  for (const bad of [
    '',
    undefined,
    'javascript:alert(1)',
    'https://evil.example/search/ICN1411NRT1?t=X',
    'https://www.aviasales.com.evil.example/search/A',
    'http://www.aviasales.com/search/ICN1411NRT1?t=X',
    'https://www.aviasales.com/search/A?t=1"onmouseover="alert(1)',
    'https://www.aviasales.com/hotels/A'
  ]) {
    assert.equal(context.aviasalesTicketUrl(bad), '', String(bad));
  }
});

test('Aviasales 가격 출처 링크는 /search/ 뒤 검색 코드 한 칸만 받는다 — 점 경로(../)로 같은 사이트의 다른 곳을 열지 않게', () => {
  const { context } = loadClient();
  assert.equal(context.aviasalesTicketUrl('https://www.aviasales.com/search/MOW1409LED1?t=PS_1_2'), 'https://www.aviasales.com/search/MOW1409LED1?t=PS_1_2&currency=krw');
  for (const bad of [
    'https://www.aviasales.com/search/a/../../hotels?t=1',
    'https://www.aviasales.com/search/a/%2e%2e/%2e%2e/hotels',
    'https://www.aviasales.com/search/a/../..//evil.example/x',
    'https://www.aviasales.com/search/BKK1211TAE1/extra?t=1',
    'https://www.aviasales.com/search/BKK1211TAE1.?t=1',
    'https://www.aviasales.com/search/?t=1'
  ]) {
    assert.equal(context.aviasalesTicketUrl(bad), '', bad);
  }
});

test('프록시가 Travelpayouts link 로 만든 출처 링크를 화면이 그대로 받는다 — 두 검사가 어긋나 링크가 조용히 사라지지 않게', () => {
  // 엔진(sanitizeExternalLeg)까지 거친 길은 real-fares-client 의 귀국일표·추천 일정 시험이 본다 (tpTicket 이 aviasalesUrl 로 만듦)
  const { context } = loadClient();
  const tpLink = REAL_TP_LINK.slice('https://www.aviasales.com'.length); // Travelpayouts 응답의 link 모양 '/search/…'
  for (const link of [tpLink, tpLink.replace('/search/', '/'), '/search/ICN1411NRT1']) {
    const proxied = aviasalesUrl(link);
    assert.ok(proxied, link);
    assert.equal(context.aviasalesTicketUrl(proxied), `${proxied}${proxied.includes('?') ? '&' : '?'}currency=krw`, link);
  }
});

test('구글 같은 항공편 예약 화면: 실제로 열린 tfs 와 바이트까지 같고, 구간 안 필드 4 에 출발·날짜·도착·항공사·편 번호가 들어간다', () => {
  const { context } = loadClient();
  const url = context.googleFlightBookingUrl(TW106, { adults: 1, children: 0, infants: 0 });
  assert.equal(url, `https://www.google.com/travel/flights/booking?tfs=${REAL_BOOKING_TFS}&hl=ko&gl=kr&curr=KRW`);

  const top = tfsFields(url);
  assert.deepEqual(valuesOf(top, 19), [2], '편도');
  assert.deepEqual(valuesOf(top, 8), [1], '성인 1명');
  const legs = valuesOf(top, 3).map(decodeMessage);
  assert.equal(legs.length, 1);
  assert.deepEqual(textOf(legs[0], 2), ['2026-11-12']);
  assert.deepEqual(valuesOf(legs[0], 5), [0], '직항');
  const selected = valuesOf(legs[0], 4).map(decodeMessage);
  assert.equal(selected.length, 1);
  assert.deepEqual(
    [1, 2, 3, 5, 6].map((n) => textOf(selected[0], n)[0]),
    ['BKK', '2026-11-12', 'TAE', 'TW', '106']
  );

  // 인원은 그 카드 링크의 인원 (성인 1 · 소아 2 · 무릎 유아 3 — 노선 검색 링크와 같은 번호)
  const party = tfsFields(context.googleFlightBookingUrl(TW106, { adults: 2, children: 1, infants: 1 }));
  assert.deepEqual(valuesOf(party, 8), [1, 1, 2, 3]);
  // 숫자로 시작하는 항공사 코드 (제주항공 7C)
  const jeju = tfsFields(
    context.googleFlightBookingUrl({ ...TW106, airlineCode: '7C', flightNumber: '7C1101', fromAirportCode: 'ICN', toAirportCode: 'NRT' }, { adults: 1 })
  );
  const jejuSelected = decodeMessage(valuesOf(decodeMessage(valuesOf(jeju, 3)[0]), 4)[0]);
  assert.deepEqual([5, 6].map((n) => textOf(jejuSelected, n)[0]), ['7C', '1101']);
});

test('구글 tfs 의 나머지 칸은 앱이 이미 쓰는 노선 검색 링크(엔진)와 같은 인코딩이다', () => {
  const { context } = loadClient();
  const engineLinks = buildBookingLinks({
    origin: 'ICN',
    destination: 'NRT',
    departureDate: '2026-11-14',
    returnDate: '2026-11-17',
    adults: 2,
    children: 1,
    infants: 1,
    directOnly: true
  });
  const browserTfs = context.googleFlightsTfs({
    from: 'ICN',
    to: 'NRT',
    date: '2026-11-14',
    party: { adults: 2, children: 1, infants: 1 },
    directOnly: true
  });
  assert.equal(browserTfs, tfsOf(engineLinks.outboundGoogleFlightsUrl));
});

test('특정 항공편이라고 말할 수 없으면 구글 같은 편 링크를 만들지 않는다 (편명 없음·경유·모양이 다른 값)', () => {
  const { context } = loadClient();
  const party = { adults: 1 };
  for (const [why, leg] of [
    ['편명을 모름', { ...TW106, flightNumber: 'TW편' }],
    ['항공사 코드와 편명이 다름', { ...TW106, airlineCode: 'KE' }],
    ['편 번호에 글자', { ...TW106, flightNumber: 'TW10A' }],
    ['편 번호가 너무 김', { ...TW106, flightNumber: 'TW10601' }],
    ['경유 1회 (구간을 다 모름)', { ...TW106, stops: 1 }],
    ['경유 횟수 없음', { ...TW106, stops: undefined }],
    ['경유 횟수가 글자', { ...TW106, stops: '0' }],
    ['공항 코드 모양', { ...TW106, fromAirportCode: 'bkk' }],
    ['날짜 모양', { ...TW106, date: '2026/11/12' }],
    ['항공사 코드 모양', { ...TW106, airlineCode: 'T"', flightNumber: 'T"106' }]
  ]) {
    assert.equal(context.googleFlightBookingUrl(leg, party), '', why);
  }
  assert.equal(context.googleFlightBookingUrl(null, party), '');
});

test('최근 검색가 구간: 맨 앞은 가격 출처 Aviasales(원화), 이어서 구글 같은 편 — 노선 검색(구글 편도)은 대신하지 않을 때만', () => {
  const { context } = loadClient();
  const html = context.legBookingLinksHtml(TW106, { fareSource: 'TRAVELPAYOUTS_PRICES', routeGoogleUrl: ROUTE_URL, party: { adults: 1 } });
  const aviasales = `${REAL_TP_LINK}&currency=krw`;
  const google = context.googleFlightBookingUrl(TW106, { adults: 1 });
  assert.ok(html.indexOf(attr(aviasales)) >= 0 && html.indexOf(attr(aviasales)) < html.indexOf(attr(google)), '가격 출처가 먼저');
  assert.match(html, new RegExp(`href="${attr(aviasales).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*data-source-link="aviasales"[^>]*>가격 출처 Aviasales ↗</a>`));
  assert.match(html, /data-same-flight-link="google"[^>]*>구글 같은 편 ↗<\/a>/);
  assert.doesNotMatch(html, /구글 편도 ↗/, '같은 편 링크가 있으면 노선 검색은 붙이지 않는다');
  assert.match(html, /title="[^"]*Aviasales[^"]*TW106 11\/12[^"]*1인 기준[^"]*원화[^"]*"/);
  assert.match(html, /title="[^"]*같은 항공편\(TW106 11\/12\)[^"]*1인 편도[^"]*"/);
  // 구글이 그 편을 팔지 않거나 매진이면 '선택한 일정은 더 이상 예약이 불가능합니다' 가 뜬다 (10-20 TW307 ICN→KIX)
  assert.match(html, /title="[^"]*구글에 없거나 매진인 편은 더 이상 예약할 수 없다고 나옵니다">구글 같은 편 ↗/);
  assert.equal(countOf(html, /onclick="event\.stopPropagation\(\)"/g), 2, '카드 클릭(차트 선택 등)으로 번지지 않는다');
  assert.equal(countOf(html, /class="whitespace-nowrap /g), 2, '좁은 카드에서 글자 중간에 줄이 끊기지 않게');
  assert.ok(html.includes('rel="noopener noreferrer"'));

  // 경유 편: Aviasales 공유 링크는 그 여정을 그대로 열지만, 구글은 구간을 다 몰라 노선 검색으로
  const transfer = context.legBookingLinksHtml({ ...TW106, stops: 1 }, { fareSource: 'TRAVELPAYOUTS_PRICES', routeGoogleUrl: ROUTE_URL, party: { adults: 1 } });
  assert.match(transfer, />가격 출처 Aviasales ↗</);
  assert.match(transfer, new RegExp(`href="${attr(ROUTE_URL).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>구글 편도 ↗`));
  assert.doesNotMatch(transfer, /구글 같은 편/);

  // 출처 링크가 없거나 이상하면 Aviasales 링크 없이 구글 같은 편만
  const noSource = context.legBookingLinksHtml({ ...TW106, sourceUrl: 'javascript:alert(1)' }, { fareSource: 'TRAVELPAYOUTS_PRICES', routeGoogleUrl: ROUTE_URL });
  assert.doesNotMatch(noSource, /Aviasales|javascript/);
  assert.match(noSource, />구글 같은 편 ↗</);

  // 2명 이상: Aviasales 는 1인 가격 그대로 열리고(인원은 그 화면에서), 구글은 그 인원 총액
  const party = context.legBookingLinksHtml(TW106, { fareSource: 'TRAVELPAYOUTS_PRICES', routeGoogleUrl: ROUTE_URL, party: { adults: 2, children: 1, infants: 0 } });
  assert.match(party, /title="[^"]*1인 기준[^"]*3명은 그 화면에서 인원을 바꾸세요[^"]*">가격 출처 Aviasales ↗/);
  assert.match(party, /title="[^"]*3명 총액[^"]*소아·유아 금액은 앱이 추정한 값[^"]*">구글 같은 편 ↗/);
  assert.equal(countOf(party, /tfs=/g), 1);
  assert.deepEqual(valuesOf(tfsFields(context.googleFlightBookingUrl(TW106, { adults: 2, children: 1, infants: 0 })), 8), [1, 1, 2]);
});

test('구글 플라이트 실시간 구간: 가격 출처는 구글 — 그 항공편 예약 화면, 경유 편이면 그 노선 검색 결과', () => {
  const { context } = loadClient();
  const live = { ...TW106, sourceUrl: undefined, fareSource: undefined, searchedOn: null };
  const html = context.legBookingLinksHtml(live, { fareSource: 'SERPAPI_GOOGLE_FLIGHTS', routeGoogleUrl: ROUTE_URL, party: { adults: 1 } });
  const google = context.googleFlightBookingUrl(live, { adults: 1 });
  assert.match(html, new RegExp(`href="${attr(google).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*data-source-link="google"[^>]*>가격 출처 구글 ↗</a>`));
  assert.equal(countOf(html, /<a /g), 1, '같은 곳을 두 번 걸지 않는다');
  assert.doesNotMatch(html, /Aviasales|구글 편도|같은 편/);
  assert.match(html, /title="[^"]*조회한 구글 플라이트[^"]*TW106 11\/12[^"]*예약 화면[^"]*"/);

  const transfer = context.legBookingLinksHtml({ ...live, stops: 1 }, { fareSource: 'SERPAPI_GOOGLE_FLIGHTS', routeGoogleUrl: ROUTE_URL });
  assert.match(transfer, new RegExp(`href="${attr(ROUTE_URL).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*data-source-link="google"[^>]*>가격 출처 구글 ↗`));
  assert.match(transfer, /title="[^"]*검색 결과에서 TW106[^"]*"/);
  // 노선 검색 주소도 없으면 아무 링크도 걸지 않는다
  assert.equal(context.legBookingLinksHtml({ ...live, stops: 1 }, { fareSource: 'SERPAPI_GOOGLE_FLIGHTS', routeGoogleUrl: 'javascript:alert(1)' }), '');
});

test('모의 가격 구간: 편명이 계산식이라 지금처럼 노선 검색(구글 편도)만 — 출처·같은 편 링크는 만들지 않는다', () => {
  const { context } = loadClient();
  const simulated = { ...TW106, fareSource: undefined, sourceUrl: 'https://www.aviasales.com/search/X?t=1' };
  for (const fareSource of [undefined, 'ONEWAY_COMBO_ENGINE', 'AMADEUS_TEST_ONEWAY_COMBO']) {
    const html = context.legBookingLinksHtml(simulated, { fareSource, routeGoogleUrl: ROUTE_URL, party: { adults: 1 } });
    assert.match(html, />구글 편도 ↗</, String(fareSource));
    assert.doesNotMatch(html, /data-source-link|data-same-flight-link|booking\?tfs|aviasales/, String(fareSource));
  }
});

test("'구글'이라고 적는 링크는 www.google.com/travel/flights 주소일 때만 건다 — 노선 검색 주소가 다른 곳이면 걸지 않는다", () => {
  const { context } = loadClient();
  for (const url of [
    'https://evil.example/travel/flights/search?tfs=A',
    'https://www.google.com@evil.example/travel/flights/search?tfs=A',
    'https://www.google.com.evil.example/travel/flights/search?tfs=A',
    'https://www.google.com/url?q=https://evil.example/travel/flights',
    'https://www.google.com/travel/flightsX?tfs=A'
  ]) {
    assert.equal(context.googleOneWayLinkHtml(url), '', url);
    // 실시간 경유 편(같은 편을 특정하지 못함)은 노선 검색으로 가는데, 그 주소가 구글이 아니면 아무 링크도 걸지 않는다
    assert.equal(context.legBookingLinksHtml({ ...TW106, stops: 1 }, { fareSource: 'SERPAPI_GOOGLE_FLIGHTS', routeGoogleUrl: url }), '', url);
    // 최근 검색가 경유 편은 Aviasales 출처만
    const cached = context.legBookingLinksHtml({ ...TW106, stops: 1 }, { fareSource: 'TRAVELPAYOUTS_PRICES', routeGoogleUrl: url });
    assert.match(cached, />가격 출처 Aviasales ↗</, url);
    assert.doesNotMatch(cached, /구글/, url);
  }
  for (const url of [ROUTE_URL, 'https://www.google.com/travel/flights?tfs=A', 'https://www.google.com/travel/flights/search?tfs=A']) {
    assert.match(context.googleOneWayLinkHtml(url), />구글 편도 ↗</, url);
  }
});

test('링크 글자·모양·data 값도 이스케이프한다 — 지금은 상수만 넘기지만 나중에 값이 들어와도 HTML 이 깨지지 않게', () => {
  const { context } = loadClient();
  const url = 'https://www.google.com/travel/flights/booking?tfs=A';
  const html = context.legLinkHtml(url, {
    label: '<img src=x onerror=alert(1)>',
    title: 'T',
    className: 'x" onmouseover="alert(1)',
    dataName: 'source-link',
    dataValue: 'g"><b>'
  });
  assert.doesNotMatch(html, /<img|<b>|" onmouseover=/);
  assert.match(html, /data-source-link="g&quot;&gt;&lt;b&gt;"/);
  assert.match(html, /class="whitespace-nowrap x&quot; onmouseover=&quot;alert\(1\)"/);
  assert.match(html, />&lt;img src=x onerror=alert\(1\)&gt;<\/a>$/);
  // data 이름이 이상하면 data 속성 없이 그린다
  const noData = context.legLinkHtml(url, { label: 'L', title: 'T', className: 'c', dataName: 'x" onclick="y', dataValue: 'v' });
  assert.doesNotMatch(noData, /onclick="y|data-/);
});

test('어떤 링크를 붙일지는 그 카드·알림의 출처로 정한다 — 구간에 적힌 출처 칸은 쓰지 않는다', () => {
  const { context } = loadClient();
  const cached = context.legBookingLinksHtml({ ...TW106, fareSource: 'SERPAPI_GOOGLE_FLIGHTS' }, { fareSource: 'TRAVELPAYOUTS_PRICES', routeGoogleUrl: ROUTE_URL });
  assert.match(cached, />가격 출처 Aviasales ↗</);
  assert.doesNotMatch(cached, /가격 출처 구글/);
  // 카드의 출처를 모르면 모의 가격처럼 노선 검색만 (구간 칸에 실시간이라고 적혀 있어도)
  const unknown = context.legBookingLinksHtml({ ...TW106, fareSource: 'SERPAPI_GOOGLE_FLIGHTS' }, { routeGoogleUrl: ROUTE_URL });
  assert.match(unknown, />구글 편도 ↗</);
  assert.doesNotMatch(unknown, /data-source-link|data-same-flight-link/);
});

test('링크 인원은 엔진과 같은 범위 — 무릎 유아는 성인 수까지, 한 종류 9명까지, 설명의 총원도 링크가 실제로 연 인원', () => {
  const { context } = loadClient();
  const pax = (party) => valuesOf(tfsFields(context.googleFlightBookingUrl(TW106, party)), 8);
  assert.deepEqual(pax({ adults: 1, infants: 3 }), [1, 3], '성인 1 + 무릎 유아 1');
  assert.deepEqual(pax({ adults: 12 }), Array(9).fill(1), '성인 9명까지');
  assert.deepEqual(pax({ adults: 0 }), [1], '성인은 1명 이상');
  const html = context.legBookingLinksHtml(TW106, { fareSource: 'TRAVELPAYOUTS_PRICES', routeGoogleUrl: ROUTE_URL, party: { adults: 1, infants: 3 } });
  assert.match(html, /title="[^"]*2명 총액[^"]*">구글 같은 편 ↗/, '설명도 링크가 연 2명');
  assert.match(html, /2명은 그 화면에서 인원을 바꾸세요/);
});

test('외부에서 온 글자는 링크 설명에 그대로 들어가지 않는다', () => {
  const { context } = loadClient();
  const html = context.legBookingLinksHtml(
    { ...TW106, flightNumber: '"><img src=x onerror=alert(1)>', airlineCode: 'TW' },
    { fareSource: 'TRAVELPAYOUTS_PRICES', routeGoogleUrl: ROUTE_URL }
  );
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&quot;&gt;&lt;img/);
  assert.match(html, />구글 편도 ↗</, '편명이 이상하면 같은 편 링크 대신 노선 검색');
});
