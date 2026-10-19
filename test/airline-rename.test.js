/**
 * 티웨이항공 → 트리니티항공 (2026 사명 변경 · 항공사 코드 TW·편명은 그대로)
 * - 앱 이름표·모의 운임 항공사 목록·이름이 빈 외부 운임 후보·공식 홈페이지가 새 이름·새 주소를 쓴다
 * - 옛 이름으로 이미 저장된 알림도 공식 홈페이지는 새 주소로 간다 (옛 주소 twayair.com/app/main 은 403)
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const airports = require('../src/config/airports');
const { fetchLowestRoundTripPrice } = require('../src/services/flightApiService');

const NEW_NAME = '트리니티항공';
const NEW_URL = 'https://www.trinityairways.com/';

function futureDate(days) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

test('코드 TW 의 이름표와 모의 운임 항공사 목록이 새 이름을 쓴다', () => {
  assert.equal(airports.AIRLINE_CODE_TO_NAME.TW, NEW_NAME);
  const tw = airports.INTERNATIONAL_DESTINATIONS.flatMap((d) => d.airlines || []).filter((a) => a.code === 'TW');
  assert.ok(tw.length > 0, '시험 전제: 모의 운임에 TW 편이 있다');
  assert.deepEqual([...new Set(tw.map((a) => a.name))], [NEW_NAME]);
});

test('공식 홈페이지: 새 이름·코드만·옛 이름(이미 저장된 알림) 모두 새 주소로 간다', () => {
  assert.equal(airports.getAirlineOfficialBookingUrl(NEW_NAME, 'TW'), NEW_URL);
  assert.equal(airports.getAirlineOfficialBookingUrl('', 'TW'), NEW_URL);
  assert.equal(airports.getAirlineOfficialBookingUrl('티웨이항공', 'TW'), NEW_URL);
});

test('외부 실제 운임 후보에 항공사 이름이 없으면 코드 TW 로 새 이름과 새 공식 홈페이지를 붙인다', async () => {
  const dep = futureDate(40);
  const ret = futureDate(43);
  const leg = (from, to, date, no, price) => ({
    airline: '',
    airlineCode: 'TW',
    flightNumber: `TW${no}`,
    fromAirportCode: from,
    toAirportCode: to,
    date,
    departureTime: '09:00',
    arrivalTime: '11:00',
    scheduleTime: '09:00 → 11:00',
    stops: 0,
    oneWayPriceKrw: price
  });
  const { offer } = await fetchLowestRoundTripPrice(
    { origin: 'ICN', destination: 'NRT', departureDate: dep, returnDate: ret, adults: 1, children: 0, infants: 0, directOnly: true, targetPrice: 200000 },
    {},
    {
      externalCandidates: {
        sourceApi: 'SERPAPI_GOOGLE_FLIGHTS',
        fetchedAt: '2026-10-19T07:00:00.000Z',
        outbound: [leg('ICN', 'NRT', dep, '241', 150000)],
        inbound: [leg('NRT', 'ICN', ret, '242', 160000)]
      }
    }
  );
  assert.equal(offer.outboundLeg.airline, NEW_NAME);
  assert.equal(offer.inboundLeg.airline, NEW_NAME);
  assert.equal(offer.outboundLeg.officialBookingUrl, NEW_URL);
});
