/**
 * 노선·인원 설정 메뉴의 두 기능 (엔진)
 * - ±3일 최저가: 입력한 가는 날·오는 날을 각각 ±3일 옮긴 조합 중 싼 순서로 20개
 * - 목표가 알림 스캔: 날짜를 정하지 않고 희망 목표가만 정하면, 기간 안의 출발일을 하루씩 훑어
 *   그날 가장 싼 왕복(편도 두 장)이 목표가 이하인 날을 모은다
 * 모의 가격(계산식)과 실제 운임(Travelpayouts 캘린더 → 프록시와 같은 견적 함수) 모두 같은 함수로 계산한다
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { getFlexibleDateDeals, scanTargetPriceDeals } = require('../src/services/flightApiService');
const { makeFareQuote } = require('../proxy/lib/fares');

const DAY_MS = 86400000;
const kstToday = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const TODAY = kstToday();

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

function tpTicket(date, priceKrw, { airlineCode = '7C', flightNumber = '7C1101', searchedOn = addDays(TODAY, -2) } = {}) {
  return {
    originAirport: '',
    destinationAirport: '',
    originCity: '',
    destinationCity: '',
    date,
    departureTime: '08:55',
    priceKrw,
    airlineCode,
    flightNumber,
    transfers: 0,
    durationMinutes: 145,
    sourceUrl: 'https://www.aviasales.com/search/ICN1411NRT1?t=X',
    searchedOn
  };
}

// [방향, 날짜, 한국 공항, 가격, 옵션] → 프록시와 같은 견적 함수 (날짜마다 싼 표부터)
function realQuote(rows) {
  const calendar = { OUTBOUND: {}, INBOUND: {} };
  for (const [direction, date, korean, price, opts] of rows) {
    (calendar[direction][date] ||= []).push({ korean, ticket: tpTicket(date, price, opts) });
  }
  for (const byDate of Object.values(calendar)) {
    for (const list of Object.values(byDate)) list.sort((a, b) => a.ticket.priceKrw - b.ticket.priceKrw);
  }
  return makeFareQuote({ calendar, destination: 'NRT', airlineNames: new Map([['7C', '제주항공'], ['BX', '에어부산']]) });
}

const isSortedByPrice = (list) => list.every((x, i) => i === 0 || list[i - 1].combinedAdultPriceKrw <= x.combinedAdultPriceKrw);

test('±3일 최저가(모의): 가는 날·오는 날을 ±3일 옮긴 조합 중 싼 순서로 20개, 입력한 일정의 값도 함께', () => {
  const dep = addDays(TODAY, 30);
  const ret = addDays(dep, 4);
  const res = getFlexibleDateDeals({ origin: 'ICN', destination: 'NRT', departureDate: dep, returnDate: ret, adults: 2, today: TODAY });
  assert.equal(res.flexDays, 3);
  assert.equal(res.comboCount, 43, '7×7=49 조합 중 오는 날이 가는 날보다 뒤인 43개');
  assert.equal(res.deals.length, 20);
  assert.ok(isSortedByPrice(res.deals));
  for (const deal of res.deals) {
    assert.equal(deal.depShiftDays, daysBetween(dep, deal.departureDate));
    assert.equal(deal.retShiftDays, daysBetween(ret, deal.returnDate));
    assert.ok(Math.abs(deal.depShiftDays) <= 3 && Math.abs(deal.retShiftDays) <= 3);
    assert.equal(deal.stayNights, daysBetween(deal.departureDate, deal.returnDate));
    assert.ok(deal.stayNights >= 1);
    assert.equal(deal.combinedAdultPriceKrw, deal.outboundLeg.oneWayPriceKrw + deal.inboundLeg.oneWayPriceKrw);
    assert.equal(deal.bookingLinks.bookingMeta.adults, 2, '예약 링크는 그 인원으로');
    assert.equal(deal.bookingLinks.bookingMeta.departureDate, deal.departureDate);
    assert.equal(deal.isRequestedDates, deal.depShiftDays === 0 && deal.retShiftDays === 0);
  }
  assert.equal(res.requestedDates.departureDate, dep);
  assert.equal(res.requestedDates.returnDate, ret);
  assert.ok(res.requestedDates.combinedAdultPriceKrw > 0, '입력한 일정의 값은 목록에 없어도 알려 준다');
  assert.ok(res.deals[0].combinedAdultPriceKrw <= res.requestedDates.combinedAdultPriceKrw);

  assert.equal(getFlexibleDateDeals({ origin: 'ICN', destination: 'NRT', departureDate: dep, returnDate: ret, limit: 5, today: TODAY }).deals.length, 5);
  const wide = getFlexibleDateDeals({ origin: 'ICN', destination: 'NRT', departureDate: dep, returnDate: ret, flexDays: 9, today: TODAY });
  assert.equal(wide.flexDays, 3, '±3일보다 넓게는 훑지 않는다');
});

test('±3일 최저가: 오늘보다 앞선 가는 날은 빼고, 오는 날이 가는 날보다 앞서면 빼며, 날짜가 이상하면 오류', () => {
  const dep = addDays(TODAY, 1);
  const ret = addDays(TODAY, 3);
  const res = getFlexibleDateDeals({ origin: 'ICN', destination: 'NRT', departureDate: dep, returnDate: ret, today: TODAY });
  assert.ok(res.deals.length > 0);
  for (const deal of res.deals) {
    assert.ok(deal.departureDate >= TODAY, deal.departureDate);
    assert.ok(deal.returnDate > deal.departureDate);
  }
  assert.throws(() => getFlexibleDateDeals({ origin: 'ICN', destination: 'NRT', departureDate: 'x', returnDate: ret, today: TODAY }), (e) => e.code === 'BAD_DATE');
  assert.throws(() => getFlexibleDateDeals({ origin: 'ICN', destination: 'NRT', departureDate: ret, returnDate: dep, today: TODAY }), (e) => e.code === 'BAD_DATE');
});

test('±3일 최저가(최근 검색가 · 전국 통합): 캘린더에 있는 날만, 같은 한국 공항 왕복, 검색한 날 유지', () => {
  const dep = addDays(TODAY, 20);
  const ret = addDays(dep, 3);
  const quote = realQuote([
    ['OUTBOUND', dep, 'PUS', 95000, { airlineCode: 'BX', flightNumber: 'BX112', searchedOn: addDays(TODAY, -1) }],
    ['OUTBOUND', dep, 'ICN', 99000],
    ['OUTBOUND', addDays(dep, 1), 'ICN', 80000],
    ['INBOUND', ret, 'ICN', 100000],
    ['INBOUND', addDays(ret, -1), 'PUS', 120000, { airlineCode: 'BX', flightNumber: 'BX111' }],
    ['INBOUND', addDays(ret, 3), 'ICN', 70000]
  ]);
  const res = getFlexibleDateDeals({ origin: 'ALL_KOREA', destination: 'NRT', departureDate: dep, returnDate: ret, fareQuote: quote, today: TODAY });
  // 가는 날 다음 날(인천 8만)·오는 날 사흘 뒤(인천 7만)가 가장 싸고, 김해 왕복은 김해로 오는 날(하루 앞)에만 짝이 맞는다
  const got = res.deals.map((d) => [d.departureDate, d.returnDate, d.origin, d.combinedAdultPriceKrw]);
  assert.deepEqual(got, [
    [addDays(dep, 1), addDays(ret, 3), 'ICN', 150000],
    [dep, addDays(ret, 3), 'ICN', 169000],
    [addDays(dep, 1), ret, 'ICN', 180000],
    [dep, ret, 'ICN', 199000],
    [dep, addDays(ret, -1), 'PUS', 215000]
  ]);
  assert.equal(res.comboCount, 5, '값이 있는 날의 짝만 센다');
  const pus = res.deals.find((d) => d.origin === 'PUS');
  assert.equal(pus.outboundLeg.flightNumber, 'BX112');
  assert.equal(pus.outboundLeg.searchedOn, addDays(TODAY, -1));
  assert.equal(pus.bookingLinks.bookingMeta.originCode, 'PUS', '김해 왕복이면 예약 링크도 김해 출발');
  assert.equal(res.requestedDates.combinedAdultPriceKrw, 199000);
  assert.equal(res.deals.find((d) => d.isRequestedDates).combinedAdultPriceKrw, 199000);
});

test('목표가 스캔(모의): 출발일을 하루씩 훑어, 그날 가장 싼 일정이 목표가 이하인 날만 싼 순서로', () => {
  const fromDate = addDays(TODAY, 7);
  const base = { origin: 'ICN', destination: 'NRT', fromDate, toDate: addDays(fromDate, 29), minNights: 2, maxNights: 4, adults: 1, today: TODAY };

  const all = scanTargetPriceDeals({ ...base, targetPrice: 50000000 });
  assert.equal(all.scannedDays, 30, '30일을 하루씩');
  assert.equal(all.daysWithFares, 30);
  assert.equal(all.matchCount, 30, '목표가가 아주 높으면 모든 날');
  assert.equal(all.matches.length, 20, '알려 주는 건 싼 20일');
  assert.ok(isSortedByPrice(all.matches));
  assert.equal(new Set(all.matches.map((m) => m.departureDate)).size, 20, '하루에 하나(그날 가장 싼 일정)');
  for (const m of all.matches) {
    assert.ok(m.departureDate >= fromDate && m.departureDate <= base.toDate);
    assert.ok(m.stayNights >= 2 && m.stayNights <= 4);
  }
  assert.equal(all.cheapest.combinedAdultPriceKrw, all.matches[0].combinedAdultPriceKrw);

  // 목표가를 중간값으로: 목표가 이하인 날만, 하나도 빠짐없이
  const dayBest = [...all.matches];
  const median = dayBest[10].combinedAdultPriceKrw;
  const half = scanTargetPriceDeals({ ...base, targetPrice: median, limit: 30 });
  assert.ok(half.matches.every((m) => m.combinedAdultPriceKrw <= median));
  assert.equal(half.matchCount, half.matches.length);
  const full = scanTargetPriceDeals({ ...base, targetPrice: 50000000, limit: 30 });
  assert.equal(half.matchCount, full.matches.filter((m) => m.combinedAdultPriceKrw <= median).length);

  const none = scanTargetPriceDeals({ ...base, targetPrice: 1000 });
  assert.equal(none.matchCount, 0);
  assert.deepEqual(none.matches, []);
  assert.equal(none.cheapest.combinedAdultPriceKrw, all.cheapest.combinedAdultPriceKrw, '없어도 가장 싼 값은 알려 준다(목표가까지 얼마 남았는지)');
});

test('목표가 스캔(최근 검색가 · 전국 통합): 값이 있는 날만, 그날 같은 공항 왕복 중 가장 싼 일정, 정확히 목표가 이하인 날', () => {
  const d1 = addDays(TODAY, 10);
  const d2 = addDays(TODAY, 12);
  const d3 = addDays(TODAY, 15);
  const quote = realQuote([
    ['OUTBOUND', d1, 'ICN', 90000],
    ['INBOUND', addDays(d1, 2), 'ICN', 80000],
    ['INBOUND', addDays(d1, 3), 'ICN', 60000],
    ['OUTBOUND', d2, 'PUS', 70000, { airlineCode: 'BX', flightNumber: 'BX112' }],
    ['INBOUND', addDays(d2, 2), 'PUS', 75000, { airlineCode: 'BX', flightNumber: 'BX111', searchedOn: addDays(TODAY, -5) }],
    ['OUTBOUND', d3, 'ICN', 150000],
    ['INBOUND', addDays(d3, 2), 'ICN', 150000]
  ]);
  const res = scanTargetPriceDeals({
    origin: 'ALL_KOREA',
    destination: 'NRT',
    targetPrice: 150000,
    fromDate: addDays(TODAY, 1),
    toDate: addDays(TODAY, 30),
    minNights: 2,
    maxNights: 3,
    fareQuote: quote,
    today: TODAY
  });
  assert.equal(res.scannedDays, 30);
  assert.equal(res.daysWithFares, 3);
  assert.deepEqual(
    res.matches.map((m) => [m.departureDate, m.returnDate, m.origin, m.combinedAdultPriceKrw]),
    [
      [d2, addDays(d2, 2), 'PUS', 145000],
      [d1, addDays(d1, 3), 'ICN', 150000]
    ]
  );
  assert.equal(res.matchCount, 2);
  assert.equal(res.matches[0].inboundLeg.searchedOn, addDays(TODAY, -5));
  assert.equal(res.cheapest.combinedAdultPriceKrw, 145000);
  assert.equal(res.targetPrice, 150000);
});

test('목표가 스캔: 기간은 오늘부터·최대 186일, 박수는 1~30, 목표가가 숫자가 아니면 오류', () => {
  const res = scanTargetPriceDeals({
    origin: 'ICN',
    destination: 'NRT',
    targetPrice: 50000000,
    fromDate: addDays(TODAY, -5),
    toDate: addDays(TODAY, 400),
    minNights: 0,
    maxNights: 99,
    today: TODAY
  });
  assert.equal(res.fromDate, TODAY);
  assert.equal(res.toDate, addDays(TODAY, 185));
  assert.equal(res.scannedDays, 186);
  assert.equal(res.minNights, 1);
  assert.equal(res.maxNights, 30);
  for (const bad of [0, -1, 'abc', null]) {
    assert.throws(() => scanTargetPriceDeals({ origin: 'ICN', destination: 'NRT', targetPrice: bad, today: TODAY }), (e) => e.code === 'BAD_TARGET_PRICE', String(bad));
  }
});
