/**
 * 실제 운임 프록시 라우터 — Vercel 함수(api/index.js)와 로컬 개발 서버(dev-server.js)가 같이 쓴다
 * 처리 순서: CORS(허용된 사이트만) → PIN(X-Access-Pin, 틀리면 잠금) → 입력 검증 → 상류 API(키는 서버 환경 변수에만)
 *
 *   POST /api/session                  PIN 확인 + 공급자 설정 여부
 *   GET  /api/status                   SerpApi 남은 검색 횟수
 *   GET  /api/flights                  구글 플라이트(SerpApi) 실시간 편도 두 번 — 알림 규칙 조회용
 *   GET  /api/anywhere-top10           Travelpayouts TOP 30
 *   GET  /api/route-stats              Travelpayouts 앞으로 12개월 월별·요일별 시세
 *   GET  /api/return-date-matrix       Travelpayouts 귀국일표   ┐
 *   GET  /api/schedule-recommendations Travelpayouts 추천 일정  ├ 앱과 같은 엔진(사본)에 실제 운임 캘린더를 넣어 계산
 *   GET  /api/route-price-trend        Travelpayouts 가격 추이  ┘
 */
const { createPinGuard, clientIpOf, createIpTagger } = require('./auth');
const { parseAllowedOrigins, sendJson, applyCors } = require('./http');
const { parseIata, parseDate, parseIntInRange, parseBool, daysBetween } = require('./validate');
const { createTtlCache } = require('./cache');
const { cleanText } = require('./text');
const { searchOneWay, fetchAccountSummary, SerpApiError } = require('./serpapi');
const { createTravelpayoutsClient, TravelpayoutsError } = require('./travelpayouts');
const {
  FARE_SOURCE: TRAVELPAYOUTS_SOURCE,
  addDays,
  monthsBetween,
  trendMonths,
  koreanOriginsFor,
  buildRouteCalendar,
  airlineCodesIn,
  makeFareQuote,
  computeRouteStats
} = require('./fares');
const { composeAnywhereTop30 } = require('./top30');
const airports = require('./engine/config/airports');
const engine = require('./engine/services/flightApiService');

const SERPAPI_SOURCE = 'SERPAPI_GOOGLE_FLIGHTS';
// SerpApi 무료 한도(월 250회)를 아끼려고 같은 조건은 20분 동안 다시 검색하지 않는다 (SerpApi 자체도 1시간 캐시)
const SERPAPI_TTL_MS = 20 * 60 * 1000;
const ACCOUNT_TTL_MS = 60 * 1000;
const DEFAULT_FAILURE_DELAY_MS = 400; // 틀린 PIN 응답을 늦춰 추측 속도를 줄인다
const MAX_SERPAPI_CANDIDATES = 12;
const KOREAN_CODES = airports.INDIVIDUAL_KOREAN_AIRPORTS.map((a) => a.code);
const REGIONS = ['ALL', '일본', '동남아', '중화권', '미주/대양주', '유럽'];
const ROUTE_STATS_MONTHS = 12;
// 요청 하나가 Travelpayouts 를 새로 부를 수 있는 시간 (상류 한 번 최대 15초 + 함수 60초·화면 58초 제한 안에 일부라도 돌려주게)
const PROXY_TIME_BUDGET_MS = 40000;

class RequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const badRequest = (message) => new RequestError(400, 'BAD_REQUEST', message);

function required(result, label) {
  if (!result.ok) throw badRequest(`${label}: ${result.error}`);
  return result.value;
}

// 한국 시간 기준 오늘 (화면의 날짜 선택과 같은 기준)
function todayKst(now) {
  return new Date(now() + 9 * 3600000).toISOString().slice(0, 10);
}

function parseRouteQuery(q, today) {
  const origin = String(q.origin || '').toUpperCase() === 'ALL_KOREA' ? 'ALL_KOREA' : required(parseIata(q.origin), '출발 공항');
  if (origin !== 'ALL_KOREA' && !KOREAN_CODES.includes(origin)) throw badRequest('출발 공항은 한국 공항이어야 합니다.');
  const destination = required(parseIata(q.destination), '도착 공항');
  if (KOREAN_CODES.includes(destination)) throw badRequest('국제선 도착 공항을 고르세요.');
  return {
    origin,
    destination,
    directOnly: required(parseBool(q.directOnly, true), '직항만'),
    customCityName: cleanText(q.customCityName, 30),
    today
  };
}

function parsePassengers(q) {
  const adults = required(parseIntInRange(q.adults, { min: 1, max: 9, fallback: 1 }), '성인');
  const children = required(parseIntInRange(q.children, { min: 0, max: 9, fallback: 0 }), '소아');
  const infants = required(parseIntInRange(q.infants, { min: 0, max: adults, fallback: 0 }), '유아');
  return { adults, children, infants };
}

function parseTrip(q, today) {
  const departureDate = required(parseDate(q.departureDate, { today }), '출발일');
  const returnDate = required(parseDate(q.returnDate, { today }), '귀국일');
  if (returnDate < departureDate) throw badRequest('귀국일은 출발일 이후여야 합니다.');
  return { departureDate, returnDate };
}

function realMeta(cal) {
  return { realFare: true, fareSource: TRAVELPAYOUTS_SOURCE, fetchedAt: cal.fetchedAt, partial: cal.partial };
}

// log: Vercel 은 함수의 console 출력을 프로젝트 Logs 에 남긴다 (테스트는 가짜 log 를 넘긴다)
function createRouter({ env = {}, fetchImpl = fetch, now = Date.now, failureDelayMs = DEFAULT_FAILURE_DELAY_MS, log = console } = {}) {
  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  const pinGuard = createPinGuard({ pin: env.ACCESS_PIN, now });
  const ipTag = createIpTagger();
  const serpapiKey = env.SERPAPI_KEY || '';
  const serpCache = createTtlCache({ maxEntries: 300, now });
  const tp = env.TRAVELPAYOUTS_TOKEN
    ? createTravelpayoutsClient({
        token: env.TRAVELPAYOUTS_TOKEN,
        fetchImpl,
        market: env.TRAVELPAYOUTS_MARKET || '',
        cache: createTtlCache({ maxEntries: 4000, now })
      })
    : null;

  const providers = () => ({ serpapi: Boolean(serpapiKey), travelpayouts: Boolean(tp) });

  function requireSerpapi() {
    if (!serpapiKey) throw new RequestError(503, 'PROVIDER_NOT_CONFIGURED', '구글 플라이트(SerpApi) 키가 아직 설정되지 않았습니다.');
  }

  function requireTravelpayouts() {
    if (!tp) throw new RequestError(503, 'PROVIDER_NOT_CONFIGURED', 'Travelpayouts 토큰이 아직 설정되지 않았습니다.');
    return tp;
  }

  async function routeQuote({ origin, destination, months, directOnly, deadline = null }) {
    const client = requireTravelpayouts();
    const cal = await buildRouteCalendar(client, {
      originCodes: koreanOriginsFor(origin, destination),
      destination,
      months,
      direct: directOnly,
      deadline
    });
    const airlineNames = await client.resolveAirlineNames(airlineCodesIn(cal.calendar));
    return { cal, fareQuote: makeFareQuote({ calendar: cal.calendar, destination, airlineNames }) };
  }

  function serpSearch({ from, to, date, nonstop }) {
    return serpCache.getOrLoad(`${from}>${to}|${date}|${nonstop}`, SERPAPI_TTL_MS, () =>
      searchOneWay({ apiKey: serpapiKey, fetchImpl, from, to, date, nonstop })
    );
  }

  const routes = {
    session: {
      method: 'POST',
      run: async () => ({ ok: true, providers: providers() })
    },

    status: {
      method: 'GET',
      run: async () => {
        let serpapi = { configured: false };
        if (serpapiKey) {
          try {
            const { value } = await serpCache.getOrLoad('account', ACCOUNT_TTL_MS, () => fetchAccountSummary({ apiKey: serpapiKey, fetchImpl }));
            serpapi = { configured: true, account: value };
          } catch (err) {
            serpapi = { configured: true, error: err.code || 'SERPAPI_ERROR' };
          }
        }
        return { providers: providers(), serpapi, travelpayouts: { configured: Boolean(tp) } };
      }
    },

    flights: {
      method: 'GET',
      run: async (q, today) => {
        const route = parseRouteQuery(q, today);
        const { departureDate, returnDate } = parseTrip(q, today);
        requireSerpapi();
        const koreans = koreanOriginsFor(route.origin, route.destination).join(',');
        const nonstop = route.directOnly;
        const [out, back] = await Promise.all([
          serpSearch({ from: koreans, to: route.destination, date: departureDate, nonstop }),
          serpSearch({ from: route.destination, to: koreans, date: returnDate, nonstop })
        ]);
        const searchedAt = [out, back].map((r) => Date.parse(r.value.searchedAt) || r.storedAt);
        const leg = (r) => ({
          candidates: r.value.candidates.slice(0, MAX_SERPAPI_CANDIDATES),
          cached: r.cached
        });
        return {
          realFare: true,
          fareSource: SERPAPI_SOURCE,
          fetchedAt: new Date(Math.min(...searchedAt)).toISOString(),
          origin: route.origin,
          destination: route.destination,
          departureDate,
          returnDate,
          directOnly: route.directOnly,
          outbound: leg(out),
          inbound: leg(back)
        };
      }
    },

    'anywhere-top10': {
      method: 'GET',
      run: async (q, today, { deadline } = {}) => {
        const origin = String(q.origin || 'ALL_KOREA').toUpperCase() === 'ALL_KOREA' ? 'ALL_KOREA' : required(parseIata(q.origin), '출발 공항');
        if (origin !== 'ALL_KOREA' && !KOREAN_CODES.includes(origin)) throw badRequest('출발 공항은 한국 공항이어야 합니다.');
        const region = q.region || 'ALL';
        if (!REGIONS.includes(region)) throw badRequest('권역 값이 올바르지 않습니다.');
        const directOnly = required(parseBool(q.directOnly, true), '직항만');
        return composeAnywhereTop30(requireTravelpayouts(), { origin, region, directOnly, ...parsePassengers(q), today, deadline });
      }
    },

    'route-stats': {
      method: 'GET',
      run: async (q, today, { deadline } = {}) => {
        const route = parseRouteQuery(q, today);
        // 이번 달부터 12개월 (341일 뒤는 언제나 11~12개월 뒤 달이라 앞에서 12개만 쓴다)
        const months = monthsBetween(today, addDays(today, 31 * (ROUTE_STATS_MONTHS - 1))).slice(0, ROUTE_STATS_MONTHS);
        const { cal } = await routeQuote({ ...route, months, deadline });
        return {
          ...realMeta(cal),
          origin: route.origin,
          destination: route.destination,
          directOnly: route.directOnly,
          months,
          ...computeRouteStats({ calendar: cal.calendar, months })
        };
      }
    },

    'return-date-matrix': {
      method: 'GET',
      run: async (q, today, { deadline } = {}) => {
        const route = parseRouteQuery(q, today);
        const departureDate = required(parseDate(q.departureDate, { today }), '출발일');
        const maxStayDays = required(parseIntInRange(q.maxStayDays, { min: 3, max: 14, fallback: 10 }), '최대 체류일');
        const months = monthsBetween(departureDate, addDays(departureDate, maxStayDays));
        const { cal, fareQuote } = await routeQuote({ ...route, months, deadline });
        const matrix = engine.getReturnDatePriceMatrix({ ...route, ...parsePassengers(q), departureDate, maxStayDays, fareQuote });
        return {
          ...matrix,
          ...realMeta(cal),
          benchmark2Y: null,
          returnOptions: matrix.returnOptions.map((o) => ({ ...o, discountVs2YAvgPercent: null, priceGrade: null }))
        };
      }
    },

    'schedule-recommendations': {
      method: 'GET',
      run: async (q, today, { deadline } = {}) => {
        const route = parseRouteQuery(q, today);
        const minNights = required(parseIntInRange(q.minNights, { min: 1, max: 30, fallback: 2 }), '최소 박수');
        const maxNights = required(parseIntInRange(q.maxNights, { min: minNights, max: 30, fallback: Math.max(minNights, 5) }), '최대 박수');
        // 엔진은 오늘+7일 ~ 오늘+52일 출발을 훑는다
        const months = monthsBetween(addDays(today, 7), addDays(today, 52 + maxNights));
        const { cal, fareQuote } = await routeQuote({ ...route, months, deadline });
        const rec = engine.getRecommendedCheapSchedules({ ...route, ...parsePassengers(q), minNights, maxNights, limit: 6, fareQuote, departureStepDays: 1 });
        return {
          ...rec,
          ...realMeta(cal),
          benchmark2Y: null,
          recommendations: rec.recommendations.map((r) => ({ ...r, discountVs2YAvgPercent: null, vsLowest2YDiffKrw: null }))
        };
      }
    },

    'route-price-trend': {
      method: 'GET',
      run: async (q, today, { deadline } = {}) => {
        const route = parseRouteQuery(q, today);
        const departureDate = q.departureDate ? required(parseDate(q.departureDate, { today }), '출발일') : addDays(today, 21);
        const returnDate = q.returnDate ? required(parseDate(q.returnDate, { today }), '귀국일') : '';
        const stay = returnDate && returnDate >= departureDate ? daysBetween(departureDate, returnDate) : 3;
        // 출발일이 가까우면 엔진이 시작일을 내일로 당겨 그리므로, 그 범위의 달을 받는다
        const months = trendMonths({ departureDate, stayNights: stay, today });
        const { cal, fareQuote } = await routeQuote({ ...route, months, deadline });
        const trend = engine.getRoutePriceTrend({ ...route, ...parsePassengers(q), departureDate, returnDate, fareQuote });
        return { ...trend, ...realMeta(cal), benchmark2Y: null };
      }
    }
  };

  function routeNameOf(req) {
    const url = new URL(req.url || '/', 'http://localhost');
    const fromPath = url.pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '');
    return fromPath || url.searchParams.get('route') || '';
  }

  function errorBody(err) {
    if (err instanceof RequestError) return [err.status, { error: err.message, code: err.code }];
    if (err instanceof SerpApiError || err instanceof TravelpayoutsError) return [err.status || 502, { error: err.message, code: err.code }];
    // 예상하지 못한 오류는 내용(주소·키가 섞일 수 있는 메시지)을 밖으로 내보내지 않는다
    log.error('[fare-proxy] 처리 오류:', err?.name || 'Error');
    return [500, { error: '프록시 처리 중 오류가 났습니다.', code: 'INTERNAL' }];
  }

  return async function handle(req, res) {
    if (applyCors(req, res, allowedOrigins)) return;

    const name = routeNameOf(req);
    const route = Object.prototype.hasOwnProperty.call(routes, name) ? routes[name] : null;
    if (!route) return sendJson(res, 404, { error: '없는 경로입니다.', code: 'NOT_FOUND' });
    if (req.method !== route.method) return sendJson(res, 405, { error: '허용되지 않은 요청 방식입니다.', code: 'METHOD_NOT_ALLOWED' });

    const ip = clientIpOf(req);
    const pin = pinGuard.check(ip, String(req.headers['x-access-pin'] || ''));
    if (!pin.ok) {
      if (pin.status === 503) return sendJson(res, 503, { error: '프록시에 PIN 이 설정되지 않았습니다.', code: 'PIN_NOT_CONFIGURED' });
      if (pin.status === 429) {
        res.setHeader('Retry-After', String(pin.retryAfterSec));
        return sendJson(res, 429, { error: `PIN 을 여러 번 틀려 잠겼습니다. ${Math.ceil(pin.retryAfterSec / 60)}분 뒤 다시 시도하세요.`, code: 'PIN_LOCKED', retryAfterSec: pin.retryAfterSec });
      }
      // 추측 시도를 주인이 알 수 있게 남긴다 — 넣은 PIN 과 IP 원문은 남기지 않는다
      log.warn('[fare-proxy] PIN 실패', JSON.stringify({ ip: ipTag(ip), ipFailures: pin.ipFailures, recentFailures: pin.recentFailures, lock: pin.lock }));
      if (failureDelayMs > 0) await new Promise((r) => setTimeout(r, failureDelayMs));
      return sendJson(res, 401, { error: 'PIN 이 맞지 않습니다.', code: 'PIN_INVALID' });
    }

    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const query = Object.fromEntries(url.searchParams.entries());
      const deadline = Date.now() + PROXY_TIME_BUDGET_MS; // 실제 경과 시간 기준 (now 는 날짜·캐시용)
      return sendJson(res, 200, await route.run(query, todayKst(now), { deadline }));
    } catch (err) {
      const [status, body] = errorBody(err);
      return sendJson(res, status, body);
    }
  };
}

module.exports = { createRouter };
