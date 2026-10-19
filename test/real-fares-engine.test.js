/**
 * 실제 운임 입력 경로 (엔진)
 * - externalCandidates: 프록시가 받아 온 실제 편도 운임(구글 플라이트·Travelpayouts)을 규칙 조회에 쓴다
 * - fareQuote: 귀국일표·추천 일정·가격 추이가 계산식 대신 실제 운임 캘린더를 쓴다 (값이 없는 날은 건너뜀)
 * - 출처 3종: 모의(계산식) · 실시간(구글 플라이트) · 검색 캐시(Travelpayouts, 최근 이용자 검색에서 나온 가격)
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  LIVE_FARE_SOURCE_APIS,
  CACHED_FARE_SOURCE_APIS,
  isSimulatedFareSource,
  describeFareSource,
  fetchLowestRoundTripPrice,
  getReturnDatePriceMatrix,
  getRecommendedCheapSchedules,
  getRoutePriceTrend,
  getAnywhereTop10Next6Months,
  buildAnywhereTop30Response
} = require('../src/services/flightApiService');

function futureDate(days) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const DEP = futureDate(40);
const RET = futureDate(43);

function leg({ code = 'QW', airline = '칭다오항공', no = '9902', from = 'ICN', to = 'TAO', date = DEP, price, time = '23:30 → 00:20(+1)' }) {
  return {
    airline,
    airlineCode: code,
    flightNumber: `${code}${no}`,
    fromAirportCode: from,
    toAirportCode: to,
    date,
    departureTime: time.slice(0, 5),
    arrivalTime: time.slice(8, 13),
    scheduleTime: time,
    stops: 0,
    oneWayPriceKrw: price
  };
}

const RULE = {
  origin: 'ICN',
  destination: 'TAO',
  departureDate: DEP,
  returnDate: RET,
  adults: 2,
  children: 1,
  infants: 0,
  directOnly: true,
  targetPrice: 200000
};

test('출처 3종: 구글 플라이트(SerpApi)는 실시간, Travelpayouts 는 검색 캐시, 나머지는 모의', () => {
  assert.ok(LIVE_FARE_SOURCE_APIS.includes('SERPAPI_GOOGLE_FLIGHTS'));
  assert.ok(CACHED_FARE_SOURCE_APIS.includes('TRAVELPAYOUTS_PRICES'));
  assert.equal(describeFareSource('SERPAPI_GOOGLE_FLIGHTS'), 'LIVE');
  assert.equal(describeFareSource('AMADEUS_ONEWAY_COMBO'), 'LIVE');
  assert.equal(describeFareSource('TRAVELPAYOUTS_PRICES'), 'CACHED');
  assert.equal(describeFareSource('ONEWAY_COMBO_ENGINE'), 'SIMULATED');
  assert.equal(describeFareSource('AMADEUS_TEST_ONEWAY_COMBO'), 'SIMULATED');
  assert.equal(describeFareSource(undefined), 'SIMULATED');
  assert.equal(isSimulatedFareSource('SERPAPI_GOOGLE_FLIGHTS'), false);
  assert.equal(isSimulatedFareSource('TRAVELPAYOUTS_PRICES'), false);
  assert.equal(isSimulatedFareSource('ONEWAY_COMBO_ENGINE'), true);
});

test('외부 실제 운임으로 규칙을 조회하면 그 값을 그대로 쓰고 출처·조회 시각을 남긴다 (계산식 할증 없음)', async () => {
  const fetchedAt = '2026-10-19T03:00:00.000Z';
  const { usedProvider, offer } = await fetchLowestRoundTripPrice(RULE, {}, {
    externalCandidates: {
      sourceApi: 'SERPAPI_GOOGLE_FLIGHTS',
      fetchedAt,
      outbound: [leg({ price: 98000 }), leg({ code: 'KE', airline: '대한항공', no: '845', price: 152000, time: '08:30 → 09:20' })],
      inbound: [
        leg({ from: 'TAO', to: 'ICN', date: RET, price: 105000, no: '9901', time: '01:20 → 03:55' }),
        leg({ code: 'KE', airline: '대한항공', no: '846', from: 'TAO', to: 'ICN', date: RET, price: 160000, time: '10:30 → 13:05' })
      ]
    }
  });
  assert.equal(usedProvider, 'SERPAPI');
  assert.equal(offer.sourceApi, 'SERPAPI_GOOGLE_FLIGHTS');
  assert.equal(offer.fareFetchedAt, fetchedAt);
  assert.equal(offer.priceKrw, 203000);
  assert.equal(offer.outboundLeg.flightNumber, 'QW9902');
  assert.equal(offer.inboundLeg.flightNumber, 'QW9901');
  assert.equal(offer.outboundLeg.scheduleTime, '23:30 → 00:20(+1)');
  assert.equal(offer.outboundLeg.baggageInfo, '운임 규정 확인');
  assert.equal(offer.sameAirlineBundledPriceKrw, 203000, '같은 항공사 편도 두 장 합계 (1.04 할증 없음)');
  assert.equal(offer.mixMatchSavingsKrw, 0);
  assert.equal(offer.isDifferentAirlineCombo, false);
  // 인원 합계는 성인 1인 실제 운임에 기존 소아(80%) 비율을 적용한 추정이다
  assert.equal(offer.totalPriceKrw, 203000 * 2 + Math.round((203000 * 0.8) / 100) * 100);
  assert.equal(offer.bookingLinks.bookingMeta.originCode, 'ICN');
  assert.equal(offer.outboundCandidates.length, 2);
});

test('다른 항공사 조합이 더 싸면 절약액은 같은 항공사 편도 두 장 최저 합계와의 차이다', async () => {
  const { offer } = await fetchLowestRoundTripPrice(RULE, {}, {
    externalCandidates: {
      sourceApi: 'SERPAPI_GOOGLE_FLIGHTS',
      fetchedAt: '2026-10-19T03:00:00.000Z',
      outbound: [leg({ price: 98000 }), leg({ code: 'KE', airline: '대한항공', no: '845', price: 152000 })],
      inbound: [
        leg({ code: 'KE', airline: '대한항공', no: '846', from: 'TAO', to: 'ICN', date: RET, price: 100000 }),
        leg({ from: 'TAO', to: 'ICN', date: RET, price: 130000, no: '9901' })
      ]
    }
  });
  assert.equal(offer.priceKrw, 198000);
  assert.equal(offer.isDifferentAirlineCombo, true);
  assert.equal(offer.sameAirlineBundledPriceKrw, 228000);
  assert.equal(offer.mixMatchSavingsKrw, 30000);
});

test('같은 항공사 짝이 없으면 묶음가는 비워 두고 절약액은 0', async () => {
  const { offer } = await fetchLowestRoundTripPrice(RULE, {}, {
    externalCandidates: {
      sourceApi: 'TRAVELPAYOUTS_PRICES',
      fetchedAt: '2026-10-19T03:00:00.000Z',
      outbound: [leg({ price: 98000 })],
      inbound: [leg({ code: 'KE', airline: '대한항공', no: '846', from: 'TAO', to: 'ICN', date: RET, price: 100000 })]
    }
  });
  assert.equal(offer.sourceApi, 'TRAVELPAYOUTS_PRICES');
  assert.equal(offer.sameAirlineBundledPriceKrw, null);
  assert.equal(offer.mixMatchSavingsKrw, 0);
});

test('전국 통합(ALL_KOREA)은 같은 한국 공항으로 오가는 짝 중 합계가 가장 싼 것을 고른다', async () => {
  const { offer } = await fetchLowestRoundTripPrice({ ...RULE, origin: 'ALL_KOREA' }, {}, {
    externalCandidates: {
      sourceApi: 'SERPAPI_GOOGLE_FLIGHTS',
      fetchedAt: '2026-10-19T03:00:00.000Z',
      outbound: [leg({ from: 'PUS', price: 90000 }), leg({ from: 'ICN', price: 120000 })],
      inbound: [
        leg({ from: 'TAO', to: 'ICN', date: RET, price: 80000 }),
        leg({ from: 'TAO', to: 'PUS', date: RET, price: 130000 })
      ]
    }
  });
  assert.equal(offer.origin, 'ICN', '가는 편만 싼 김해가 아니라 왕복 합계가 싼 인천');
  assert.equal(offer.priceKrw, 200000);
  assert.equal(offer.outboundLeg.fromAirportCode, 'ICN');
  assert.equal(offer.inboundLeg.toAirportCode, 'ICN');
  assert.equal(offer.outboundLeg.originAirportCity, '서울/인천');
});

test('브라우저가 보낸 후보는 검증한다: 날짜·공항·가격이 맞지 않는 항목은 버리고, 남는 게 없으면 오류', async () => {
  const bad = [
    leg({ price: -1 }),
    leg({ price: 'abc' }),
    leg({ price: 98000, date: futureDate(41) }),
    leg({ price: 98000, from: 'GMP' }),
    leg({ price: 98000, to: 'NRT' }),
    { ...leg({ price: 98000 }), airline: '<img src=x onerror=alert(1)>'.repeat(20) }
  ];
  const { offer } = await fetchLowestRoundTripPrice(RULE, {}, {
    externalCandidates: {
      sourceApi: 'SERPAPI_GOOGLE_FLIGHTS',
      fetchedAt: '2026-10-19T03:00:00.000Z',
      outbound: bad,
      inbound: [leg({ from: 'TAO', to: 'ICN', date: RET, price: 100000 })]
    }
  });
  // 남는 것은 마지막(이름이 너무 긴) 항목뿐이고, 이름은 잘라서 쓴다
  assert.equal(offer.outboundCandidates.length, 1);
  assert.ok(offer.outboundLeg.airline.length <= 40);

  await assert.rejects(
    fetchLowestRoundTripPrice(RULE, {}, {
      externalCandidates: { sourceApi: 'SERPAPI_GOOGLE_FLIGHTS', fetchedAt: 'x', outbound: bad.slice(0, 5), inbound: [] }
    }),
    (err) => err.code === 'NO_REAL_FARES'
  );
  await assert.rejects(
    fetchLowestRoundTripPrice(RULE, {}, {
      externalCandidates: { sourceApi: 'MADE_UP', outbound: [leg({ price: 1 })], inbound: [leg({ price: 1 })] }
    }),
    (err) => err.code === 'BAD_FARE_SOURCE'
  );
});

test("'급락 시뮬레이션'(forceTargetHit)은 외부 운임이 와도 계산식으로만 동작한다", async () => {
  const { usedProvider, offer } = await fetchLowestRoundTripPrice(RULE, {}, {
    forceTargetHit: true,
    externalCandidates: {
      sourceApi: 'SERPAPI_GOOGLE_FLIGHTS',
      fetchedAt: '2026-10-19T03:00:00.000Z',
      outbound: [leg({ price: 98000 })],
      inbound: [leg({ from: 'TAO', to: 'ICN', date: RET, price: 100000 })]
    }
  });
  assert.equal(usedProvider, 'SIMULATION');
  assert.equal(offer.sourceApi, 'ONEWAY_COMBO_ENGINE');
});

// 날짜별 최저 운임 캘린더를 흉내 내는 견적 함수 (값이 없는 날은 빈 목록)
function calendarQuote(table) {
  return ({ origin, dateStr, direction }) => {
    const row = table[`${direction}|${dateStr}`];
    if (!row) return [];
    const korean = row.korean || (origin === 'ALL_KOREA' ? 'ICN' : origin);
    if (origin !== 'ALL_KOREA' && korean !== origin) return [];
    return [
      {
        direction,
        originAirportCode: korean,
        originAirportCity: korean,
        fromAirportCode: direction === 'OUTBOUND' ? korean : 'TAO',
        toAirportCode: direction === 'OUTBOUND' ? 'TAO' : korean,
        date: dateStr,
        dayOfWeekKo: '',
        airline: row.airline || '칭다오항공',
        airlineCode: row.code || 'QW',
        flightNumber: `${row.code || 'QW'}1`,
        baggageInfo: '운임 규정 확인',
        scheduleTime: '10:00 → 11:00',
        oneWayPriceKrw: row.price,
        fareSource: 'TRAVELPAYOUTS_PRICES'
      }
    ];
  };
}

test('귀국일표는 실제 운임 캘린더에 값이 있는 귀국일만 보여 주고, 가는 편 값이 없으면 빈 표', () => {
  const quote = calendarQuote({
    [`OUTBOUND|${DEP}`]: { price: 90000 },
    [`INBOUND|${addDays(DEP, 1)}`]: { price: 120000 },
    [`INBOUND|${addDays(DEP, 3)}`]: { price: 70000 }
  });
  const matrix = getReturnDatePriceMatrix({ origin: 'ICN', destination: 'TAO', departureDate: DEP, maxStayDays: 5, fareQuote: quote });
  assert.deepEqual(matrix.returnOptions.map((o) => o.stayNights), [1, 3]);
  assert.equal(matrix.cheapestOption.stayNights, 3);
  assert.equal(matrix.cheapestOption.combinedAdultPriceKrw, 160000);
  assert.equal(matrix.outboundLeg.oneWayPriceKrw, 90000);

  const empty = getReturnDatePriceMatrix({ origin: 'ICN', destination: 'TAO', departureDate: DEP, fareQuote: calendarQuote({}) });
  assert.equal(empty.outboundLeg, null);
  assert.deepEqual(empty.returnOptions, []);
  assert.equal(empty.cheapestOption, null);
});

test('추천 일정·가격 추이도 캘린더에 값이 있는 날짜 조합만 쓴다', () => {
  const today = new Date().toISOString().slice(0, 10);
  const d9 = addDays(today, 9);
  const table = {
    [`OUTBOUND|${d9}`]: { price: 50000 },
    [`INBOUND|${addDays(d9, 3)}`]: { price: 60000 },
    [`INBOUND|${addDays(d9, 4)}`]: { price: 40000 }
  };
  const rec = getRecommendedCheapSchedules({ origin: 'ICN', destination: 'TAO', minNights: 2, maxNights: 5, fareQuote: calendarQuote(table) });
  assert.equal(rec.recommendations.length, 1, '출발일당 한 개');
  assert.equal(rec.recommendations[0].departureDate, d9);
  assert.equal(rec.recommendations[0].stayNights, 4);
  assert.equal(rec.recommendations[0].combinedAdultPriceKrw, 90000);

  const trend = getRoutePriceTrend({
    origin: 'ICN',
    destination: 'TAO',
    departureDate: d9,
    returnDate: addDays(d9, 3),
    fareQuote: calendarQuote(table)
  });
  assert.equal(trend.points.length, 1);
  assert.equal(trend.points[0].combinedAdultPriceKrw, 110000);
  assert.equal(trend.selectedPoint.departureDate, d9);
  assert.equal(trend.cheapestPoint.combinedAdultPriceKrw, 110000);
});

// 공항별 운임 캘린더 (전국 통합 시험용): table[`방향|날짜`] = [{ korean, price }, ...] → 가격순 후보
function multiAirportQuote(table) {
  return ({ origin, dateStr, direction }) =>
    (table[`${direction}|${dateStr}`] || [])
      .filter((row) => origin === 'ALL_KOREA' || row.korean === origin)
      .sort((a, b) => a.price - b.price)
      .map((row) => ({
        direction,
        originAirportCode: row.korean,
        originAirportCity: row.korean,
        fromAirportCode: direction === 'OUTBOUND' ? row.korean : 'TAO',
        toAirportCode: direction === 'OUTBOUND' ? 'TAO' : row.korean,
        date: dateStr,
        dayOfWeekKo: '',
        airline: '칭다오항공',
        airlineCode: 'QW',
        flightNumber: 'QW1',
        baggageInfo: '운임 규정 확인',
        scheduleTime: '10:00 → 11:00',
        oneWayPriceKrw: row.price,
        fareSource: 'TRAVELPAYOUTS_PRICES'
      }));
}

test('전국 통합(ALL_KOREA) 실제 운임: 귀국일표·추천·추이는 칸마다 같은 공항 왕복 합계가 가장 싼 짝을 고른다', () => {
  const today = new Date().toISOString().slice(0, 10);
  const dep = addDays(today, 9);
  // 가는 편은 김해가 싸지만 김해로 돌아오는 편은 비싸거나 없다 → 인천 왕복이 더 싸다
  const quote = multiAirportQuote({
    [`OUTBOUND|${dep}`]: [{ korean: 'PUS', price: 90000 }, { korean: 'ICN', price: 100000 }],
    [`INBOUND|${addDays(dep, 3)}`]: [{ korean: 'ICN', price: 100000 }, { korean: 'PUS', price: 300000 }],
    [`INBOUND|${addDays(dep, 4)}`]: [{ korean: 'ICN', price: 110000 }]
  });

  const matrix = getReturnDatePriceMatrix({ origin: 'ALL_KOREA', destination: 'TAO', departureDate: dep, maxStayDays: 5, fareQuote: quote });
  assert.deepEqual(
    matrix.returnOptions.map((o) => [o.stayNights, o.origin, o.combinedAdultPriceKrw]),
    [[3, 'ICN', 200000], [4, 'ICN', 210000]]
  );
  assert.equal(matrix.returnOptions[0].outboundLeg.originAirportCode, 'ICN', '칸마다 그 공항의 가는 편');
  assert.equal(matrix.cheapestOption.combinedAdultPriceKrw, 200000);
  assert.equal(matrix.origin, 'ICN', '맨 위 가는 편은 가장 싼 칸의 공항');
  assert.equal(matrix.outboundLeg.oneWayPriceKrw, 100000);

  const rec = getRecommendedCheapSchedules({ origin: 'ALL_KOREA', destination: 'TAO', minNights: 2, maxNights: 5, fareQuote: quote });
  assert.equal(rec.recommendations[0].origin, 'ICN');
  assert.equal(rec.recommendations[0].combinedAdultPriceKrw, 200000);

  const trend = getRoutePriceTrend({ origin: 'ALL_KOREA', destination: 'TAO', departureDate: dep, returnDate: addDays(dep, 4), fareQuote: quote });
  const point = trend.points.find((p) => p.departureDate === dep);
  assert.ok(point, '김해로 돌아오는 편이 없어도 인천 왕복 점을 찍는다');
  assert.equal(point.origin, 'ICN');
  assert.equal(point.combinedAdultPriceKrw, 210000);
});

test('TOP 30 순위·3단 묶음은 공용 함수로 만들고, 모의 TOP 30 도 같은 함수를 쓴다', () => {
  const sim = getAnywhereTop10Next6Months({ origin: 'ICN', region: '일본' });
  const rebuilt = buildAnywhereTop30Response({
    pool: sim.top30Deals.map(({ rank, tierGroup, ...rest }) => rest),
    sortBy: sim.sortBy,
    origin: sim.origin,
    originCity: sim.originCity,
    region: sim.region,
    scannedCitiesCount: sim.scannedCitiesCount,
    horizonDays: sim.horizonDays,
    limit: 30
  });
  assert.deepEqual(rebuilt.top30Deals.map((d) => d.rank), sim.top30Deals.map((d) => d.rank));
  assert.deepEqual(
    rebuilt.top30Deals.map((d) => d.combinedAdultPriceKrw),
    sim.top30Deals.map((d) => d.combinedAdultPriceKrw)
  );
  assert.equal(rebuilt.tiers.top10.items.length, Math.min(10, sim.top30Deals.length));
  assert.equal(rebuilt.tiers.top20.title, sim.tiers.top20.title);
});
