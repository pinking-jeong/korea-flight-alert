/**
 * SerpApi 구글 플라이트 (engine=google_flights) — 편도 검색만 쓴다
 * - 왕복 규칙은 가는 편·오는 편을 편도로 각각 검색한다 (왕복 검색은 오는 편을 보려면 어차피 두 번째 검색이 필요).
 * - 성인 1명으로 검색해 가격이 '성인 1인 편도'임이 분명하게 한다 (여러 명일 때 합계인지는 공식 문서에 없다).
 * - 같은 조건은 SerpApi 가 1시간 캐시하고 캐시 응답은 무료라 no_cache 는 보내지 않는다.
 * - 키는 요청 주소에만 붙고, 오류 메시지·응답에는 절대 넣지 않는다.
 */
const { cleanText } = require('./text');
const { AIRLINE_CODE_TO_NAME } = require('./engine/config/airports');

const SEARCH_ENDPOINT = 'https://serpapi.com/search.json';
const ACCOUNT_ENDPOINT = 'https://serpapi.com/account.json';
const NO_RESULTS_PATTERN = /hasn't returned any results|no results/i;

// search_metadata.created_at 예: '2026-10-19 03:04:05 UTC'
function parseSearchedAt(text) {
  const m = String(text || '').match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/);
  return m ? `${m[1]}T${m[2]}.000Z` : null;
}

class SerpApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'SerpApiError';
    this.code = code;
    this.status = status;
  }
}

function buildOneWaySearchParams({ from, to, date, nonstop }) {
  return new URLSearchParams({
    engine: 'google_flights',
    type: '2',
    departure_id: from,
    arrival_id: to,
    outbound_date: date,
    currency: 'KRW',
    hl: 'ko',
    gl: 'kr',
    adults: '1',
    stops: nonstop ? '1' : '0'
  });
}

const IATA = /^[A-Z]{3}$/;

// SerpApi 의 현지 시각 'YYYY-MM-DD HH:MM' — 형식이 다르면 null (외부 값은 형식이 맞는 것만 넘긴다)
function parseLocalTime(value) {
  const m = String(value || '').match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2})?$/);
  return m ? { date: m[1], time: m[2] } : null;
}

function minutesOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function splitFlightNumber(raw) {
  const compact = String(raw || '').replace(/\s+/g, '').toUpperCase();
  const m = compact.match(/^([A-Z0-9]{2})(\d{1,4}[A-Z]?)$/);
  if (m) return { airlineCode: m[1], flightNumber: `${m[1]}${m[2]}` };
  // 모양이 다른 편명은 엔진이 받는 형식(영문·숫자 2~8자)일 때만 남긴다
  return /^[A-Z0-9]{2,8}$/.test(compact) ? { airlineCode: compact.slice(0, 2), flightNumber: compact } : { airlineCode: '', flightNumber: '' };
}

function normalizeItem(item) {
  const segments = Array.isArray(item?.flights) ? item.flights : [];
  const price = Number(item?.price);
  if (!segments.length || !Number.isFinite(price) || price <= 0) return null;
  const first = segments[0] || {};
  const last = segments[segments.length - 1] || {};
  const from = String(first.departure_airport?.id || '').toUpperCase();
  const to = String(last.arrival_airport?.id || '').toUpperCase();
  const dep = parseLocalTime(first.departure_airport?.time);
  if (!IATA.test(from) || !IATA.test(to) || !dep) return null;
  const arr = parseLocalTime(last.arrival_airport?.time);
  const arrivalTime = arr ? arr.time : '--:--';
  const nextDay = Boolean(arr && arr.date > dep.date);
  const { airlineCode, flightNumber } = splitFlightNumber(first.flight_number);
  return {
    // 앱의 한국어 이름표를 먼저 써서 같은 항공사가 화면마다 다른 이름으로 보이지 않게 한다 (Travelpayouts 와 같은 순서)
    airline: AIRLINE_CODE_TO_NAME[airlineCode] || cleanText(first.airline) || airlineCode,
    airlineCode,
    flightNumber,
    fromAirportCode: from,
    toAirportCode: to,
    date: dep.date,
    departureTime: dep.time,
    arrivalTime,
    scheduleTime: `${dep.time} → ${arrivalTime}${nextDay ? '(+1)' : ''}`,
    stops: segments.length - 1,
    durationMinutes: minutesOrZero(item.total_duration) || segments.reduce((acc, s) => acc + minutesOrZero(s?.duration), 0),
    oneWayPriceKrw: Math.round(price)
  };
}

function normalizeOneWayResults(json) {
  const items = [...(json?.best_flights || []), ...(json?.other_flights || [])];
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const c = normalizeItem(item);
    if (!c) continue;
    const key = `${c.flightNumber}|${c.date}|${c.oneWayPriceKrw}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out.sort((a, b) => a.oneWayPriceKrw - b.oneWayPriceKrw);
}

const UPSTREAM_TIMEOUT_MS = 15000;

async function callJson(fetchImpl, url) {
  let res;
  try {
    res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  } catch {
    throw new SerpApiError('SERPAPI_NETWORK', 'SerpApi 에 연결하지 못했습니다.', 502);
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { res, body };
}

async function searchOneWay({ apiKey, fetchImpl = fetch, from, to, date, nonstop }) {
  const params = buildOneWaySearchParams({ from, to, date, nonstop });
  params.set('api_key', apiKey);
  const { res, body } = await callJson(fetchImpl, `${SEARCH_ENDPOINT}?${params.toString()}`);

  if (res.status === 401) throw new SerpApiError('SERPAPI_AUTH', 'SerpApi 키가 올바르지 않습니다.', 502);
  if (res.status === 429) throw new SerpApiError('SERPAPI_LIMIT', 'SerpApi 무료 한도(월·시간당)를 넘었습니다.', 429);
  if (!res.ok) throw new SerpApiError('SERPAPI_ERROR', `SerpApi 오류 (HTTP ${res.status})`, 502);

  const meta = body?.search_metadata || {};
  const searchedAt = parseSearchedAt(meta.created_at);
  if (body?.error && NO_RESULTS_PATTERN.test(String(body.error))) {
    return { candidates: [], searchedAt };
  }
  if (!body || meta.status === 'Error' || body.error) {
    throw new SerpApiError('SERPAPI_ERROR', 'SerpApi 가 검색 결과를 주지 않았습니다.', 502);
  }
  return { candidates: normalizeOneWayResults(body), searchedAt };
}

// 계정 응답의 횟수 칸 — 숫자(또는 숫자 글자)만 받고 나머지는 비운다
function countOrNull(value) {
  if (typeof value === 'string' && value.trim() === '') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function summarizeAccount(json) {
  return {
    planName: cleanText(json?.plan_name) || null,
    searchesPerMonth: countOrNull(json?.searches_per_month),
    searchesLeft: countOrNull(json?.total_searches_left ?? json?.plan_searches_left),
    thisMonthUsage: countOrNull(json?.this_month_usage),
    thisHourSearches: countOrNull(json?.this_hour_searches),
    hourlyLimit: countOrNull(json?.account_rate_limit_per_hour)
  };
}

// 계정 조회는 무료이며 검색 횟수에 들어가지 않는다 (serpapi.com/account-api)
async function fetchAccountSummary({ apiKey, fetchImpl = fetch }) {
  const { res, body } = await callJson(fetchImpl, `${ACCOUNT_ENDPOINT}?${new URLSearchParams({ api_key: apiKey })}`);
  if (res.status === 401) throw new SerpApiError('SERPAPI_AUTH', 'SerpApi 키가 올바르지 않습니다.', 502);
  if (!res.ok || !body) throw new SerpApiError('SERPAPI_ERROR', `SerpApi 계정 조회 오류 (HTTP ${res.status})`, 502);
  return summarizeAccount(body);
}

module.exports = {
  SerpApiError,
  buildOneWaySearchParams,
  normalizeOneWayResults,
  searchOneWay,
  summarizeAccount,
  fetchAccountSummary
};
