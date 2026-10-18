/**
 * 같은 노선·날짜·인원이면 화면(탐색기 TOP 30 · 귀국일표 · 추천 일정 · 가격 추이 · 알림 등록)과 무관하게
 * 같은 가격과 같은 예약 링크가 나와야 한다는 일관성 테스트 (엔진 함수 직접 호출)
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  getAnywhereTop10Next6Months,
  getReturnDatePriceMatrix,
  getRoutePriceTrend,
  fetchLowestRoundTripPrice
} = require('../src/services/flightApiService');

const PAX = { adults: 2, children: 1, infants: 1 };

function dayDiff(from, to) {
  return Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000);
}

test('TOP 30 카드의 가격이 같은 일정의 귀국일표·가격 추이·알림 등록 가격과 같다', async () => {
  for (const directOnly of [true, false]) {
    const top = getAnywhereTop10Next6Months({ origin: 'ALL_KOREA', ...PAX, directOnly, limit: 30 });
    for (const deal of top.top30Deals.slice(0, 5)) {
      const nights = dayDiff(deal.departureDate, deal.returnDate);
      const query = {
        origin: deal.origin,
        destination: deal.destination,
        departureDate: deal.departureDate,
        returnDate: deal.returnDate,
        ...PAX,
        directOnly
      };

      const matrix = getReturnDatePriceMatrix({ ...query, maxStayDays: 10 });
      const matrixOption = matrix.returnOptions.find((o) => o.stayNights === nights);
      assert.equal(matrixOption.combinedAdultPriceKrw, deal.combinedAdultPriceKrw, `${deal.destination} 귀국일표`);

      const trend = getRoutePriceTrend(query);
      assert.equal(trend.selectedPoint.combinedAdultPriceKrw, deal.combinedAdultPriceKrw, `${deal.destination} 가격 추이`);

      const { offer } = await fetchLowestRoundTripPrice(query, {});
      assert.equal(offer.priceKrw, deal.combinedAdultPriceKrw, `${deal.destination} 알림 등록`);

      // 가격뿐 아니라 카드에 보이는 항공편과, 카드·알림의 예약 링크도 같아야 한다
      for (const legKey of ['outboundLeg', 'inboundLeg']) {
        assert.equal(offer[legKey].flightNumber, deal[legKey].flightNumber, `${deal.destination} ${legKey} 편명`);
        assert.equal(offer[legKey].oneWayPriceKrw, deal[legKey].oneWayPriceKrw, `${deal.destination} ${legKey} 편도가`);
      }
      assert.deepEqual(offer.bookingLinks, deal.bookingLinks, `${deal.destination} 예약 링크`);
      assert.deepEqual(matrixOption.bookingLinks, deal.bookingLinks, `${deal.destination} 귀국일표 예약 링크`);
    }
  }
});

test('당일 귀국(0박)·장기 체류(70박) 일정도 가격 추이 선택일 가격이 알림 등록 가격과 같다', async () => {
  const dep = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  for (const nights of [0, 70]) {
    const ret = new Date(Date.parse(`${dep}T00:00:00Z`) + nights * 86400000).toISOString().slice(0, 10);
    const query = { origin: 'ICN', destination: 'NRT', departureDate: dep, returnDate: ret, adults: 1, directOnly: true };
    const trend = getRoutePriceTrend(query);
    const { offer } = await fetchLowestRoundTripPrice(query, {});
    assert.equal(trend.stayNights, nights, `${nights}박 일정의 체류 박수`);
    assert.equal(trend.selectedPoint.combinedAdultPriceKrw, offer.priceKrw, `${nights}박 일정의 선택일 가격`);
  }
});

test('같은 알림을 다시 조회해도 시뮬레이션 가격이 무작위로 흔들리지 않는다', async () => {
  const query = {
    origin: 'ICN',
    destination: 'NRT',
    departureDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
    returnDate: new Date(Date.now() + 33 * 86400000).toISOString().slice(0, 10),
    adults: 1,
    directOnly: true
  };
  const prices = [];
  for (let i = 0; i < 5; i++) {
    prices.push((await fetchLowestRoundTripPrice(query, {})).offer.priceKrw);
  }
  assert.equal(new Set(prices).size, 1, `조회할 때마다 다른 가격: ${prices.join(', ')}`);
});
