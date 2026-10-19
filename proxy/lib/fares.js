/**
 * Travelpayouts 운임으로 노선 캘린더(날짜별·한국 공항별 최저 편도)를 만들고,
 * 앱 엔진(사본)이 쓰는 견적 함수(fareQuote)와 월별·요일별 시세로 바꾼다
 */
const airports = require('./engine/config/airports');
const { TravelpayoutsError } = require('./travelpayouts');

const FARE_SOURCE = 'TRAVELPAYOUTS_PRICES';
const DAY_NAMES_KO = ['일', '월', '화', '수', '목', '금', '토'];
// 화면의 요일 차트 순서 (월요일부터)
const WEEKDAY_ROWS = [
  ['월', '월요일', 1],
  ['화', '화요일', 2],
  ['수', '수요일', 3],
  ['목', '목요일', 4],
  ['금', '금요일', 5],
  ['토', '토요일', 6],
  ['일', '일요일', 0]
];
const CALENDAR_CONCURRENCY = 8;

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function weekdayOf(iso) {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

function monthsBetween(fromIso, toIso) {
  const months = [];
  let year = Number(fromIso.slice(0, 4));
  let month = Number(fromIso.slice(5, 7));
  const last = toIso.slice(0, 7);
  for (;;) {
    const ym = `${year}-${String(month).padStart(2, '0')}`;
    if (ym > last) break;
    months.push(ym);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

// 가격 추이 차트가 쓰는 달 — 엔진은 시작일을 (출발 windowDays 일 전, 내일) 중 늦은 날로 잡고 windowDays*2+1 일을 그린다 (+귀국일)
// 오늘(한국 날짜)을 하한으로 하루 넉넉히 잡아, 출발일이 가까워 시작일이 당겨져도 다음 달이 빠지지 않게 한다
function trendMonths({ departureDate, stayNights, today, windowDays = 7 }) {
  const earliest = addDays(departureDate, -windowDays);
  const start = earliest > today ? earliest : today;
  return monthsBetween(start, addDays(start, windowDays * 2 + 1 + stayNights));
}

// 요청 하나의 시간 예산이 지나면 새 Travelpayouts 호출을 시작하지 않는다 (함수 60초·화면 58초 안에 일부라도 돌려주게)
function timeBudgetError() {
  return new TravelpayoutsError('TP_TIME_BUDGET', 'Travelpayouts 조회가 오래 걸려 여기까지만 계산했습니다. 잠시 뒤 다시 시도하세요.', 504);
}

// 전국 통합이면 앱이 그 도착지에 취항한다고 보는 한국 공항들 (앱의 모의 계산과 같은 목록)
function koreanOriginsFor(origin, destination) {
  if (origin !== 'ALL_KOREA') return [origin];
  return airports
    .getEligibleKoreanOriginsForDestination(airports.getDestinationByCode(destination))
    .map((a) => a.code);
}

// 동시에 limit 개까지만 실행하고, 결과를 입력 순서대로 (Promise.allSettled 모양) 돌려준다
// deadline(Date.now 기준 밀리초)이 지나면 남은 항목은 부르지 않고 TP_TIME_BUDGET 으로 남긴다
async function mapLimit(items, limit, fn, { deadline = null } = {}) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      if (deadline !== null && Date.now() > deadline) {
        results[index] = { status: 'rejected', reason: timeBudgetError() };
        continue;
      }
      try {
        results[index] = { status: 'fulfilled', value: await fn(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function calendarJobs({ originCodes, destination, months }) {
  const jobs = [];
  for (const korean of originCodes) {
    for (const month of months) {
      jobs.push({ direction: 'OUTBOUND', korean, origin: korean, destination, month });
      jobs.push({ direction: 'INBOUND', korean, origin: destination, destination: korean, month });
    }
  }
  return jobs;
}

/**
 * 노선 캘린더: { OUTBOUND: { 'YYYY-MM-DD': [{ korean, ticket }] (가격순) }, INBOUND: {...} }
 * - 요청한 공항끼리의 표만 쓴다 (같은 도시의 다른 공항 표가 섞여 와도 예약 링크가 어긋나지 않게)
 * - 일부 조회가 실패하면 partial, 전부 실패하면 그 오류를 던진다
 */
async function buildRouteCalendar(tp, { originCodes, destination, months, direct, deadline = null }) {
  const jobs = calendarJobs({ originCodes, destination, months });
  const results = await mapLimit(
    jobs,
    CALENDAR_CONCURRENCY,
    (job) => tp.fetchTickets({ origin: job.origin, destination: job.destination, month: job.month, direct }),
    { deadline }
  );

  const best = { OUTBOUND: new Map(), INBOUND: new Map() }; // date → Map(korean → ticket)
  let oldestStoredAt = null;
  let failure = null;
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      failure = result.reason;
      return;
    }
    const job = jobs[index];
    const { value: tickets, storedAt } = result.value;
    if (oldestStoredAt === null || storedAt < oldestStoredAt) oldestStoredAt = storedAt;
    for (const ticket of tickets) {
      if (ticket.originAirport !== job.origin || ticket.destinationAirport !== job.destination) continue;
      if (direct && ticket.transfers > 0) continue;
      const byKorean = best[job.direction].get(ticket.date) || new Map();
      const prev = byKorean.get(job.korean);
      if (!prev || ticket.priceKrw < prev.priceKrw) byKorean.set(job.korean, ticket);
      best[job.direction].set(ticket.date, byKorean);
    }
  });
  if (failure && results.every((r) => r.status === 'rejected')) throw failure;

  const toObject = (byDate) =>
    Object.fromEntries(
      [...byDate.entries()].map(([date, byKorean]) => [
        date,
        [...byKorean.entries()].map(([korean, ticket]) => ({ korean, ticket })).sort((a, b) => a.ticket.priceKrw - b.ticket.priceKrw)
      ])
    );
  return {
    calendar: { OUTBOUND: toObject(best.OUTBOUND), INBOUND: toObject(best.INBOUND) },
    fetchedAt: oldestStoredAt === null ? null : new Date(oldestStoredAt).toISOString(),
    partial: Boolean(failure)
  };
}

function airlineCodesIn(calendar) {
  const codes = new Set();
  for (const byDate of [calendar.OUTBOUND, calendar.INBOUND]) {
    for (const entries of Object.values(byDate)) entries.forEach((e) => codes.add(e.ticket.airlineCode));
  }
  return [...codes].filter(Boolean);
}

function describeSchedule(ticket) {
  if (!ticket.departureTime) return '시간 확인';
  if (!ticket.durationMinutes) return `${ticket.departureTime} 출발`;
  const h = Math.floor(ticket.durationMinutes / 60);
  const m = ticket.durationMinutes % 60;
  return `${ticket.departureTime} 출발 · ${h ? `${h}시간 ` : ''}${m}분`.replace(' 0분', '');
}

// 캘린더 한 칸 → 엔진(computeOneWayCandidateOffers)이 만드는 편도 후보와 같은 모양
function toEngineLeg({ korean, ticket }, direction, destination, airlineNames) {
  const airline = airlineNames.get(ticket.airlineCode) || ticket.airlineCode || '항공사 확인';
  return {
    direction,
    originAirportCode: korean,
    originAirportCity: airports.getOriginByCode(korean).city,
    fromAirportCode: direction === 'OUTBOUND' ? korean : destination,
    toAirportCode: direction === 'OUTBOUND' ? destination : korean,
    date: ticket.date,
    dayOfWeekKo: DAY_NAMES_KO[weekdayOf(ticket.date)],
    airline,
    airlineCode: ticket.airlineCode,
    flightNumber: ticket.flightNumber || `${ticket.airlineCode}편`,
    baggageInfo: '운임 규정 확인',
    scheduleTime: describeSchedule(ticket),
    stops: ticket.transfers,
    oneWayPriceKrw: ticket.priceKrw,
    officialBookingUrl: airports.getAirlineOfficialBookingUrl(airline, ticket.airlineCode),
    naverOneWayUrl: '',
    fareSource: FARE_SOURCE,
    sourceUrl: ticket.sourceUrl,
    searchedOn: ticket.searchedOn || null
  };
}

// 엔진의 fareQuote: 그날 그 방향의 실제 편도 후보 (출발 공항이 정해져 있으면 그 공항만, 값 없으면 빈 목록)
function makeFareQuote({ calendar, destination, airlineNames }) {
  return ({ origin, dateStr, direction }) =>
    (calendar[direction]?.[dateStr] || [])
      .filter((entry) => origin === 'ALL_KOREA' || entry.korean === origin)
      .map((entry) => toEngineLeg(entry, direction, destination, airlineNames));
}

const round100 = (v) => Math.round(v / 100) * 100;

function summarize(prices) {
  if (!prices.length) return { avg: null, min: null, days: 0 };
  return {
    avg: round100(prices.reduce((acc, p) => acc + p, 0) / prices.length),
    min: Math.min(...prices),
    days: prices.length
  };
}

// 날짜별 최저가 (전국 통합이면 한국 공항 중 가장 싼 값)
function dailyBest(byDate) {
  return Object.entries(byDate)
    .map(([date, entries]) => ({ date, price: entries[0].ticket.priceKrw }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function lowestOf(days) {
  if (!days.length) return null;
  const pick = days.reduce((low, d) => (d.price < low.price ? d : low), days[0]);
  return { priceKrw: pick.price, date: pick.date };
}

/**
 * 월별(요청한 달 순서)·요일별(월~일) 가는 편/오는 편 시세 — 화면의 2년 시세 차트와 같은 행 모양
 */
function computeRouteStats({ calendar, months }) {
  const outDays = dailyBest(calendar.OUTBOUND);
  const inDays = dailyBest(calendar.INBOUND);

  const monthlyStats = months.map((month) => {
    const out = summarize(outDays.filter((d) => d.date.startsWith(month)).map((d) => d.price));
    const inn = summarize(inDays.filter((d) => d.date.startsWith(month)).map((d) => d.price));
    return {
      month,
      label: `${Number(month.slice(5, 7))}월`,
      fullLabel: `${month.slice(0, 4)}년 ${Number(month.slice(5, 7))}월`,
      outboundAvgKrw: out.avg,
      outboundMinKrw: out.min,
      outboundDays: out.days,
      inboundAvgKrw: inn.avg,
      inboundMinKrw: inn.min,
      inboundDays: inn.days
    };
  });

  const dayOfWeekStats = WEEKDAY_ROWS.map(([label, fullLabel, weekday]) => {
    const out = summarize(outDays.filter((d) => weekdayOf(d.date) === weekday).map((d) => d.price));
    const inn = summarize(inDays.filter((d) => weekdayOf(d.date) === weekday).map((d) => d.price));
    return {
      label,
      fullLabel,
      outboundAvgKrw: out.avg,
      outboundMinKrw: out.min,
      outboundDays: out.days,
      inboundAvgKrw: inn.avg,
      inboundMinKrw: inn.min,
      inboundDays: inn.days
    };
  });

  return {
    monthlyStats,
    dayOfWeekStats,
    summary: {
      lowestOutbound: lowestOf(outDays),
      lowestInbound: lowestOf(inDays),
      avgOutboundKrw: summarize(outDays.map((d) => d.price)).avg,
      avgInboundKrw: summarize(inDays.map((d) => d.price)).avg,
      outboundDays: outDays.length,
      inboundDays: inDays.length
    }
  };
}

module.exports = {
  FARE_SOURCE,
  addDays,
  monthsBetween,
  trendMonths,
  koreanOriginsFor,
  mapLimit,
  buildRouteCalendar,
  airlineCodesIn,
  makeFareQuote,
  computeRouteStats
};
