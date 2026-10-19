/**
 * 노선 운임 캘린더(날짜별 최저 편도) → 엔진 견적 함수 · 월별/요일별 시세
 * - Travelpayouts 대신 가짜 조회 함수를 써서 계산만 확인한다
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  monthsBetween,
  koreanOriginsFor,
  mapLimit,
  buildRouteCalendar,
  makeFareQuote,
  computeRouteStats,
  trendMonths
} = require('../proxy/lib/fares');
const engine = require('../proxy/lib/engine/services/flightApiService');

function t(originAirport, destinationAirport, date, priceKrw, extra = {}) {
  return {
    originAirport,
    destinationAirport,
    originCity: '',
    destinationCity: '',
    date,
    departureTime: '08:55',
    priceKrw,
    airlineCode: '7C',
    flightNumber: '7C1101',
    transfers: 0,
    durationMinutes: 145,
    sourceUrl: null,
    searchedOn: null,
    ...extra
  };
}

// (origin, destination, month) → 표 목록. 키가 없으면 빈 목록, 'FAIL' 이면 오류
function fakeTp(table, { storedAt = Date.parse('2026-10-19T03:00:00Z') } = {}) {
  const calls = [];
  return {
    calls,
    async fetchTickets({ origin, destination, month, direct }) {
      calls.push({ origin, destination, month, direct });
      const rows = table[`${origin}>${destination}|${month}`];
      if (rows === 'FAIL') {
        const err = new Error('rate limited');
        err.code = 'TP_RATE_LIMIT';
        throw err;
      }
      return { value: rows || [], cached: false, storedAt };
    },
    async resolveAirlineNames(codes) {
      return new Map(codes.map((c) => [c, c === '7C' ? '제주항공' : c]));
    }
  };
}

test('달 목록·전국 통합 출발 공항·동시 실행 제한', async () => {
  assert.deepEqual(monthsBetween('2026-10-20', '2027-01-05'), ['2026-10', '2026-11', '2026-12', '2027-01']);
  assert.deepEqual(monthsBetween('2026-11-02', '2026-11-28'), ['2026-11']);
  assert.deepEqual(koreanOriginsFor('PUS', 'NRT'), ['PUS']);
  const all = koreanOriginsFor('ALL_KOREA', 'NRT');
  assert.ok(all.includes('ICN') && all.includes('PUS'));
  assert.ok(!all.includes('GMP'), 'NRT 는 김포 노선이 없다 (앱의 취항 공항 목록 기준)');

  let running = 0;
  let peak = 0;
  const results = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running -= 1;
    if (n === 4) throw new Error('four');
    return n * 10;
  });
  assert.equal(peak, 2);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled', 'fulfilled', 'rejected', 'fulfilled', 'fulfilled']);
  assert.equal(results[5].value, 60);
});

test('캘린더: 날짜·한국 공항별 최저가만 남기고, 다른 공항·경유(직항만일 때) 표는 버린다', async () => {
  const tp = fakeTp({
    'ICN>NRT|2026-11': [
      t('ICN', 'NRT', '2026-11-14', 123400, { airlineCode: 'KE', flightNumber: 'KE703' }),
      t('ICN', 'NRT', '2026-11-14', 99000),
      t('ICN', 'NRT', '2026-11-20', 88000, { transfers: 1 }),
      t('ICN', 'HND', '2026-11-15', 70000)
    ],
    'PUS>NRT|2026-11': [t('PUS', 'NRT', '2026-11-14', 95000)],
    'NRT>ICN|2026-11': [t('NRT', 'ICN', '2026-11-17', 100000)],
    'NRT>PUS|2026-11': 'FAIL'
  });
  const cal = await buildRouteCalendar(tp, { originCodes: ['ICN', 'PUS'], destination: 'NRT', months: ['2026-11'], direct: true });
  assert.deepEqual(
    cal.calendar.OUTBOUND['2026-11-14'].map((e) => [e.korean, e.ticket.priceKrw]),
    [['PUS', 95000], ['ICN', 99000]]
  );
  assert.equal(cal.calendar.OUTBOUND['2026-11-20'], undefined, '직항만이면 경유 표는 빠진다');
  assert.equal(cal.calendar.OUTBOUND['2026-11-15'], undefined, '요청한 공항(NRT)이 아닌 하네다 표는 빠진다');
  assert.equal(cal.calendar.INBOUND['2026-11-17'][0].korean, 'ICN');
  assert.equal(cal.partial, true, '한 갈래가 실패하면 부분 결과로 표시');
  assert.equal(cal.fetchedAt, '2026-10-19T03:00:00.000Z');
  assert.equal(tp.calls.length, 4);
  assert.ok(tp.calls.every((c) => c.direct === true));

  const allFail = fakeTp({ 'ICN>NRT|2026-11': 'FAIL', 'NRT>ICN|2026-11': 'FAIL' });
  await assert.rejects(
    buildRouteCalendar(allFail, { originCodes: ['ICN'], destination: 'NRT', months: ['2026-11'], direct: false }),
    (err) => err.code === 'TP_RATE_LIMIT'
  );
});

test('견적 함수: 엔진 편도 후보 모양으로 바꾸고 출발 공항으로 거른다 → 귀국일표가 실제 운임으로 계산된다', async () => {
  const tp = fakeTp({
    'ICN>NRT|2026-11': [t('ICN', 'NRT', '2026-11-14', 99000, { searchedOn: '2026-10-16' })],
    'PUS>NRT|2026-11': [t('PUS', 'NRT', '2026-11-14', 95000, { airlineCode: 'BX', flightNumber: 'BX112' })],
    'NRT>ICN|2026-11': [t('NRT', 'ICN', '2026-11-17', 100000)],
    'NRT>PUS|2026-11': [t('NRT', 'PUS', '2026-11-16', 120000, { airlineCode: 'BX', flightNumber: 'BX111' })]
  });
  const cal = await buildRouteCalendar(tp, { originCodes: ['ICN', 'PUS'], destination: 'NRT', months: ['2026-11'], direct: false });
  const names = await tp.resolveAirlineNames(['7C', 'BX']);
  const quote = makeFareQuote({ calendar: cal.calendar, destination: 'NRT', airlineNames: names });

  const [leg] = quote({ origin: 'ICN', dateStr: '2026-11-14', direction: 'OUTBOUND' });
  assert.deepEqual(leg, {
    direction: 'OUTBOUND',
    originAirportCode: 'ICN',
    originAirportCity: '서울/인천',
    fromAirportCode: 'ICN',
    toAirportCode: 'NRT',
    date: '2026-11-14',
    dayOfWeekKo: '토',
    airline: '제주항공',
    airlineCode: '7C',
    flightNumber: '7C1101',
    baggageInfo: '운임 규정 확인',
    scheduleTime: '08:55 출발 · 2시간 25분',
    stops: 0,
    oneWayPriceKrw: 99000,
    officialBookingUrl: leg.officialBookingUrl,
    naverOneWayUrl: '',
    fareSource: 'TRAVELPAYOUTS_PRICES',
    sourceUrl: null,
    searchedOn: '2026-10-16'
  });
  const icnMatrix = engine.getReturnDatePriceMatrix({ origin: 'ICN', destination: 'NRT', departureDate: '2026-11-14', maxStayDays: 5, fareQuote: quote });
  assert.equal(icnMatrix.outboundLeg.searchedOn, '2026-10-16', '엔진이 만든 귀국일표의 가는 편에도 검색한 날이 남는다');
  assert.deepEqual(quote({ origin: 'ALL_KOREA', dateStr: '2026-11-14', direction: 'OUTBOUND' }).map((l) => l.originAirportCode), ['PUS', 'ICN']);
  assert.deepEqual(quote({ origin: 'PUS', dateStr: '2026-11-17', direction: 'INBOUND' }), [], '김해로 오는 표는 그날 없음');
  assert.equal(quote({ origin: 'ICN', dateStr: '2026-11-17', direction: 'INBOUND' })[0].toAirportCode, 'ICN');

  // 엔진(앱과 같은 사본)이 이 견적 함수로 귀국일표를 만든다 — 전국 통합은 귀국일마다 같은 공항 왕복 합계가 가장 싼 짝
  // (김해 출발이 싸도 김해로 오는 편은 11-16 뿐: 2박은 김해 왕복, 3박은 인천 왕복이 더 싸다)
  const matrix = engine.getReturnDatePriceMatrix({ origin: 'ALL_KOREA', destination: 'NRT', departureDate: '2026-11-14', maxStayDays: 5, fareQuote: quote });
  assert.deepEqual(
    matrix.returnOptions.map((o) => [o.stayNights, o.origin, o.combinedAdultPriceKrw]),
    [[2, 'PUS', 215000], [3, 'ICN', 199000]]
  );
  assert.equal(matrix.returnOptions[0].inboundLeg.flightNumber, 'BX111');
  assert.equal(matrix.origin, 'ICN', '맨 위 가는 편은 가장 싼 칸(3박 인천 왕복)의 공항');
  assert.equal(matrix.cheapestOption.inboundLeg.toAirportCode, 'ICN');
});

test('가격 추이 달 범위: 출발일이 가까워 시작일이 당겨져도 그리는 15일(+귀국일)의 달을 모두 받는다', () => {
  // 출발 10-21 → 엔진은 시작일을 내일(10-20)로 당겨 11월 초까지 그린다 (예전 계산은 10월만 받아 11월 점이 빠졌다)
  assert.deepEqual(trendMonths({ departureDate: '2026-10-21', stayNights: 3, today: '2026-10-19' }), ['2026-10', '2026-11']);
  assert.deepEqual(trendMonths({ departureDate: '2026-12-20', stayNights: 3, today: '2026-10-19' }), ['2026-12']);
  assert.deepEqual(trendMonths({ departureDate: '2026-12-28', stayNights: 5, today: '2026-10-19' }), ['2026-12', '2027-01']);
});

test('시간 예산: 마감이 지나면 새 호출을 시작하지 않고 그 항목은 TP_TIME_BUDGET 으로 남긴다', async () => {
  let started = 0;
  const results = await mapLimit([1, 2, 3], 2, async (n) => {
    started += 1;
    return n;
  }, { deadline: Date.now() - 1 });
  assert.equal(started, 0);
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected', 'rejected']);
  assert.equal(results[0].reason.code, 'TP_TIME_BUDGET');
  assert.equal(results[0].reason.status, 504);

  const open = await mapLimit([1, 2], 2, async (n) => n * 10, { deadline: Date.now() + 60000 });
  assert.deepEqual(open.map((r) => r.value), [10, 20]);
});

test('월별·요일별 시세: 날짜별 최저가의 평균·최저·날짜 수, 자료 없는 달은 비움', async () => {
  const tp = fakeTp({
    'ICN>NRT|2026-11': [t('ICN', 'NRT', '2026-11-02', 100000), t('ICN', 'NRT', '2026-11-03', 80000), t('ICN', 'NRT', '2026-11-09', 120000)],
    'NRT>ICN|2026-11': [t('NRT', 'ICN', '2026-11-08', 90000)],
    'ICN>NRT|2026-12': [],
    'NRT>ICN|2026-12': [t('NRT', 'ICN', '2026-12-06', 150000)]
  });
  const months = ['2026-11', '2026-12'];
  const cal = await buildRouteCalendar(tp, { originCodes: ['ICN'], destination: 'NRT', months, direct: false });
  const stats = computeRouteStats({ calendar: cal.calendar, months });

  assert.deepEqual(stats.monthlyStats[0], {
    month: '2026-11',
    label: '11월',
    fullLabel: '2026년 11월',
    outboundAvgKrw: 100000,
    outboundMinKrw: 80000,
    outboundDays: 3,
    inboundAvgKrw: 90000,
    inboundMinKrw: 90000,
    inboundDays: 1
  });
  assert.equal(stats.monthlyStats[1].outboundAvgKrw, null);
  assert.equal(stats.monthlyStats[1].outboundDays, 0);
  assert.equal(stats.monthlyStats[1].inboundAvgKrw, 150000);

  // 11/2·11/9 는 월요일, 11/3 은 화요일, 11/8·12/6 은 일요일
  assert.deepEqual(stats.dayOfWeekStats.map((d) => d.label), ['월', '화', '수', '목', '금', '토', '일']);
  assert.equal(stats.dayOfWeekStats[0].outboundAvgKrw, 110000);
  assert.equal(stats.dayOfWeekStats[0].outboundDays, 2);
  assert.equal(stats.dayOfWeekStats[1].outboundAvgKrw, 80000);
  assert.equal(stats.dayOfWeekStats[2].outboundAvgKrw, null);
  assert.equal(stats.dayOfWeekStats[6].inboundAvgKrw, 120000);

  assert.deepEqual(stats.summary.lowestOutbound, { priceKrw: 80000, date: '2026-11-03' });
  assert.deepEqual(stats.summary.lowestInbound, { priceKrw: 90000, date: '2026-11-08' });
  assert.equal(stats.summary.outboundDays, 3);
  assert.equal(stats.summary.inboundDays, 2);
});
