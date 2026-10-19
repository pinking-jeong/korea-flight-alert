/**
 * 프록시(target-scan · flex-dates)와 똑같이 Travelpayouts 캘린더 → 엔진으로 만든 결과
 * rows: [방향('OUTBOUND'|'INBOUND'), 날짜, 한국 공항, 가격, 항공사 코드(기본 QW)]
 * - proxyTargetScan: 브라우저가 앱에 보내는 scanResult 의 원본 (sourceApi 칸)
 * - proxyTargetScanResponse: 프록시 target-scan 경로의 응답 그대로 (realFare · fareSource 칸)
 */
const { scanTargetPriceDeals } = require('../../src/services/flightApiService');
const { targetScanParams, kstToday } = require('../../src/services/targetAlerts');
const { makeFareQuote } = require('../../proxy/lib/fares');

// 프록시가 운임을 받아 온 시각 — 앱은 8일보다 오래된 값을 버리므로 시험을 돌리는 때의 10분 전(분 단위)으로 둔다
const FETCHED_AT = new Date(Math.floor(Date.now() / 60000) * 60000 - 10 * 60000).toISOString();

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// 프록시가 Travelpayouts 캘린더로 만드는 운임 함수 (엔진의 fareQuote 자리에 넣는다)
function makeProxyQuote(destination, rows, { searchedOn = addDays(kstToday(), -1) } = {}) {
  const calendar = { OUTBOUND: {}, INBOUND: {} };
  for (const [direction, date, korean, priceKrw, airlineCode = 'QW'] of rows) {
    (calendar[direction][date] ||= []).push({
      korean,
      ticket: {
        date,
        departureTime: '23:30',
        priceKrw,
        airlineCode,
        flightNumber: `${airlineCode}9902`,
        transfers: 0,
        durationMinutes: 110,
        sourceUrl: `https://www.aviasales.com/search/${korean}0111${destination}1?t=${date}`,
        searchedOn
      }
    });
  }
  for (const byDate of Object.values(calendar)) {
    for (const list of Object.values(byDate)) list.sort((a, b) => a.ticket.priceKrw - b.ticket.priceKrw);
  }
  return makeFareQuote({
    calendar,
    destination,
    airlineNames: new Map([['QW', '칭다오항공'], ['7C', '제주항공']])
  });
}

// alert: 목표가 알림 모양 (origin·destination·targetPrice·windowDays·minNights·maxNights·인원·directOnly)
function proxyTargetScan(alert, rows, { searchedOn, fetchedAt = FETCHED_AT } = {}) {
  const fareQuote = makeProxyQuote(alert.destination, rows, { searchedOn });
  const scan = scanTargetPriceDeals({ ...targetScanParams(alert), fareQuote });
  return { ...scan, sourceApi: 'TRAVELPAYOUTS_PRICES', fetchedAt, partial: false };
}

function proxyTargetScanResponse(alert, rows, options = {}) {
  const { sourceApi, ...scan } = proxyTargetScan(alert, rows, options);
  return { ...scan, realFare: true, fareSource: sourceApi };
}

module.exports = { makeProxyQuote, proxyTargetScan, proxyTargetScanResponse, addDays, FETCHED_AT };
