/**
 * 예약 링크가 앱이 보여 주는 조건(노선·날짜·성인/아동/유아 인원·직항)을 그대로 넘기는지 확인한다.
 * 기대값은 2026-10-19 실제 사이트(google.com/travel/flights · kr.trip.com · kayak.co.kr · flight.naver.com)를
 * 브라우저로 열어 검색창에 같은 조건이 채워지는 것을 확인한 형식이다.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildBookingLinks, calculatePassengerPricing } = require('../src/config/airports');

// 부산 → 오사카(간사이), 성인 2 · 아동 1 · 유아 1, 직항만
const FAMILY_NONSTOP = {
  origin: 'PUS',
  destination: 'KIX',
  departureDate: '2026-12-02',
  returnDate: '2026-12-06',
  adults: 2,
  children: 1,
  infants: 1,
  directOnly: true
};

// 인천 → 방콕, 성인 2, 경유 포함
const COUPLE_ANY_STOPS = {
  origin: 'ICN',
  destination: 'BKK',
  departureDate: '2026-11-25',
  returnDate: '2026-11-30',
  adults: 2,
  children: 0,
  infants: 0,
  directOnly: false
};

test('구글 플라이트 링크가 인원(성인·아동·무릎 유아)과 직항 조건을 담는다', () => {
  const family = buildBookingLinks(FAMILY_NONSTOP);
  // 페이지에서 '승객 4명'(좌석 미지정 유아 1) · '직항' · 왕복 12/2–12/6 으로 열린 URL
  assert.equal(
    family.googleFlightsUrl,
    'https://www.google.com/travel/flights/search?tfs=CBwQAhogEgoyMDI2LTEyLTAyKABqBwgBEgNQVVNyBwgBEgNLSVgaIBIKMjAyNi0xMi0wNigAagcIARIDS0lYcgcIARIDUFVTQAFAAUACQANIAXABggELCP___________wGYAQE&hl=ko&curr=KRW'
  );
  // 오는 편 편도(KIX → PUS, 12/6): '승객 4명' · '직항' · 편도
  assert.equal(
    family.inboundGoogleFlightsUrl,
    'https://www.google.com/travel/flights/search?tfs=CBwQAhogEgoyMDI2LTEyLTA2KABqBwgBEgNLSVhyBwgBEgNQVVNAAUABQAJAA0gBcAGCAQsI____________AZgBAg&hl=ko&curr=KRW'
  );

  // 경유 포함이면 경유 조건을 넣지 않음: '승객 2명' · 경유 필터 없음 · 왕복 11/25–11/30
  assert.equal(
    buildBookingLinks(COUPLE_ANY_STOPS).googleFlightsUrl,
    'https://www.google.com/travel/flights/search?tfs=CBwQAhoeEgoyMDI2LTExLTI1agcIARIDSUNOcgcIARIDQktLGh4SCjIwMjYtMTEtMzBqBwgBEgNCS0tyBwgBEgNJQ05AAUABSAFwAYIBCwj___________8BmAEB&hl=ko&curr=KRW'
  );
});

test('트립닷컴 링크는 도시 코드와 공항 코드를 나눠 넘기고 인원·직항 조건을 담는다', () => {
  const url = new URL(buildBookingLinks(FAMILY_NONSTOP).tripComUrl);
  const params = Object.fromEntries(url.searchParams);
  assert.equal(params.dcity, 'PUS');
  assert.equal(params.acity, 'OSA');
  assert.equal(params.dairport, 'PUS');
  assert.equal(params.aairport, 'KIX');
  assert.equal(params.ddate, '2026-12-02');
  assert.equal(params.rdate, '2026-12-06');
  assert.equal(params.flighttype, 'rt');
  assert.equal(params.quantity, '2');
  assert.equal(params.childqty, '1');
  assert.equal(params.babyqty, '1');
  assert.equal(params.nonstoponly, 'on');

  assert.equal(new URL(buildBookingLinks(COUPLE_ANY_STOPS).tripComUrl).searchParams.has('nonstoponly'), false);
});

test('트립닷컴은 공항 코드로 열리지 않는 나트랑·울란바토르에 도시 코드를 쓴다', () => {
  const base = { origin: 'ICN', departureDate: '2026-11-25', returnDate: '2026-11-29', adults: 1 };
  assert.equal(new URL(buildBookingLinks({ ...base, destination: 'CXR' }).tripComUrl).searchParams.get('acity'), 'NHA');
  assert.equal(new URL(buildBookingLinks({ ...base, destination: 'UBN' }).tripComUrl).searchParams.get('acity'), 'ULN');
  // 타이중은 공항 코드(RMQ)로 열리고 도시 코드(TXG)로는 빈칸이 된다
  assert.equal(new URL(buildBookingLinks({ ...base, destination: 'RMQ' }).tripComUrl).searchParams.get('acity'), 'RMQ');
});

test('카약 링크는 아동·무릎 유아와 직항 필터를 담는다', () => {
  assert.equal(
    buildBookingLinks(FAMILY_NONSTOP).kayakUrl,
    'https://www.kayak.co.kr/flights/PUS-KIX/2026-12-02/2026-12-06/2adults/children-11-1L?fs=stops=0'
  );
  assert.equal(
    buildBookingLinks(COUPLE_ANY_STOPS).kayakUrl,
    'https://www.kayak.co.kr/flights/ICN-BKK/2026-11-25/2026-11-30/2adults'
  );
});

test('비정상적으로 큰 인원 수는 종류별 9명으로 줄여 링크·요금 계산이 커지지 않는다', () => {
  const huge = { ...COUPLE_ANY_STOPS, adults: 60000, children: 60000, infants: 60000 };
  const links = buildBookingLinks(huge);
  const { adults, children, infants } = links.bookingMeta;
  assert.deepEqual([adults, children, infants], [9, 9, 9]);
  assert.ok(links.googleFlightsUrl.length < 300, `URL 길이 ${links.googleFlightsUrl.length}`);

  const pricing = calculatePassengerPricing(100000, huge);
  assert.deepEqual([pricing.adults, pricing.children, pricing.infants], [9, 9, 9]);
});

test('네이버 항공권 링크는 왕복·편도 모두 인원과 직항 조건을 담는다', () => {
  const links = buildBookingLinks(FAMILY_NONSTOP);
  const query = 'adult=2&child=1&infant=1&isDirect=true&fareType=Y';
  assert.equal(links.naverUrl, `https://flight.naver.com/flights/international/PUS-KIX-20261202/KIX-PUS-20261206?${query}`);
  assert.equal(links.outboundNaverUrl, `https://flight.naver.com/flights/international/PUS-KIX-20261202?${query}`);
  assert.equal(links.inboundNaverUrl, `https://flight.naver.com/flights/international/KIX-PUS-20261206?${query}`);
});
