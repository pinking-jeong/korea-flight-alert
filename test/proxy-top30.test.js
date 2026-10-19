/**
 * 실제 운임(Travelpayouts) TOP 30
 * 1단계: 한국 공항별·달별 '여기서 가장 싼 도착지' 목록 → 2단계: 싼 도착지만 날짜별 운임으로 체류 기간에 맞는 왕복 짝
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { composeAnywhereTop30, STAY_NIGHTS_BY_REGION } = require('../proxy/lib/top30');

const TODAY = '2026-10-19';

function t(originAirport, destinationAirport, date, priceKrw, extra = {}) {
  return {
    originAirport,
    destinationAirport,
    originCity: '',
    destinationCity: '',
    date,
    departureTime: '09:00',
    priceKrw,
    airlineCode: '7C',
    flightNumber: '7C1101',
    transfers: 0,
    durationMinutes: 140,
    sourceUrl: null,
    ...extra
  };
}

function fakeTp(table) {
  const calls = [];
  return {
    calls,
    async fetchTickets({ origin, destination = '', month, direct, unique }) {
      calls.push({ origin, destination, month, direct, unique });
      const rows = table[`${origin}>${destination || '*'}|${month}`];
      if (rows === 'FAIL') throw Object.assign(new Error('boom'), { code: 'TP_ERROR' });
      return { value: rows || [], cached: false, storedAt: Date.parse('2026-10-19T02:00:00Z') };
    },
    async resolveAirlineNames(codes) {
      return new Map(codes.map((c) => [c, { '7C': '제주항공', LJ: '진에어' }[c] || c]));
    }
  };
}

const TABLE = {
  // 1단계: 인천에서 11월에 가장 싼 도착지들 (도쿄 나리타·오사카·방콕·파리, 국내선 제주는 목록에 없어 무시)
  'ICN>*|2026-11': [
    t('ICN', 'NRT', '2026-11-10', 90000),
    t('ICN', 'KIX', '2026-11-12', 80000),
    t('ICN', 'BKK', '2026-11-05', 150000),
    t('ICN', 'CDG', '2026-11-15', 450000),
    t('ICN', 'CJU', '2026-11-01', 20000)
  ],
  // 2단계: 날짜별 운임
  'ICN>NRT|2026-11': [t('ICN', 'NRT', '2026-11-10', 90000), t('ICN', 'NRT', '2026-11-11', 95000)],
  'NRT>ICN|2026-11': [t('NRT', 'ICN', '2026-11-13', 100000), t('NRT', 'ICN', '2026-11-25', 50000)],
  'ICN>KIX|2026-11': [t('ICN', 'KIX', '2026-11-12', 80000, { airlineCode: 'LJ', flightNumber: 'LJ221' })],
  'KIX>ICN|2026-11': [t('KIX', 'ICN', '2026-11-14', 70000)],
  'ICN>BKK|2026-11': [t('ICN', 'BKK', '2026-11-05', 150000)],
  'BKK>ICN|2026-11': [t('BKK', 'ICN', '2026-11-20', 90000)] // 15박 → 동남아 체류 범위(3~6박) 밖
};

test('지역 필터·체류 기간에 맞는 날짜 짝으로 순위를 매기고, 화면이 쓰는 TOP 30 모양으로 돌려준다', async () => {
  const tp = fakeTp(TABLE);
  const result = await composeAnywhereTop30(tp, {
    origin: 'ICN',
    region: '일본',
    directOnly: true,
    adults: 2,
    children: 1,
    infants: 0,
    today: TODAY
  });

  assert.equal(result.fareSource, 'TRAVELPAYOUTS_PRICES');
  assert.equal(result.realFare, true);
  assert.equal(result.fetchedAt, '2026-10-19T02:00:00.000Z');
  assert.deepEqual(result.top30Deals.map((d) => [d.rank, d.destination, d.combinedAdultPriceKrw]), [
    [1, 'KIX', 150000],
    [2, 'NRT', 190000]
  ]);
  const kix = result.top30Deals[0];
  assert.equal(kix.departureDate, '2026-11-12');
  assert.equal(kix.returnDate, '2026-11-14');
  assert.equal(kix.stayNights, 2);
  assert.equal(kix.stayLabel, '2박 3일');
  assert.equal(kix.monthLabel, '2026년 11월');
  assert.equal(kix.departureDayOfWeekKo, '목');
  assert.equal(kix.outboundLeg.airline, '진에어');
  assert.equal(kix.outboundLeg.fareSource, 'TRAVELPAYOUTS_PRICES');
  assert.equal(kix.destinationCity, '오사카 (간사이)');
  assert.equal(kix.region, '일본');
  assert.equal(kix.totalPassengersPriceKrw, 150000 * 2 + 120000);
  assert.match(kix.bookingLinks.googleFlightsUrl, /^https:\/\/www\.google\.com\/travel\/flights\/search\?tfs=/);
  assert.equal(kix.outboundLeg.naverOneWayUrl, kix.bookingLinks.outboundNaverUrl);
  // 모의 2년 기준값과 비교하지 않는다
  assert.equal(kix.discountVs2YAvgPercent, null);
  assert.equal(kix.avg2YKrw, null);
  assert.equal(kix.isNearHistoricLow, false);
  assert.equal(result.tiers.top10.items.length, 2);
  assert.ok(tp.calls.every((c) => c.direct === true));
  // 1단계는 도착지 없이 고유 도착지(unique) 목록, 2단계는 노선별
  assert.ok(tp.calls.some((c) => c.destination === '' && c.unique === true));
});

test('체류 범위 밖 날짜만 있으면 그 도착지는 빠지고, 기간 밖(내일 이전·180일 뒤) 날짜는 쓰지 않는다', async () => {
  const tp = fakeTp(TABLE);
  const result = await composeAnywhereTop30(tp, { origin: 'ICN', region: '동남아', directOnly: false, today: TODAY });
  assert.deepEqual(result.top30Deals, [], '방콕은 15박 귀국편만 있어 짝이 없다');
  assert.deepEqual(STAY_NIGHTS_BY_REGION['동남아'], [3, 6]);

  const late = fakeTp({
    'ICN>*|2026-10': [t('ICN', 'NRT', '2026-10-19', 10000)],
    'ICN>NRT|2026-10': [t('ICN', 'NRT', '2026-10-19', 10000)],
    'NRT>ICN|2026-10': [t('NRT', 'ICN', '2026-10-22', 10000)]
  });
  const none = await composeAnywhereTop30(late, { origin: 'ICN', region: 'ALL', directOnly: false, today: TODAY });
  assert.deepEqual(none.top30Deals, [], '오늘 출발은 쓰지 않는다');
});

test('전국 통합은 공항별 1단계 목록을 합쳐 도착지마다 가장 싼 한국 공항을 고르고, 한 갈래가 실패해도 나머지로 계산한다', async () => {
  const tp = fakeTp({
    ...TABLE,
    'PUS>*|2026-11': [t('PUS', 'KIX', '2026-11-12', 60000)],
    'PUS>KIX|2026-11': [t('PUS', 'KIX', '2026-11-12', 60000)],
    'KIX>PUS|2026-11': [t('KIX', 'PUS', '2026-11-15', 65000)],
    'GMP>*|2026-11': 'FAIL'
  });
  const result = await composeAnywhereTop30(tp, { origin: 'ALL_KOREA', region: '일본', directOnly: false, today: TODAY });
  const kix = result.top30Deals.find((d) => d.destination === 'KIX');
  assert.equal(kix.origin, 'PUS');
  assert.equal(kix.requestedOrigin, 'ALL_KOREA');
  assert.equal(kix.combinedAdultPriceKrw, 125000);
  assert.equal(result.partial, true);
  assert.equal(result.origin, 'ALL_KOREA');
});

test('전국 통합: 가는 편이 가장 싼 공항에 돌아오는 편이 없으면 다음으로 싼 공항으로 짝을 찾는다 (도착지를 빠뜨리지 않음)', async () => {
  const tp = fakeTp({
    ...TABLE,
    // 김해 → 오사카가 가장 싸지만 오사카 → 김해 편이 없다 → 인천(1단계 80,000원)으로 짝을 찾는다
    'PUS>*|2026-11': [t('PUS', 'KIX', '2026-11-12', 60000)],
    'PUS>KIX|2026-11': [t('PUS', 'KIX', '2026-11-12', 60000)]
  });
  const result = await composeAnywhereTop30(tp, { origin: 'ALL_KOREA', region: '일본', directOnly: false, today: TODAY });
  const kix = result.top30Deals.find((d) => d.destination === 'KIX');
  assert.ok(kix, '오사카가 빠지지 않는다');
  assert.equal(kix.origin, 'ICN');
  assert.equal(kix.combinedAdultPriceKrw, 150000);
});

test('시간 예산이 지난 요청은 Travelpayouts 를 더 부르지 않고 TP_TIME_BUDGET 오류로 끝낸다', async () => {
  const tp = fakeTp(TABLE);
  await assert.rejects(
    composeAnywhereTop30(tp, { origin: 'ICN', region: 'ALL', directOnly: false, today: TODAY, deadline: Date.now() - 1 }),
    (err) => err.code === 'TP_TIME_BUDGET'
  );
  assert.equal(tp.calls.length, 0);
});

test('2단계 운임 달력이 모두 실패하면 0건이 아니라 오류로 알린다 (화면이 이유를 보이고 모의 가격으로 넘어가게)', async () => {
  const base = fakeTp(TABLE);
  const tp = {
    ...base,
    async fetchTickets(args) {
      if (args.destination) throw Object.assign(new Error('rate'), { code: 'TP_RATE_LIMIT' });
      return base.fetchTickets(args);
    }
  };
  await assert.rejects(
    composeAnywhereTop30(tp, { origin: 'ICN', region: 'ALL', directOnly: false, today: TODAY }),
    (err) => err.code === 'TP_RATE_LIMIT'
  );
});
