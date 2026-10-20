/**
 * Travelpayouts(Aviasales) 데이터 API — 다른 이용자들이 최근 검색한 결과에서 모은 실제 운임 (실시간 아님)
 * - 공식 문서(2026-09-06 갱신): /aviasales/v3/prices_for_dates, 분당 600회 한도(일·월 한도 없음), 최근 48시간 검색 기준, 최대 7일 보관
 * - 원하는 날짜에 자료가 없으면 가까운 다른 날짜를 대신 돌려주므로, 받은 날짜가 요청한 달 안인지 다시 거른다
 * - 원화(krw)는 공식 통화 목록에 없어, 응답 통화가 원화가 아니면 공개 환율표(1단위당 루블)로 환산한다
 * - 토큰은 X-Access-Token 헤더로만 보낸다 (주소·로그에 남지 않게)
 */
const { createTtlCache } = require('./cache');
const { cleanText } = require('./text');
const { AIRLINE_CODE_TO_NAME } = require('./engine/config/airports');

const API_BASE = 'https://api.travelpayouts.com';
const RATES_URL = 'https://yasen.aviasales.com/adaptors/currency.json';
const AIRLINES_URL = `${API_BASE}/data/ko/airlines.json`;
const TICKETS_TTL_MS = 2 * 3600000; // 원본이 최근 48시간 검색이라 2시간 캐시로 충분하다
const RATES_TTL_MS = 12 * 3600000;
const AIRLINES_TTL_MS = 24 * 3600000;
const UPSTREAM_TIMEOUT_MS = 15000;

class TravelpayoutsError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'TravelpayoutsError';
    this.code = code;
    this.status = status;
  }
}

function errorForStatus(status) {
  if (status === 401 || status === 403) return new TravelpayoutsError('TP_AUTH', 'Travelpayouts 토큰이 올바르지 않습니다.', 502);
  if (status === 429) {
    return new TravelpayoutsError('TP_RATE_LIMIT', 'Travelpayouts 분당 조회 한도를 넘었습니다. 1분 뒤 다시 시도하세요.', 429);
  }
  return new TravelpayoutsError('TP_ERROR', `Travelpayouts 오류 (HTTP ${status})`, 502);
}

async function getJson(fetchImpl, url, headers = {}) {
  let res;
  try {
    res = await fetchImpl(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  } catch {
    throw new TravelpayoutsError('TP_NETWORK', 'Travelpayouts 에 연결하지 못했습니다.', 502);
  }
  if (!res.ok) throw errorForStatus(res.status);
  try {
    return await res.json();
  } catch {
    throw new TravelpayoutsError('TP_ERROR', 'Travelpayouts 응답을 읽지 못했습니다.', 502);
  }
}

function buildTicketParams({ origin, destination, month, direct, unique, market }) {
  const params = new URLSearchParams({
    departure_at: month,
    one_way: 'true',
    direct: direct ? 'true' : 'false',
    unique: unique ? 'true' : 'false',
    sorting: 'price',
    limit: '1000',
    page: '1',
    currency: 'krw'
  });
  if (origin) params.set('origin', origin);
  if (destination) params.set('destination', destination);
  if (market) params.set('market', market);
  return params;
}

// 응답의 link 는 Aviasales 검색 경로 ('/search/…' 또는 '/…') — 화면의 '가격 출처 Aviasales' 링크(그 편의 판매처 목록)로 쓴다
function aviasalesUrl(link) {
  const path = String(link || '').replace(/^\/(search\/)?/, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9/?=&_.%:-]*$/.test(path)) return null;
  return `https://www.aviasales.com/search/${path}`;
}

const DAY_MS = 86400000;
const MAX_SEARCH_AGE_DAYS = 366;

// link 의 search_date(일월년 8자리) = 그 값이 Aviasales 에서 검색된 날 → 'YYYY-MM-DD'
// 문서는 '최근 48시간' 이라지만 실제로는 며칠 묵은 값이 많아(10-19 TOP 30 의 65% 가 하루 넘음) 화면에 그대로 보여 준다
// 없거나 없는 날짜(09-31 등)면 null. 한국보다 늦은 시간대의 날짜라 하루 앞선 날까지는 받고, 그보다 뒤·1년보다 앞은
// 형식만 맞는 엉뚱한 값으로 보고 null (화면에 '오늘'·'수백 일 전' 으로 보이지 않게)
function searchedOnFromLink(link, now = Date.now()) {
  const m = /[?&]search_date=(\d{2})(\d{2})(\d{4})(?=&|$)/.exec(String(link || ''));
  if (!m) return null;
  const iso = `${m[3]}-${m[2]}-${m[1]}`;
  const at = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(at) || new Date(at).toISOString().slice(0, 10) !== iso) return null;
  return at <= now + DAY_MS && at >= now - MAX_SEARCH_AGE_DAYS * DAY_MS ? iso : null;
}

const IATA = /^[A-Z]{3}$/;

function normalizeTicket(item, krwPerUnit, month, now) {
  if (!item || item.return_at) return null; // 왕복 묶음 가격은 편도 계산에 쓰지 않는다
  const departureAt = String(item.departure_at || '');
  const date = departureAt.slice(0, 10); // 현지 시각 그대로의 날짜 (UTC 로 바꾸지 않는다)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.slice(0, 7) !== month) return null;
  const price = Number(item.price) * krwPerUnit;
  if (!Number.isFinite(price) || price <= 0) return null;

  const originCity = String(item.origin || '').toUpperCase();
  const destinationCity = String(item.destination || '').toUpperCase();
  const originAirport = String(item.origin_airport || originCity).toUpperCase();
  const destinationAirport = String(item.destination_airport || destinationCity).toUpperCase();
  if (!IATA.test(originAirport) || !IATA.test(destinationAirport)) return null;

  const airlineCode = String(item.airline || '').toUpperCase();
  const safeAirline = /^[A-Z0-9]{2}$/.test(airlineCode) ? airlineCode : '';
  const number = String(item.flight_number ?? '');
  const time = departureAt.slice(11, 16);
  return {
    originAirport,
    destinationAirport,
    originCity: IATA.test(originCity) ? originCity : '',
    destinationCity: IATA.test(destinationCity) ? destinationCity : '',
    date,
    departureTime: /^\d{2}:\d{2}$/.test(time) ? time : '',
    priceKrw: Math.round(price),
    airlineCode: safeAirline,
    flightNumber: safeAirline && /^\d{1,4}[A-Z]?$/.test(number) ? `${safeAirline}${number}` : '',
    transfers: Math.max(0, Math.floor(Number(item.transfers) || 0)),
    durationMinutes: Math.max(0, Math.floor(Number(item.duration_to || item.duration) || 0)),
    sourceUrl: aviasalesUrl(item.link),
    searchedOn: searchedOnFromLink(item.link, now)
  };
}

function normalizeTickets(body, krwPerUnit, { month, now = Date.now() }) {
  const list = Array.isArray(body?.data) ? body.data : [];
  return list.map((item) => normalizeTicket(item, krwPerUnit, month, now)).filter(Boolean);
}

function createTravelpayoutsClient({ token, fetchImpl = fetch, market = '', cache = createTtlCache({ maxEntries: 3000 }), now = Date.now }) {
  async function krwPerUnit(currency) {
    const code = String(currency || '').toLowerCase();
    if (code === 'krw') return 1;
    if (!/^[a-z]{3}$/.test(code)) {
      throw new TravelpayoutsError('TP_ERROR', 'Travelpayouts 응답의 통화를 알 수 없습니다.', 502);
    }
    const { value: rates } = await cache.getOrLoad('rates', RATES_TTL_MS, () => getJson(fetchImpl, RATES_URL));
    const from = Number(rates?.[code]);
    const krw = Number(rates?.krw);
    if (!(from > 0) || !(krw > 0)) {
      throw new TravelpayoutsError('TP_ERROR', `환율표에 ${code} 가 없어 원화로 바꾸지 못했습니다.`, 502);
    }
    return from / krw;
  }

  // 편도 운임 목록 → { value: 표[], cached, storedAt } (도착지를 비우면 그 공항에서 가는 모든 곳)
  function fetchTickets({ origin = '', destination = '', month, direct = false, unique = false }) {
    const params = buildTicketParams({ origin, destination, month, direct, unique, market });
    return cache.getOrLoad(`tickets|${params}`, TICKETS_TTL_MS, async () => {
      const body = await getJson(fetchImpl, `${API_BASE}/aviasales/v3/prices_for_dates?${params}`, {
        'X-Access-Token': token
      });
      if (!body || body.success === false) {
        throw new TravelpayoutsError('TP_ERROR', 'Travelpayouts 가 조회를 거절했습니다.', 502);
      }
      return normalizeTickets(body, await krwPerUnit(body.currency), { month, now: now() });
    });
  }

  // 항공사 이름: 앱의 한국어 이름표 → Travelpayouts 공개 목록의 이름(대개 영어) → 코드
  async function resolveAirlineNames(codes) {
    const unique = [...new Set(codes.filter(Boolean))];
    let published = new Map();
    if (unique.some((code) => !AIRLINE_CODE_TO_NAME[code])) {
      try {
        ({ value: published } = await cache.getOrLoad('airlines', AIRLINES_TTL_MS, async () => {
          const list = await getJson(fetchImpl, AIRLINES_URL);
          return new Map(
            (Array.isArray(list) ? list : []).map((a) => [String(a?.code || ''), cleanText(a?.name || a?.name_translations?.en)])
          );
        }));
      } catch {
        published = new Map(); // 이름 목록을 못 받아도 가격 조회는 계속한다
      }
    }
    return new Map(unique.map((code) => [code, AIRLINE_CODE_TO_NAME[code] || published.get(code) || code]));
  }

  return { fetchTickets, resolveAirlineNames };
}

module.exports = {
  TravelpayoutsError,
  createTravelpayoutsClient,
  normalizeTickets,
  aviasalesUrl,
  searchedOnFromLink,
  buildTicketParams
};
