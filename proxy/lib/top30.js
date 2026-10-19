/**
 * 실제 운임(Travelpayouts) TOP 30 — 앱의 모의 TOP 30 과 같은 응답 모양 (화면 카드·3단 묶음을 그대로 쓴다)
 * 1단계: 한국 공항별·달별 '여기서 가장 싼 도착지' 목록(도착지마다 한 장)으로 싼 도착지를 고른다
 * 2단계: 고른 도착지만 날짜별 운임 캘린더를 받아 지역별 체류 기간에 맞는 왕복(편도 두 장) 짝을 찾는다
 *   (출발 달 하나 + 다음 달 귀국 · 가는 편이 싼 한국 공항부터 — 그 공항으로 돌아오는 편이 없으면 다음 공항, 최대 3곳)
 * - 모의 2년 기준값과는 비교하지 않는다 (실제 가격과 계산식 평균을 섞지 않게)
 */
const airports = require('./engine/config/airports');
const engine = require('./engine/services/flightApiService');
const { FARE_SOURCE, addDays, monthsBetween, mapLimit, buildRouteCalendar, airlineCodesIn, makeFareQuote } = require('./fares');

const HORIZON_DAYS = 180;
const MAX_PAIRED_DESTINATIONS = 40;
const DISCOVERY_CONCURRENCY = 8;
const PAIRING_CONCURRENCY = 4;
const MAX_AIRPORTS_PER_DESTINATION = 3;
// 지역별 체류 박수 범위 (모의 TOP 30 의 기본 박수 3·4·6박 주변)
const STAY_NIGHTS_BY_REGION = {
  일본: [2, 5],
  중화권: [2, 5],
  동남아: [3, 6]
};
const LONG_HAUL_STAY_NIGHTS = [5, 9];
const DAY_NAMES_KO = ['일', '월', '화', '수', '목', '금', '토'];

function stayRangeOf(region) {
  return STAY_NIGHTS_BY_REGION[region] || LONG_HAUL_STAY_NIGHTS;
}

function dayOfWeekKo(iso) {
  return DAY_NAMES_KO[new Date(`${iso}T00:00:00Z`).getUTCDay()];
}

function nextMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

// 1단계 결과 → 도착지마다 { dest, priceKrw, choices: 가는 편이 싼 한국 공항 순 [{ korean, month, priceKrw }] (최대 3곳) }
function pickCheapestDestinations(discovery, { destinationsByCode, firstDate, lastDate, directOnly }) {
  const byDest = new Map(); // 도착지 → Map(한국 공항 → 가장 싼 { korean, month, priceKrw })
  for (const { job, tickets } of discovery) {
    for (const ticket of tickets) {
      const dest = destinationsByCode.get(ticket.destinationAirport);
      if (!dest || ticket.originAirport !== job.korean) continue;
      if (ticket.date < firstDate || ticket.date > lastDate) continue;
      if (directOnly && ticket.transfers > 0) continue;
      const byKorean = byDest.get(dest.code) || new Map();
      const prev = byKorean.get(job.korean);
      if (!prev || ticket.priceKrw < prev.priceKrw) {
        byKorean.set(job.korean, { korean: job.korean, month: job.month, priceKrw: ticket.priceKrw });
      }
      byDest.set(dest.code, byKorean);
    }
  }
  return [...byDest.entries()]
    .map(([code, byKorean]) => {
      const choices = [...byKorean.values()].sort((a, b) => a.priceKrw - b.priceKrw).slice(0, MAX_AIRPORTS_PER_DESTINATION);
      return { dest: destinationsByCode.get(code), priceKrw: choices[0].priceKrw, choices };
    })
    .sort((a, b) => a.priceKrw - b.priceKrw);
}

// 날짜별 캘린더에서 체류 범위에 맞는 가장 싼 (가는 날, 오는 날) 짝
function cheapestPair(quote, { korean, dates, stayRange, lastDate }) {
  let best = null;
  for (const depDate of dates) {
    const [out] = quote({ origin: korean, dateStr: depDate, direction: 'OUTBOUND' });
    if (!out) continue;
    for (let nights = stayRange[0]; nights <= stayRange[1]; nights++) {
      const retDate = addDays(depDate, nights);
      if (retDate > addDays(lastDate, stayRange[1])) break;
      const [back] = quote({ origin: korean, dateStr: retDate, direction: 'INBOUND' });
      if (back && (!best || out.oneWayPriceKrw + back.oneWayPriceKrw < best.total)) {
        best = { out, back, nights, total: out.oneWayPriceKrw + back.oneWayPriceKrw };
      }
    }
  }
  return best;
}

function buildDeal({ requestedOrigin, dest, pair, pax, directOnly }) {
  const { out, back, nights } = pair;
  const passengerPricing = airports.calculatePassengerPricing(pair.total, pax);
  const bookingLinks = airports.buildBookingLinks({
    origin: out.fromAirportCode,
    destination: dest.code,
    departureDate: out.date,
    returnDate: back.date,
    adults: passengerPricing.adults,
    children: passengerPricing.children,
    infants: passengerPricing.infants,
    directOnly,
    outboundAirline: out.airline,
    inboundAirline: back.airline,
    outboundAirlineCode: out.airlineCode,
    inboundAirlineCode: back.airlineCode
  });
  return {
    requestedOrigin,
    origin: out.fromAirportCode,
    originCity: out.originAirportCity,
    destination: dest.code,
    destinationCity: dest.city,
    country: dest.country,
    region: dest.region,
    flightDuration: dest.flightDuration,
    departureDate: out.date,
    departureDayOfWeekKo: dayOfWeekKo(out.date),
    returnDate: back.date,
    returnDayOfWeekKo: dayOfWeekKo(back.date),
    monthLabel: `${out.date.slice(0, 4)}년 ${Number(out.date.slice(5, 7))}월`,
    stayNights: nights,
    stayLabel: `${nights}박 ${nights + 1}일`,
    outboundLeg: { ...out, naverOneWayUrl: bookingLinks.outboundNaverUrl, officialBookingUrl: bookingLinks.outboundAirlineOfficialUrl },
    inboundLeg: { ...back, naverOneWayUrl: bookingLinks.inboundNaverUrl, officialBookingUrl: bookingLinks.inboundAirlineOfficialUrl },
    combinedAdultPriceKrw: pair.total,
    totalPassengersPriceKrw: passengerPricing.totalPassengersPriceKrw,
    passengerSummaryText: passengerPricing.passengerSummaryText,
    avg2YKrw: null,
    lowest2YKrw: null,
    top10Deal2YKrw: null,
    discountVs2YAvgPercent: null,
    savedVs2YAvgKrw: null,
    isNearHistoricLow: false,
    fareSource: FARE_SOURCE,
    bookingLinks
  };
}

async function composeAnywhereTop30(
  tp,
  { origin = 'ALL_KOREA', region = 'ALL', directOnly = true, adults = 1, children = 0, infants = 0, today, maxDestinations = MAX_PAIRED_DESTINATIONS, deadline = null }
) {
  const firstDate = addDays(today, 1);
  const lastDate = addDays(today, HORIZON_DAYS);
  const months = monthsBetween(firstDate, lastDate);
  const koreanCodes = origin === 'ALL_KOREA' ? airports.INDIVIDUAL_KOREAN_AIRPORTS.map((a) => a.code) : [origin];
  const destinationsByCode = new Map(
    airports.INTERNATIONAL_DESTINATIONS.filter((d) => region === 'ALL' || d.region === region).map((d) => [d.code, d])
  );

  // 1단계
  const discoveryJobs = koreanCodes.flatMap((korean) => months.map((month) => ({ korean, month })));
  const discoveryResults = await mapLimit(
    discoveryJobs,
    DISCOVERY_CONCURRENCY,
    (job) => tp.fetchTickets({ origin: job.korean, month: job.month, direct: directOnly, unique: true }),
    { deadline }
  );
  const failures = discoveryResults.filter((r) => r.status === 'rejected');
  if (failures.length === discoveryResults.length) throw failures[0].reason;
  const fetchedTimes = discoveryResults.filter((r) => r.status === 'fulfilled').map((r) => r.value.storedAt);
  const discovery = discoveryResults
    .map((r, i) => (r.status === 'fulfilled' ? { job: discoveryJobs[i], tickets: r.value.value } : null))
    .filter(Boolean);
  const chosen = pickCheapestDestinations(discovery, { destinationsByCode, firstDate, lastDate, directOnly }).slice(0, maxDestinations);

  // 2단계
  let partial = failures.length > 0;
  const pax = { adults, children, infants };
  const paired = await mapLimit(chosen, PAIRING_CONCURRENCY, async ({ dest, choices }) => {
    // 가는 편이 싼 공항부터 — 그 공항으로 돌아오는 편이 없으면 다음 공항 (도착지를 통째로 빠뜨리지 않게, 호출은 필요할 때만 늘린다)
    for (const { korean, month } of choices) {
      const cal = await buildRouteCalendar(tp, {
        originCodes: [korean],
        destination: dest.code,
        months: [month, nextMonth(month)],
        direct: directOnly,
        deadline
      });
      if (cal.partial) partial = true;
      if (cal.fetchedAt) fetchedTimes.push(Date.parse(cal.fetchedAt));
      const airlineNames = await tp.resolveAirlineNames(airlineCodesIn(cal.calendar));
      const quote = makeFareQuote({ calendar: cal.calendar, destination: dest.code, airlineNames });
      const dates = Object.keys(cal.calendar.OUTBOUND)
        .filter((d) => d >= firstDate && d <= lastDate)
        .sort();
      const pair = cheapestPair(quote, { korean, dates, stayRange: stayRangeOf(dest.region), lastDate });
      if (pair) return buildDeal({ requestedOrigin: origin, dest, pair, pax, directOnly });
    }
    return null;
  }, { deadline });
  // 고른 도착지의 운임 달력이 모두 실패했으면 '자료 없음'이 아니라 오류로 알린다 (화면이 이유를 보이고 모의 가격으로 넘어가게)
  const rejected = paired.filter((r) => r.status === 'rejected');
  if (chosen.length > 0 && rejected.length === paired.length) throw rejected[0].reason;
  if (rejected.length) partial = true;
  const deals = paired.filter((r) => r.status === 'fulfilled' && r.value).map((r) => r.value);

  const response = engine.buildAnywhereTop30Response({
    pool: deals,
    sortBy: 'LOWEST_PRICE',
    origin,
    originCity: airports.getOriginByCode(origin).city,
    region,
    scannedCitiesCount: chosen.length,
    horizonDays: HORIZON_DAYS,
    limit: 30
  });
  return {
    ...response,
    realFare: true,
    fareSource: FARE_SOURCE,
    fetchedAt: fetchedTimes.length ? new Date(Math.min(...fetchedTimes)).toISOString() : null,
    partial
  };
}

module.exports = { composeAnywhereTop30, STAY_NIGHTS_BY_REGION, LONG_HAUL_STAY_NIGHTS, HORIZON_DAYS };
