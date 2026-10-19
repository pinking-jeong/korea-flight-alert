/**
 * 항공권 탐색 엔진 v2.1
 * 1) 출국 편도(Outbound) + 귀국 편도(Inbound) 개별 조회 후 최저가 조합 합산 (Mix & Match)
 * 2) 70개+ 전 세계 도시 및 사용자 직접 입력(Custom IATA/도시명) 완벽 지원
 * 3) 도시 미지정 시 '향후 6개월(180일) 이내 전 노선 초특가 항공편 Top 10' 자동 선정
 * 4) 단일 출발일 지정 시 돌아오는 일정별(1박 2일 ~ 10박 11일) 귀국 편도 및 합산 가격 매트릭스
 * 5) 특정 노선 향후 60일 내 가장 저렴한 추천 일정 Top 6 자동 탐색
 */

const {
  INDIVIDUAL_KOREAN_AIRPORTS,
  INTERNATIONAL_DESTINATIONS,
  getOriginByCode,
  getEligibleKoreanOriginsForDestination,
  getDestinationByCode,
  calculatePassengerPricing,
  getAirlineOfficialBookingUrl,
  buildBookingLinks
} = require('../config/airports');

let amadeusTokenCache = {
  accessToken: null,
  expiresAt: 0
};

// 가격의 출처(sourceApi)는 세 갈래다. 목록에 없는 출처는 계산식으로 만든 모의 값이라 예약 사이트 가격과 다르다
// - 실시간: 조회한 그 순간의 실제 운임 (구글 플라이트 = SerpApi 프록시, Amadeus 운영 환경)
//   Amadeus 테스트 환경은 공식 안내상 '제한된 캐시 데이터'라 운영 환경 결과(AMADEUS_ONEWAY_COMBO)만 친다
// - 검색 캐시: 다른 이용자들이 최근(최대 며칠 전) 검색한 결과에서 모은 실제 운임 (Travelpayouts 프록시)
const LIVE_FARE_SOURCE_APIS = ['AMADEUS_ONEWAY_COMBO', 'SERPAPI_GOOGLE_FLIGHTS'];
const CACHED_FARE_SOURCE_APIS = ['TRAVELPAYOUTS_PRICES'];

// 브라우저(프록시)가 넘겨주는 외부 운임의 출처와 조회 기록용 이름
const EXTERNAL_FARE_PROVIDERS = {
  SERPAPI_GOOGLE_FLIGHTS: 'SERPAPI',
  TRAVELPAYOUTS_PRICES: 'TRAVELPAYOUTS'
};

function describeFareSource(sourceApi) {
  if (LIVE_FARE_SOURCE_APIS.includes(sourceApi)) return 'LIVE';
  if (CACHED_FARE_SOURCE_APIS.includes(sourceApi)) return 'CACHED';
  return 'SIMULATED';
}

function isSimulatedFareSource(sourceApi) {
  return describeFareSource(sourceApi) === 'SIMULATED';
}

// 가격 추이 차트가 실제 일정 그대로 계산하는 최대 체류 박수 (이보다 길거나 날짜가 거꾸로면 3박 기준)
const MAX_TREND_STAY_NIGHTS = 365;
// 추천 일정 탐색의 최대 박수 (화면은 2~5박; API로 들어온 큰 값이 서버를 오래 붙잡지 않게)
const MAX_RECOMMENDED_STAY_NIGHTS = 30;

const AIRLINE_NAME_MAP = {
  KE: '대한항공',
  OZ: '아시아나항공',
  '7C': '제주항공',
  LJ: '진에어',
  TW: '트리니티항공',
  YP: '에어프레미아',
  BX: '에어부산',
  ZE: '이스타항공',
  RS: '에어서울',
  RF: '에어로케이',
  MM: '피치항공',
  NH: '전일본공수(ANA)',
  JL: '일본항공(JAL)',
  VJ: '비엣젯항공',
  VN: '베트남항공',
  TG: '타이항공',
  SQ: '싱가포르항공',
  TR: '스쿠트항공',
  '5J': '세부퍼시픽',
  BR: '에바항공',
  CI: '중화항공',
  CX: '캐세이퍼시픽',
  UO: '홍콩익스프레스',
  GA: '가루다인도네시아',
  JQ: '젯스타항공',
  TK: '터키항공'
};

const DAY_NAMES_KO = ['일', '월', '화', '수', '목', '금', '토'];

function getDayOfWeekKo(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  return DAY_NAMES_KO[d.getDay()] || '';
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * 날짜/노선/항공사 시드 기반 편도 후보군 산출
 * - origin === 'ALL_KOREA' 인 경우 해당 목적지에 취항하는 대한민국 전체 공항을 포괄 탐색하여 최저가순 반환
 */
function computeOneWayCandidateOffers({
  origin,
  destination,
  dateStr,
  direction = 'OUTBOUND',
  directOnly = true,
  adults = 1,
  children = 0,
  infants = 0,
  jitterRatio = 0,
  customDestinations = [],
  customCityName = ''
}) {
  const destMeta = getDestinationByCode(destination, customDestinations, customCityName);

  // 대한민국 전체 공항 통합(ALL_KOREA) 선택 시 취항 가능한 한국 공항 전체를 순회하여 최저가 후보군 통합
  if (origin === 'ALL_KOREA') {
    const eligibleOrigins = getEligibleKoreanOriginsForDestination(destMeta);
    const merged = [];
    for (const korAirport of eligibleOrigins) {
      const subCandidates = computeOneWayCandidateOffers({
        origin: korAirport.code,
        destination,
        dateStr,
        direction,
        directOnly,
        adults,
        children,
        infants,
        jitterRatio,
        customDestinations,
        customCityName
      });
      merged.push(...subCandidates);
    }
    merged.sort((a, b) => a.oneWayPriceKrw - b.oneWayPriceKrw);
    return merged;
  }

  const originMeta = getOriginByCode(origin);
  const b2y = destMeta.benchmark2Y || {};
  const baseOneWay =
    direction === 'OUTBOUND'
      ? b2y.outboundAvgOneWayKrw || Math.round((destMeta.basePriceKrw || 280000) * 0.49)
      : b2y.inboundAvgOneWayKrw || Math.round((destMeta.basePriceKrw || 280000) * 0.51);

  const d = new Date(`${dateStr}T00:00:00`);
  const dow = d.getDay();
  const dayNum = d.getDate();
  const monthNum = d.getMonth() + 1;

  // 요일별 가중치: 화/수 최저, 주말 할증
  let dowFactor = 1.0;
  if (direction === 'OUTBOUND') {
    if (dow === 2 || dow === 3) dowFactor = 0.78;
    else if (dow === 1 || dow === 4) dowFactor = 0.86;
    else if (dow === 0) dowFactor = 0.93;
    else if (dow === 5 || dow === 6) dowFactor = 1.12;
  } else {
    if (dow === 2 || dow === 3 || dow === 4) dowFactor = 0.79;
    else if (dow === 1 || dow === 5) dowFactor = 0.88;
    else if (dow === 6) dowFactor = 0.96;
    else if (dow === 0) dowFactor = 1.14;
  }

  // 비수기 월(3, 5, 6, 9, 11월) 추가 프로모션 계수 반영
  const offPeakMonths = [3, 5, 6, 9, 11];
  const seasonFactor = offPeakMonths.includes(monthNum) ? 0.91 : monthNum === 7 || monthNum === 8 || monthNum === 12 ? 1.09 : 0.97;

  const codeSum = destination
    .split('')
    .reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const originSeed = origin
    .split('')
    .reduce((acc, ch) => acc + ch.charCodeAt(0), 0);

  // 도착 도시별 최적 한국 출발 공항 가중치 (인천·김포·김해·청주·대구·제주·무안 노선별 특가 우위 반영)
  const routeOriginMod = ((codeSum * 13 + originSeed * 19) % 17) / 100; // 0.00 ~ 0.16
  const originFactor = 0.88 + routeOriginMod;
  const directFactor = directOnly ? 1.0 : 0.88;

  const airlines = destMeta.airlines || [
    { code: '7C', name: '제주항공', baggage: '위탁 15kg 포함', outTime: '08:10 → 11:00', inTime: '12:00 → 15:00' },
    { code: 'TW', name: '트리니티항공', baggage: '위탁 15kg 포함', outTime: '09:30 → 12:20', inTime: '14:00 → 17:00' },
    { code: 'KE', name: '대한항공', baggage: '위탁 23kg 포함', outTime: '10:15 → 13:05', inTime: '16:00 → 19:00' }
  ];

  const safeAdults = Math.max(1, Number(adults) || 1);
  const safeChildren = Math.max(0, Number(children) || 0);
  const safeInfants = Math.max(0, Math.min(safeAdults, Number(infants) || 0));

  const depCompact = (dateStr || '').replace(/-/g, '');
  const legFrom = direction === 'OUTBOUND' ? origin : destination;
  const legTo = direction === 'OUTBOUND' ? destination : origin;
  const paxParts = [`adult=${safeAdults}`];
  if (safeChildren > 0) paxParts.push(`child=${safeChildren}`);
  if (safeInfants > 0) paxParts.push(`infant=${safeInfants}`);
  paxParts.push(`isDirect=${directOnly ? 'true' : 'false'}`);
  paxParts.push('fareType=Y');
  const naverOneWayUrl = `https://flight.naver.com/flights/international/${legFrom}-${legTo}-${depCompact}?${paxParts.join('&')}`;

  const candidates = airlines.map((airline, idx) => {
    const hashSeed =
      (dayNum * 17 + monthNum * 31 + idx * 43 + originSeed * 7 + (direction === 'OUTBOUND' ? 7 : 19) + codeSum) % 29;
    const airlinePromoFactor = 0.78 + (hashSeed / 29) * 0.34;
    const fscPenalty = airline.code === 'KE' || airline.code === 'OZ' || airline.code === 'SQ' ? 1.12 : 1.0;

    const rawPrice =
      baseOneWay *
      dowFactor *
      seasonFactor *
      originFactor *
      directFactor *
      airlinePromoFactor *
      fscPenalty *
      (1 + jitterRatio);

    const oneWayPriceKrw = Math.max(38000, Math.round(rawPrice / 100) * 100);
    const flightNoBase = 101 + ((origin.charCodeAt(0) + codeSum + idx * 13) % 790);
    const flightNumber = `${airline.code}${direction === 'OUTBOUND' ? flightNoBase : flightNoBase + 1}`;

    return {
      direction,
      originAirportCode: originMeta.code,
      originAirportCity: originMeta.city,
      fromAirportCode: legFrom,
      toAirportCode: legTo,
      date: dateStr,
      dayOfWeekKo: getDayOfWeekKo(dateStr),
      airline: airline.name,
      airlineCode: airline.code,
      flightNumber,
      baggageInfo: airline.baggage || '위탁 15kg 포함',
      scheduleTime:
        direction === 'OUTBOUND'
          ? airline.outTime || '08:30 → 11:20'
          : airline.inTime || '13:30 → 16:30',
      oneWayPriceKrw,
      officialBookingUrl: getAirlineOfficialBookingUrl(airline.name, airline.code),
      naverOneWayUrl
    };
  });

  candidates.sort((a, b) => a.oneWayPriceKrw - b.oneWayPriceKrw);
  return candidates;
}

// 외부(프록시가 받아 온) 운임 후보 검증 기준 — 브라우저를 거쳐 들어오므로 형식·범위를 모두 다시 확인한다
const MAX_EXTERNAL_CANDIDATES = 20;
const MIN_ONE_WAY_FARE_KRW = 1000;
const MAX_ONE_WAY_FARE_KRW = 20000000;
const MAX_EXTERNAL_TEXT_LENGTH = 40;

function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// 화면·카톡에 그대로 찍히는 글자에서 태그·따옴표·제어 문자를 빼고 길이를 자른다
function cleanExternalText(value, maxLength = MAX_EXTERNAL_TEXT_LENGTH) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f<>"'`&]/g, '')
    .trim()
    .slice(0, maxLength);
}

// 프록시가 Travelpayouts link 로 만드는 Aviasales 검색 주소 (proxy/lib/travelpayouts.js aviasalesUrl 와 같은 모양만)
const AVIASALES_SEARCH_URL_PATTERN = /^https:\/\/www\.aviasales\.com\/search\/[A-Za-z0-9][A-Za-z0-9/?=&_.%:-]*$/;

// Travelpayouts 값을 검색한 날: 날짜 모양이고 1년(366일) 전 ~ 내일 사이만 (프록시와 같은 기준 — 이상한 값은 버린다)
function validSearchedOn(value, today) {
  const day = String(value || '');
  if (!isIsoDate(day)) return null;
  return day >= addDays(today, -366) && day <= addDays(today, 1) ? day : null;
}

function sanitizeExternalLeg(raw, { direction, date, koreanCodes, foreignCode, keepSourceUrl = false, today = kstToday() }) {
  if (!raw || typeof raw !== 'object') return null;
  const price = Number(raw.oneWayPriceKrw);
  if (!Number.isFinite(price) || price < MIN_ONE_WAY_FARE_KRW || price > MAX_ONE_WAY_FARE_KRW) return null;
  if (String(raw.date || '') !== date) return null;

  const from = String(raw.fromAirportCode || '').toUpperCase();
  const to = String(raw.toAirportCode || '').toUpperCase();
  const koreanSide = direction === 'OUTBOUND' ? from : to;
  const foreignSide = direction === 'OUTBOUND' ? to : from;
  if (!koreanCodes.includes(koreanSide) || foreignSide !== foreignCode) return null;

  const airlineCode = /^[A-Z0-9]{2,3}$/.test(String(raw.airlineCode || '')) ? String(raw.airlineCode) : '';
  const flightNumber = /^[A-Z0-9]{2,8}$/.test(String(raw.flightNumber || '')) ? String(raw.flightNumber) : '';
  const airline = cleanExternalText(raw.airline) || AIRLINE_NAME_MAP[airlineCode] || `${airlineCode || '확인 필요'} 항공`;
  const stops = Math.min(5, Math.max(0, Math.floor(Number(raw.stops) || 0)));

  return {
    direction,
    originAirportCode: koreanSide,
    originAirportCity: getOriginByCode(koreanSide).city,
    fromAirportCode: from,
    toAirportCode: to,
    date,
    dayOfWeekKo: getDayOfWeekKo(date),
    airline,
    airlineCode,
    flightNumber: flightNumber || `${airlineCode}편`,
    baggageInfo: '운임 규정 확인',
    scheduleTime: cleanExternalText(raw.scheduleTime, 24) || '시간 확인',
    stops,
    oneWayPriceKrw: Math.round(price),
    officialBookingUrl: getAirlineOfficialBookingUrl(airline, airlineCode),
    naverOneWayUrl: '',
    // Travelpayouts 값이 검색된 날 (프록시가 출처 링크에서 뽑음) — 알림 카드에 '며칠 전 값' 으로 보인다
    searchedOn: validSearchedOn(raw.searchedOn, today),
    ...(keepSourceUrl && AVIASALES_SEARCH_URL_PATTERN.test(String(raw.sourceUrl || '')) ? { sourceUrl: String(raw.sourceUrl) } : {})
  };
}

function sanitizeExternalLegs(list, context) {
  return (Array.isArray(list) ? list.slice(0, MAX_EXTERNAL_CANDIDATES) : [])
    .map((raw) => sanitizeExternalLeg(raw, context))
    .filter(Boolean)
    .sort((a, b) => a.oneWayPriceKrw - b.oneWayPriceKrw);
}

/**
 * 프록시가 받아 온 실제 편도 운임(가는 편·오는 편 목록)을 검증하고, 같은 한국 공항으로 오가는 짝 중 합계가 가장 싼 쪽을 고른다
 * - 전국 통합(ALL_KOREA)은 가는 편만 싼 공항이 아니라 왕복 합계가 싼 공항을 고른다
 */
function prepareExternalCandidates(external, { origin, destination, departureDate, returnDate }) {
  const sourceApi = String(external?.sourceApi || '');
  if (!EXTERNAL_FARE_PROVIDERS[sourceApi]) {
    throw codedError('BAD_FARE_SOURCE', '알 수 없는 운임 출처입니다.');
  }
  const koreanCodes =
    origin === 'ALL_KOREA' ? INDIVIDUAL_KOREAN_AIRPORTS.map((a) => a.code) : [String(origin).toUpperCase()];
  const foreignCode = String(destination).toUpperCase();
  const outList = sanitizeExternalLegs(external.outbound, { direction: 'OUTBOUND', date: departureDate, koreanCodes, foreignCode });
  const inList = sanitizeExternalLegs(external.inbound, { direction: 'INBOUND', date: returnDate, koreanCodes, foreignCode });

  let bestKoreanCode = null;
  let bestSum = Infinity;
  for (const out of outList) {
    const back = inList.find((item) => item.toAirportCode === out.fromAirportCode);
    if (back && out.oneWayPriceKrw + back.oneWayPriceKrw < bestSum) {
      bestSum = out.oneWayPriceKrw + back.oneWayPriceKrw;
      bestKoreanCode = out.fromAirportCode;
    }
  }
  if (!bestKoreanCode) {
    throw codedError('NO_REAL_FARES', '실제 운임 검색 결과가 없습니다 (가는 편·오는 편이 모두 있는 일정을 찾지 못함).');
  }

  const fetchedAt = Number.isNaN(Date.parse(external.fetchedAt)) ? null : new Date(external.fetchedAt).toISOString();
  return {
    sourceApi,
    usedProvider: EXTERNAL_FARE_PROVIDERS[sourceApi],
    fetchedAt,
    outCandidates: outList.filter((item) => item.fromAirportCode === bestKoreanCode),
    inCandidates: inList.filter((item) => item.toAirportCode === bestKoreanCode)
  };
}

// 같은 항공사 편도 두 장으로 오갈 때의 최저 합계 (없으면 null) — 실제 운임에는 계산식의 묶음 할증을 붙이지 않는다
function cheapestSameAirlinePairKrw(outCandidates, inCandidates) {
  let best = null;
  for (const out of outCandidates) {
    const back = inCandidates.find((item) => item.airlineCode && item.airlineCode === out.airlineCode);
    if (back && (best === null || out.oneWayPriceKrw + back.oneWayPriceKrw < best)) {
      best = out.oneWayPriceKrw + back.oneWayPriceKrw;
    }
  }
  return best;
}

// 날짜별 편도 후보를 내주는 함수: 기본은 계산식(모의), 실제 운임 캘린더 견적 함수가 오면 그것을 쓴다 (값 없는 날은 빈 목록)
function resolveFareQuote(fareQuote) {
  return typeof fareQuote === 'function' ? fareQuote : computeOneWayCandidateOffers;
}

// 전국 통합(ALL_KOREA) + 실제 운임 캘린더면 칸마다 같은 한국 공항 왕복 합계가 가장 싼 짝을 고른다
// (실제 값은 날짜·공항마다 드문드문해, 가는 편만 싼 공항을 먼저 정하면 더 싼 왕복이나 귀국일이 통째로 빠진다.
//  계산식(모의) 가격은 기존처럼 가는 편 최저 공항 기준)
function pairsByKoreanAirport(fareQuote, origin) {
  return typeof fareQuote === 'function' && origin === 'ALL_KOREA';
}

function cheapestSameAirportPair(outCandidates, inCandidates) {
  let best = null;
  for (const out of outCandidates) {
    const back = inCandidates.find((item) => item.originAirportCode === out.originAirportCode);
    if (back && (!best || out.oneWayPriceKrw + back.oneWayPriceKrw < best.out.oneWayPriceKrw + best.back.oneWayPriceKrw)) {
      best = { out, back };
    }
  }
  return best;
}

/**
 * Amadeus OAuth2 Access Token 발급
 */
// 서버는 Amadeus 를 저장소 잠금(withStoreLock) 안에서 부르므로, 멈춘 응답이 다른 쓰기(알림 등록·삭제)를 오래 막지 않게 끊는다
const AMADEUS_TIMEOUT_MS = 15000;

async function fetchAmadeus(url, options) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(AMADEUS_TIMEOUT_MS) });
  } catch (err) {
    if (err && err.name === 'TimeoutError') {
      throw new Error(`Amadeus 응답이 ${AMADEUS_TIMEOUT_MS / 1000}초 안에 오지 않음`);
    }
    throw err;
  }
}

async function getAmadeusAccessToken(clientId, clientSecret, env = 'test') {
  const now = Date.now();
  if (amadeusTokenCache.accessToken && amadeusTokenCache.expiresAt > now + 30000) {
    return amadeusTokenCache.accessToken;
  }

  const baseUrl = env === 'production' ? 'https://api.amadeus.com' : 'https://test.api.amadeus.com';
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret
  });

  const res = await fetchAmadeus(`${baseUrl}/v1/security/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Amadeus OAuth 인증 실패 (${res.status}): ${errText}`);
  }

  const data = await res.json();
  amadeusTokenCache = {
    accessToken: data.access_token,
    expiresAt: now + (data.expires_in || 1799) * 1000
  };
  return data.access_token;
}

/**
 * Amadeus 편도(One-Way) 개별 조회 함수
 */
async function fetchAmadeusOneWayLeg(
  { origin, destination, departureDate, adults = 1, children = 0, infants = 0, directOnly = true, direction = 'OUTBOUND' },
  settings
) {
  const baseUrl = settings.amadeusEnv === 'production' ? 'https://api.amadeus.com' : 'https://test.api.amadeus.com';
  const token = await getAmadeusAccessToken(
    settings.amadeusClientId,
    settings.amadeusClientSecret,
    settings.amadeusEnv
  );

  const params = new URLSearchParams({
    originLocationCode: origin,
    destinationLocationCode: destination,
    departureDate,
    adults: String(Math.max(1, Number(adults) || 1)),
    nonStop: directOnly ? 'true' : 'false',
    currencyCode: 'KRW',
    max: '10'
  });

  if (Number(children) > 0) params.set('children', String(Number(children)));
  if (Number(infants) > 0) params.set('infants', String(Number(infants)));

  const res = await fetchAmadeus(`${baseUrl}/v2/shopping/flight-offers?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Amadeus 편도 조회 실패 (${res.status}): ${errText}`);
  }

  const payload = await res.json();
  const offers = payload.data || [];
  if (!offers.length) {
    throw new Error(`Amadeus 편도 검색 결과 없음 (${origin}->${destination})`);
  }

  const carriersDict = payload.dictionaries?.carriers || {};
  const formatTime = (isoStr) => (isoStr ? isoStr.slice(11, 16) : '--:--');

  const parsedCandidates = offers.map((item) => {
    const seg = item.itineraries?.[0]?.segments?.[0];
    const carrierCode = seg?.carrierCode || item.validatingAirlineCodes?.[0] || 'KE';
    const airlineName = AIRLINE_NAME_MAP[carrierCode] || carriersDict[carrierCode] || `${carrierCode} 항공`;
    const totalKrw = Math.round(Number(item.price?.grandTotal || 0));
    const weightSum = Math.max(1, Number(adults) + Number(children) * 0.8 + Number(infants) * 0.1);
    const unitAdultOneWay = Math.round(totalKrw / weightSum / 100) * 100;

    return {
      direction,
      date: departureDate,
      dayOfWeekKo: getDayOfWeekKo(departureDate),
      airline: airlineName,
      airlineCode: carrierCode,
      flightNumber: seg ? `${seg.carrierCode}${seg.number}` : `${carrierCode}편`,
      baggageInfo: '운임 규정 확인',
      scheduleTime: seg ? `${formatTime(seg.departure?.at)} → ${formatTime(seg.arrival?.at)}` : '스케줄 확인',
      oneWayPriceKrw: unitAdultOneWay
    };
  });

  parsedCandidates.sort((a, b) => a.oneWayPriceKrw - b.oneWayPriceKrw);
  return parsedCandidates;
}

/**
 * 출국 편도 + 귀국 편도 각각 최저가 탐색 후 합산하는 메인 함수
 */
async function fetchLowestRoundTripPrice(query, settings = {}, options = {}) {
  const {
    origin = 'ICN',
    destination = 'NRT',
    customDestinationCity = '',
    departureDate,
    returnDate,
    adults = 1,
    children = 0,
    infants = 0,
    directOnly = true,
    targetPrice = 0
  } = query;

  const { forceTargetHit = false, customDestinations = [], externalCandidates = null } = options;
  const preferred = settings?.preferredDataSource || 'AUTO';
  const destMeta = getDestinationByCode(destination, customDestinations, customDestinationCity);

  let outCandidates = null;
  let inCandidates = null;
  let usedProvider = 'SIMULATION';

  // 프록시가 받아 온 실제 운임이 있으면 그것만 쓴다 ('급락 시뮬레이션'은 일부러 계산식 가격을 낮추는 기능이라 제외)
  const external =
    !forceTargetHit && externalCandidates
      ? prepareExternalCandidates(externalCandidates, { origin, destination, departureDate, returnDate })
      : null;
  if (external) {
    outCandidates = external.outCandidates;
    inCandidates = external.inCandidates;
    usedProvider = external.usedProvider;
  }

  if (
    !external &&
    !forceTargetHit &&
    (preferred === 'AUTO' || preferred === 'AMADEUS') &&
    settings?.amadeusClientId &&
    settings?.amadeusClientSecret
  ) {
    try {
      const [outList, inList] = await Promise.all([
        fetchAmadeusOneWayLeg(
          { origin, destination, departureDate, adults, children, infants, directOnly, direction: 'OUTBOUND' },
          settings
        ),
        fetchAmadeusOneWayLeg(
          {
            origin: destination,
            destination: origin,
            departureDate: returnDate,
            adults,
            children,
            infants,
            directOnly,
            direction: 'INBOUND'
          },
          settings
        )
      ]);
      outCandidates = outList;
      inCandidates = inList;
      usedProvider = 'AMADEUS';
    } catch (err) {
      console.warn('[FlightAPI] Amadeus 편도 합산 조회 실패, 시뮬레이션 엔진으로 폴백:', err.message);
      if (preferred === 'AMADEUS') throw err;
    }
  }

  if (!outCandidates || !inCandidates) {
    // 같은 노선·날짜·인원이면 탐색기·귀국일표·가격 추이와 같은 가격이 나오도록 무작위 변동을 넣지 않음
    // ('급락 시뮬레이션' 버튼(forceTargetHit)만 의도적으로 가격을 낮춤)
    const jitter = forceTargetHit ? -0.18 : 0;
    outCandidates = computeOneWayCandidateOffers({
      origin,
      destination,
      dateStr: departureDate,
      direction: 'OUTBOUND',
      directOnly,
      adults,
      children,
      infants,
      jitterRatio: jitter,
      customDestinations,
      customCityName: customDestinationCity
    });
    const resolvedOutOrigin = outCandidates[0]?.originAirportCode || (origin === 'ALL_KOREA' ? 'ICN' : origin);
    inCandidates = computeOneWayCandidateOffers({
      origin: origin === 'ALL_KOREA' ? resolvedOutOrigin : origin,
      destination,
      dateStr: returnDate,
      direction: 'INBOUND',
      directOnly,
      adults,
      children,
      infants,
      jitterRatio: jitter,
      customDestinations,
      customCityName: customDestinationCity
    });
    usedProvider = 'SIMULATION';
  }

  const bestOutbound = { ...outCandidates[0] };
  const bestInbound = { ...inCandidates[0] };
  const actualOriginCode = bestOutbound.originAirportCode || (origin === 'ALL_KOREA' ? 'ICN' : origin);
  const actualOriginCity = bestOutbound.originAirportCity || getOriginByCode(actualOriginCode).city;

  if (forceTargetHit && targetPrice > 0) {
    const desiredCombined = Math.round((targetPrice * (0.89 + Math.random() * 0.06)) / 100) * 100;
    bestOutbound.oneWayPriceKrw = Math.round((desiredCombined * 0.48) / 100) * 100;
    bestInbound.oneWayPriceKrw = desiredCombined - bestOutbound.oneWayPriceKrw;
  }

  const combinedUnitPriceKrw = bestOutbound.oneWayPriceKrw + bestInbound.oneWayPriceKrw;

  let sameAirlineBestKrw;
  let mixMatchSavingsKrw;
  if (external) {
    sameAirlineBestKrw = cheapestSameAirlinePairKrw(outCandidates, inCandidates);
    mixMatchSavingsKrw = sameAirlineBestKrw === null ? 0 : Math.max(0, sameAirlineBestKrw - combinedUnitPriceKrw);
  } else {
    // 계산식(모의) 가격: 같은 항공사 왕복 묶음은 편도 합계보다 조금 비싸다고 가정한 추정치
    sameAirlineBestKrw = combinedUnitPriceKrw + 24000;
    for (const outItem of outCandidates) {
      const matchingIn = inCandidates.find((inItem) => inItem.airlineCode === outItem.airlineCode);
      if (matchingIn) {
        const sumSame = Math.round(((outItem.oneWayPriceKrw + matchingIn.oneWayPriceKrw) * 1.04) / 100) * 100;
        if (sumSame < sameAirlineBestKrw) {
          sameAirlineBestKrw = sumSame;
        }
      }
    }
    if (sameAirlineBestKrw < combinedUnitPriceKrw) {
      sameAirlineBestKrw = combinedUnitPriceKrw;
    }
    mixMatchSavingsKrw = Math.max(0, sameAirlineBestKrw - combinedUnitPriceKrw);
  }
  const isDifferentAirlineCombo = bestOutbound.airlineCode !== bestInbound.airlineCode;

  const passengerPricing = calculatePassengerPricing(combinedUnitPriceKrw, { adults, children, infants });
  const bookingLinks = buildBookingLinks({
    origin: actualOriginCode,
    destination,
    departureDate,
    returnDate,
    adults: passengerPricing.adults,
    children: passengerPricing.children,
    infants: passengerPricing.infants,
    directOnly,
    outboundAirline: bestOutbound.airline,
    inboundAirline: bestInbound.airline,
    outboundAirlineCode: bestOutbound.airlineCode,
    inboundAirlineCode: bestInbound.airlineCode
  });

  // 편도 링크도 bookingLinks와 100% 동일하게 동기화
  bestOutbound.naverOneWayUrl = bookingLinks.outboundNaverUrl;
  bestOutbound.officialBookingUrl = bookingLinks.outboundAirlineOfficialUrl;
  bestInbound.naverOneWayUrl = bookingLinks.inboundNaverUrl;
  bestInbound.officialBookingUrl = bookingLinks.inboundAirlineOfficialUrl;

  const comboAirlineSummary = isDifferentAirlineCombo
    ? `${bestOutbound.airline}(출국) + ${bestInbound.airline}(귀국)`
    : `${bestOutbound.airline} (편도 합산)`;

  return {
    usedProvider,
    offer: {
      searchMode: 'ONEWAY_COMBO',
      requestedOrigin: origin,
      origin: actualOriginCode,
      resolvedOriginCode: actualOriginCode,
      resolvedOriginCity: actualOriginCity,
      priceKrw: combinedUnitPriceKrw,
      totalPriceKrw: passengerPricing.totalPassengersPriceKrw,
      sameAirlineBundledPriceKrw: sameAirlineBestKrw,
      mixMatchSavingsKrw,
      isDifferentAirlineCombo,
      airline: comboAirlineSummary,
      airlineCode: `${bestOutbound.airlineCode}+${bestInbound.airlineCode}`,
      flightNumber: `${bestOutbound.flightNumber} / ${bestInbound.flightNumber}`,
      baggageInfo: `출국(${bestOutbound.baggageInfo}) · 귀국(${bestInbound.baggageInfo})`,
      departureTime: bestOutbound.scheduleTime,
      returnTime: bestInbound.scheduleTime,
      outboundLeg: bestOutbound,
      inboundLeg: bestInbound,
      outboundCandidates: outCandidates.slice(0, 4),
      inboundCandidates: inCandidates.slice(0, 4),
      passengerPricing,
      benchmark2Y: destMeta.benchmark2Y,
      sourceApi: external
        ? external.sourceApi
        : usedProvider !== 'AMADEUS'
        ? 'ONEWAY_COMBO_ENGINE'
        : settings?.amadeusEnv === 'production'
        ? 'AMADEUS_ONEWAY_COMBO'
        : 'AMADEUS_TEST_ONEWAY_COMBO',
      fareFetchedAt: external ? external.fetchedAt : null,
      bookingLinks
    }
  };
}

/**
 * 하나의 출발일(departureDate)을 지정했을 때 돌아오는 일정별(1박 2일 ~ maxStayDays박) 가격 매트릭스
 */
function getReturnDatePriceMatrix({
  origin = 'ICN',
  destination = 'NRT',
  customCityName = '',
  customDestinations = [],
  departureDate,
  adults = 1,
  children = 0,
  infants = 0,
  directOnly = true,
  maxStayDays = 10,
  fareQuote = null
}) {
  const originMeta = getOriginByCode(origin);
  const destMeta = getDestinationByCode(destination, customDestinations, customCityName);
  const benchmark2Y = destMeta.benchmark2Y || {};
  const quote = resolveFareQuote(fareQuote);

  const outCandidates = quote({
    origin,
    destination,
    dateStr: departureDate,
    direction: 'OUTBOUND',
    directOnly,
    adults,
    children,
    infants,
    customDestinations,
    customCityName
  });
  // 실제 운임 캘린더에 그날 가는 편이 없으면 빈 표 (계산식 가격으로 채우지 않는다)
  if (!outCandidates.length) {
    return {
      requestedOrigin: origin,
      origin,
      originCity: originMeta.city,
      destination,
      destinationCity: destMeta.city,
      departureDate,
      departureDayOfWeekKo: getDayOfWeekKo(departureDate),
      outboundLeg: null,
      outboundCandidates: [],
      benchmark2Y,
      passengerSummary: calculatePassengerPricing(0, { adults, children, infants }),
      cheapestOption: null,
      returnOptions: []
    };
  }
  const bestOutbound = { ...outCandidates[0] };
  const actualOriginCode = bestOutbound.originAirportCode || (origin === 'ALL_KOREA' ? 'ICN' : origin);
  const actualOriginCity = bestOutbound.originAirportCity || originMeta.city;
  const byAirport = pairsByKoreanAirport(fareQuote, origin);

  const returnOptions = [];
  for (let stayNights = 1; stayNights <= maxStayDays; stayNights++) {
    const returnDate = addDays(departureDate, stayNights);
    const inCandidates = quote({
      origin: byAirport ? 'ALL_KOREA' : actualOriginCode,
      destination,
      dateStr: returnDate,
      direction: 'INBOUND',
      directOnly,
      adults,
      children,
      infants,
      customDestinations,
      customCityName
    });
    if (!inCandidates.length) continue;
    const pair = byAirport ? cheapestSameAirportPair(outCandidates, inCandidates) : null;
    if (byAirport && !pair) continue;
    const cellOutbound = pair ? { ...pair.out } : bestOutbound;
    const cellOriginCode = pair ? pair.out.originAirportCode : actualOriginCode;
    const cellOriginCity = pair ? pair.out.originAirportCity || originMeta.city : actualOriginCity;
    const bestInbound = { ...(pair ? pair.back : inCandidates[0]) };

    const combinedAdultPriceKrw = cellOutbound.oneWayPriceKrw + bestInbound.oneWayPriceKrw;
    const passengerPricing = calculatePassengerPricing(combinedAdultPriceKrw, { adults, children, infants });
    const avg2Y = benchmark2Y.avg2YKrw || destMeta.basePriceKrw || 300000;
    const discountVs2YAvgPercent = Math.round(((avg2Y - combinedAdultPriceKrw) / avg2Y) * 100);

    let priceGrade = 'NORMAL';
    if (combinedAdultPriceKrw <= (benchmark2Y.lowest2YKrw || 0) * 1.08) {
      priceGrade = 'HISTORIC_LOW';
    } else if (combinedAdultPriceKrw <= (benchmark2Y.top10Deal2YKrw || destMeta.dealThresholdKrw)) {
      priceGrade = 'GREAT_DEAL';
    } else if (combinedAdultPriceKrw <= avg2Y) {
      priceGrade = 'GOOD';
    } else {
      priceGrade = 'HIGH';
    }

    const bookingLinks = buildBookingLinks({
      origin: cellOriginCode,
      destination,
      departureDate,
      returnDate,
      adults: passengerPricing.adults,
      children: passengerPricing.children,
      infants: passengerPricing.infants,
      directOnly,
      outboundAirline: cellOutbound.airline,
      inboundAirline: bestInbound.airline,
      outboundAirlineCode: cellOutbound.airlineCode,
      inboundAirlineCode: bestInbound.airlineCode
    });

    bestInbound.naverOneWayUrl = bookingLinks.inboundNaverUrl;
    bestInbound.officialBookingUrl = bookingLinks.inboundAirlineOfficialUrl;
    cellOutbound.naverOneWayUrl = bookingLinks.outboundNaverUrl;
    cellOutbound.officialBookingUrl = bookingLinks.outboundAirlineOfficialUrl;

    returnOptions.push({
      stayNights,
      stayLabel: `${stayNights}박 ${stayNights + 1}일`,
      origin: cellOriginCode,
      originCity: cellOriginCity,
      // 전국 통합 실제 운임은 칸마다 한국 공항(=가는 편)이 다를 수 있다
      ...(pair ? { outboundLeg: cellOutbound } : {}),
      returnDate,
      returnDayOfWeekKo: getDayOfWeekKo(returnDate),
      inboundLeg: bestInbound,
      combinedAdultPriceKrw,
      totalPassengersPriceKrw: passengerPricing.totalPassengersPriceKrw,
      discountVs2YAvgPercent,
      priceGrade,
      isDifferentAirlineCombo: cellOutbound.airlineCode !== bestInbound.airlineCode,
      bookingLinks
    });
  }

  const sortedByPrice = [...returnOptions].sort((a, b) => a.combinedAdultPriceKrw - b.combinedAdultPriceKrw);
  const cheapestReturnDate = sortedByPrice[0]?.returnDate;

  returnOptions.forEach((opt) => {
    opt.isCheapestReturn = opt.returnDate === cheapestReturnDate;
  });

  // 전국 통합 실제 운임: 맨 위 가는 편은 가장 싼 칸의 공항·가는 편
  const lead = byAirport ? sortedByPrice[0] || null : null;
  const headOriginCode = lead ? lead.origin : actualOriginCode;
  const headOriginCity = lead ? lead.originCity : actualOriginCity;

  return {
    requestedOrigin: origin,
    origin: headOriginCode,
    originCity: origin === 'ALL_KOREA' ? `한국 전체 통합 (${headOriginCity} 출발 최저가)` : headOriginCity,
    destination,
    destinationCity: destMeta.city,
    departureDate,
    departureDayOfWeekKo: getDayOfWeekKo(departureDate),
    outboundLeg: lead ? lead.outboundLeg : bestOutbound,
    outboundCandidates: outCandidates.slice(0, 3),
    benchmark2Y,
    passengerSummary: calculatePassengerPricing(sortedByPrice[0]?.combinedAdultPriceKrw || 0, {
      adults,
      children,
      infants
    }),
    cheapestOption: sortedByPrice[0] || null,
    returnOptions
  };
}

/**
 * 특정 도시의 향후 60일 내 가장 저렴한 추천 일정(황금 스케줄) 자동 제안
 */
function getRecommendedCheapSchedules({
  origin = 'ICN',
  destination = 'NRT',
  customCityName = '',
  customDestinations = [],
  minNights = 2,
  maxNights = 5,
  adults = 1,
  children = 0,
  infants = 0,
  directOnly = true,
  limit = 6,
  fareQuote = null,
  departureStepDays = 2
}) {
  const originMeta = getOriginByCode(origin);
  const destMeta = getDestinationByCode(destination, customDestinations, customCityName);
  const benchmark2Y = destMeta.benchmark2Y || {};
  const avg2Y = benchmark2Y.avg2YKrw || destMeta.basePriceKrw || 300000;
  const quote = resolveFareQuote(fareQuote);
  const byAirport = pairsByKoreanAirport(fareQuote, origin);
  // 실제 운임 캘린더는 날짜마다 값이 달라 하루 간격으로 훑는다 (계산식은 기존처럼 이틀 간격)
  const stepDays = Math.min(7, Math.max(1, Math.floor(Number(departureStepDays)) || 2));

  const today = new Date().toISOString().slice(0, 10);
  const allCombinations = [];
  // 박수 범위는 상한을 둬서 한 번의 요청이 수백만 개 조합을 계산하지 않게 한다
  const firstNights = Math.min(MAX_RECOMMENDED_STAY_NIGHTS, Math.max(1, Math.floor(Number(minNights)) || 1));
  const lastNights = Math.min(MAX_RECOMMENDED_STAY_NIGHTS, Math.max(firstNights, Math.floor(Number(maxNights)) || firstNights));

  for (let depOffset = 7; depOffset <= 52; depOffset += stepDays) {
    const departureDate = addDays(today, depOffset);
    const outCandidates = quote({
      origin,
      destination,
      dateStr: departureDate,
      direction: 'OUTBOUND',
      directOnly,
      adults,
      children,
      infants,
      customDestinations,
      customCityName
    });
    if (!outCandidates.length) continue;
    const bestOut = { ...outCandidates[0] };
    const actualOriginCode = bestOut.originAirportCode || (origin === 'ALL_KOREA' ? 'ICN' : origin);
    const actualOriginCity = bestOut.originAirportCity || originMeta.city;

    for (let nights = firstNights; nights <= lastNights; nights++) {
      const returnDate = addDays(departureDate, nights);
      const inCandidates = quote({
        origin: byAirport ? 'ALL_KOREA' : actualOriginCode,
        destination,
        dateStr: returnDate,
        direction: 'INBOUND',
        directOnly,
        adults,
        children,
        infants,
        customDestinations,
        customCityName
      });
      if (!inCandidates.length) continue;
      const pair = byAirport ? cheapestSameAirportPair(outCandidates, inCandidates) : null;
      if (byAirport && !pair) continue;
      const comboOut = pair ? { ...pair.out } : bestOut;
      const comboOriginCode = pair ? pair.out.originAirportCode : actualOriginCode;
      const comboOriginCity = pair ? pair.out.originAirportCity || originMeta.city : actualOriginCity;
      const bestIn = { ...(pair ? pair.back : inCandidates[0]) };

      const combinedAdultPriceKrw = comboOut.oneWayPriceKrw + bestIn.oneWayPriceKrw;
      const passengerPricing = calculatePassengerPricing(combinedAdultPriceKrw, { adults, children, infants });
      const discountVs2YAvgPercent = Math.round(((avg2Y - combinedAdultPriceKrw) / avg2Y) * 100);

      const bookingLinks = buildBookingLinks({
        origin: comboOriginCode,
        destination,
        departureDate,
        returnDate,
        adults: passengerPricing.adults,
        children: passengerPricing.children,
        infants: passengerPricing.infants,
        directOnly,
        outboundAirline: comboOut.airline,
        inboundAirline: bestIn.airline,
        outboundAirlineCode: comboOut.airlineCode,
        inboundAirlineCode: bestIn.airlineCode
      });

      const syncedOut = {
        ...comboOut,
        naverOneWayUrl: bookingLinks.outboundNaverUrl,
        officialBookingUrl: bookingLinks.outboundAirlineOfficialUrl
      };
      const syncedIn = {
        ...bestIn,
        naverOneWayUrl: bookingLinks.inboundNaverUrl,
        officialBookingUrl: bookingLinks.inboundAirlineOfficialUrl
      };

      allCombinations.push({
        requestedOrigin: origin,
        origin: comboOriginCode,
        originCity: comboOriginCity,
        destination,
        destinationCity: destMeta.city,
        departureDate,
        departureDayOfWeekKo: getDayOfWeekKo(departureDate),
        returnDate,
        returnDayOfWeekKo: getDayOfWeekKo(returnDate),
        stayNights: nights,
        stayLabel: `${nights}박 ${nights + 1}일`,
        outboundLeg: syncedOut,
        inboundLeg: syncedIn,
        combinedAdultPriceKrw,
        totalPassengersPriceKrw: passengerPricing.totalPassengersPriceKrw,
        passengerSummaryText: passengerPricing.passengerSummaryText,
        discountVs2YAvgPercent,
        vsLowest2YDiffKrw: combinedAdultPriceKrw - (benchmark2Y.lowest2YKrw || combinedAdultPriceKrw),
        bookingLinks
      });
    }
  }

  allCombinations.sort((a, b) => a.combinedAdultPriceKrw - b.combinedAdultPriceKrw);
  const picked = [];
  const usedDepDates = new Set();

  for (const item of allCombinations) {
    if (usedDepDates.has(item.departureDate)) continue;
    usedDepDates.add(item.departureDate);
    picked.push(item);
    if (picked.length >= limit) break;
  }

  return {
    origin,
    originCity: originMeta.city,
    destination,
    destinationCity: destMeta.city,
    benchmark2Y,
    recommendations: picked
  };
}

// ── 노선·인원 설정 메뉴: ±3일 최저가 목록 · 목표가 알림 스캔 ───────────────────────────
// 둘 다 날짜를 하루씩 바꿔 가며 '그 가는 날·오는 날 쌍의 가장 싼 왕복(편도 두 장)'을 구한다.
// 실제 운임(fareQuote = Travelpayouts 캘린더)이면 값이 있는 날만, 없으면 계산식(모의) 가격.
const MAX_FLEX_DAYS = 3;
const DEFAULT_FLEX_LIMIT = 20;
const MAX_FLEX_LIMIT = 30;
const MAX_TARGET_SCAN_DAYS = 186; // 약 6개월 (프록시가 한 번에 받는 Travelpayouts 달 수를 묶어 둔다)
const DEFAULT_TARGET_SCAN_DAYS = 90;
const DEFAULT_TARGET_LIMIT = 20;
const MAX_TARGET_LIMIT = 30;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// 한국 시간 기준 오늘 (화면의 날짜 선택·프록시와 같은 기준)
function kstToday() {
  return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
}

function isIsoDate(value) {
  if (!ISO_DATE_PATTERN.test(String(value || ''))) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function daysBetweenIso(fromIso, toIso) {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86400000);
}

function clampInt(value, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

// 노선 하나를 훑는 동안 쓰는 값 — 같은 날·방향·공항의 편도 후보는 한 번만 계산한다 (여러 조합이 같은 날을 다시 묻는다)
function routeScanContext({ origin, destination, customCityName, customDestinations, adults, children, infants, directOnly, fareQuote }) {
  const quote = resolveFareQuote(fareQuote);
  const base = { destination, directOnly, adults, children, infants, customDestinations, customCityName };
  const cache = new Map();
  return {
    origin,
    destination,
    directOnly,
    originMeta: getOriginByCode(origin),
    destMeta: getDestinationByCode(destination, customDestinations, customCityName),
    pax: { adults, children, infants },
    byAirport: pairsByKoreanAirport(fareQuote, origin),
    quoteFor(direction, dateStr, quoteOrigin) {
      const key = `${direction}|${dateStr}|${quoteOrigin}`;
      if (!cache.has(key)) cache.set(key, quote({ ...base, origin: quoteOrigin, dateStr, direction }));
      return cache.get(key);
    }
  };
}

// 가는 날·오는 날 쌍의 가장 싼 왕복 — 추천 일정과 같은 규칙
// (전국 통합 실제 운임은 같은 한국 공항 왕복 중 가장 싼 짝, 그 밖에는 가장 싼 가는 편의 공항으로 돌아오는 편)
function cheapestRoundTripPair(ctx, departureDate, returnDate) {
  const outCandidates = ctx.quoteFor('OUTBOUND', departureDate, ctx.origin);
  if (!outCandidates.length) return null;
  const bestOut = outCandidates[0];
  const outOrigin = bestOut.originAirportCode || (ctx.origin === 'ALL_KOREA' ? 'ICN' : ctx.origin);
  const inCandidates = ctx.quoteFor('INBOUND', returnDate, ctx.byAirport ? 'ALL_KOREA' : outOrigin);
  if (!inCandidates.length) return null;
  if (!ctx.byAirport) return { out: bestOut, back: inCandidates[0] };
  const pair = cheapestSameAirportPair(outCandidates, inCandidates);
  return pair ? { out: pair.out, back: pair.back } : null;
}

const pairPriceKrw = (pair) => pair.out.oneWayPriceKrw + pair.back.oneWayPriceKrw;

// 왕복 일정 한 건의 예약 링크 (그 인원·그 한국 공항으로) — describeRoundTrip 과 withRoundTripLinks 가 함께 쓴다
function roundTripBookingLinks({ origin, destination, departureDate, returnDate, out, back }, { adults, children, infants, directOnly }) {
  return buildBookingLinks({
    origin,
    destination,
    departureDate,
    returnDate,
    adults,
    children,
    infants,
    directOnly,
    outboundAirline: out.airline,
    inboundAirline: back.airline,
    outboundAirlineCode: out.airlineCode,
    inboundAirlineCode: back.airlineCode
  });
}

// 저장용 일정: 예약 링크는 언제든 다시 만들 수 있어 뺀다 (목표가 알림 하나가 일정 20개의 링크로 9만 자 넘게 커지지 않게)
function withoutRoundTripLinks(deal) {
  if (!deal) return deal;
  const { bookingLinks, ...rest } = deal;
  const stripLeg = (leg) => {
    if (!leg) return leg;
    const { naverOneWayUrl, officialBookingUrl, ...kept } = leg;
    return kept;
  };
  return { ...rest, outboundLeg: stripLeg(deal.outboundLeg), inboundLeg: stripLeg(deal.inboundLeg) };
}

// withoutRoundTripLinks 로 줄인 일정에 예약 링크를 다시 붙인다 (party: 그 알림의 인원·직항 — describeRoundTrip 과 같은 링크)
function withRoundTripLinks(deal, party) {
  if (!deal || !deal.outboundLeg || !deal.inboundLeg) return deal;
  const pricing = calculatePassengerPricing(deal.combinedAdultPriceKrw, party);
  const bookingLinks = roundTripBookingLinks(
    { ...deal, out: deal.outboundLeg, back: deal.inboundLeg },
    { adults: pricing.adults, children: pricing.children, infants: pricing.infants, directOnly: party.directOnly !== false }
  );
  return {
    ...deal,
    outboundLeg: { ...deal.outboundLeg, naverOneWayUrl: bookingLinks.outboundNaverUrl, officialBookingUrl: bookingLinks.outboundAirlineOfficialUrl },
    inboundLeg: { ...deal.inboundLeg, naverOneWayUrl: bookingLinks.inboundNaverUrl, officialBookingUrl: bookingLinks.inboundAirlineOfficialUrl },
    bookingLinks
  };
}

// 화면 카드·알림 한 건 (예약 링크는 그 인원·그 한국 공항으로 만든다)
function describeRoundTrip(ctx, departureDate, returnDate, pair) {
  const { out, back } = pair;
  const originCode = out.originAirportCode || (ctx.origin === 'ALL_KOREA' ? 'ICN' : ctx.origin);
  const combinedAdultPriceKrw = pairPriceKrw(pair);
  const passengerPricing = calculatePassengerPricing(combinedAdultPriceKrw, ctx.pax);
  const bookingLinks = roundTripBookingLinks(
    { origin: originCode, destination: ctx.destination, departureDate, returnDate, out, back },
    { adults: passengerPricing.adults, children: passengerPricing.children, infants: passengerPricing.infants, directOnly: ctx.directOnly }
  );
  const stayNights = daysBetweenIso(departureDate, returnDate);
  return {
    requestedOrigin: ctx.origin,
    origin: originCode,
    originCity: out.originAirportCity || ctx.originMeta.city,
    destination: ctx.destination,
    destinationCity: ctx.destMeta.city,
    departureDate,
    departureDayOfWeekKo: getDayOfWeekKo(departureDate),
    returnDate,
    returnDayOfWeekKo: getDayOfWeekKo(returnDate),
    stayNights,
    stayLabel: `${stayNights}박 ${stayNights + 1}일`,
    outboundLeg: { ...out, naverOneWayUrl: bookingLinks.outboundNaverUrl, officialBookingUrl: bookingLinks.outboundAirlineOfficialUrl },
    inboundLeg: { ...back, naverOneWayUrl: bookingLinks.inboundNaverUrl, officialBookingUrl: bookingLinks.inboundAirlineOfficialUrl },
    combinedAdultPriceKrw,
    totalPassengersPriceKrw: passengerPricing.totalPassengersPriceKrw,
    passengerSummaryText: passengerPricing.passengerSummaryText,
    isDifferentAirlineCombo: out.airlineCode !== back.airlineCode,
    bookingLinks
  };
}

/**
 * ±3일 최저가: 입력한 가는 날·오는 날을 각각 flexDays(최대 3)일 앞뒤로 옮긴 조합 중 싼 순서로 limit(기본 20)개
 * - 오늘보다 앞선 가는 날, 가는 날과 같거나 앞선 오는 날은 뺀다
 * - requestedDates: 입력한 일정 그대로의 값 (목록 밖이어도 '입력한 일정보다 얼마 싼지' 비교용)
 */
function getFlexibleDateDeals({
  origin = 'ICN',
  destination = 'NRT',
  customCityName = '',
  customDestinations = [],
  departureDate,
  returnDate,
  flexDays = MAX_FLEX_DAYS,
  adults = 1,
  children = 0,
  infants = 0,
  directOnly = true,
  limit = DEFAULT_FLEX_LIMIT,
  fareQuote = null,
  today = kstToday()
}) {
  if (!isIsoDate(departureDate) || !isIsoDate(returnDate) || returnDate < departureDate) {
    throw codedError('BAD_DATE', '가는 날·오는 날을 확인하세요 (오는 날은 가는 날과 같거나 그 뒤).');
  }
  const flex = clampInt(flexDays, 0, MAX_FLEX_DAYS, MAX_FLEX_DAYS);
  const max = clampInt(limit, 1, MAX_FLEX_LIMIT, DEFAULT_FLEX_LIMIT);
  const ctx = routeScanContext({ origin, destination, customCityName, customDestinations, adults, children, infants, directOnly, fareQuote });

  const deals = [];
  for (let depShift = -flex; depShift <= flex; depShift++) {
    const dep = addDays(departureDate, depShift);
    if (dep < today) continue;
    for (let retShift = -flex; retShift <= flex; retShift++) {
      const ret = addDays(returnDate, retShift);
      if (ret <= dep) continue;
      const pair = cheapestRoundTripPair(ctx, dep, ret);
      if (!pair) continue;
      deals.push({
        ...describeRoundTrip(ctx, dep, ret, pair),
        depShiftDays: depShift,
        retShiftDays: retShift,
        isRequestedDates: depShift === 0 && retShift === 0
      });
    }
  }
  // 같은 값이면 입력한 일정에 가까운 것, 그다음 이른 날짜 먼저
  const shift = (d) => Math.abs(d.depShiftDays) + Math.abs(d.retShiftDays);
  deals.sort(
    (a, b) =>
      a.combinedAdultPriceKrw - b.combinedAdultPriceKrw ||
      shift(a) - shift(b) ||
      a.departureDate.localeCompare(b.departureDate) ||
      a.returnDate.localeCompare(b.returnDate)
  );
  const requested = deals.find((d) => d.isRequestedDates) || null;

  return {
    origin,
    originCity: ctx.originMeta.city,
    destination,
    destinationCity: ctx.destMeta.city,
    departureDate,
    returnDate,
    flexDays: flex,
    comboCount: deals.length,
    requestedDates: {
      departureDate,
      returnDate,
      combinedAdultPriceKrw: requested ? requested.combinedAdultPriceKrw : null,
      totalPassengersPriceKrw: requested ? requested.totalPassengersPriceKrw : null
    },
    deals: deals.slice(0, max)
  };
}

/**
 * 목표가 알림 스캔: 날짜를 정하지 않고 희망 목표가(성인 1인 왕복 합계)만으로
 * fromDate~toDate(최대 186일)의 출발일을 하루씩 훑어, 그날 박수 범위 안에서 가장 싼 일정이 목표가 이하인 날을 모은다
 * - matches: 목표가 이하인 날(하루 한 건) 싼 순서로 limit(기본 20)개, matchCount: 그런 날의 수
 * - cheapest: 목표가와 상관없이 기간 중 가장 싼 일정 (하나도 없을 때 '목표가까지 얼마' 를 알려 주려고)
 */
function scanTargetPriceDeals({
  origin = 'ICN',
  destination = 'NRT',
  customCityName = '',
  customDestinations = [],
  targetPrice,
  fromDate,
  toDate,
  minNights = 2,
  maxNights = 5,
  adults = 1,
  children = 0,
  infants = 0,
  directOnly = true,
  limit = DEFAULT_TARGET_LIMIT,
  fareQuote = null,
  today = kstToday()
}) {
  const target = targetPrice === null || targetPrice === '' ? NaN : Number(targetPrice);
  if (!Number.isFinite(target) || target <= 0) {
    throw codedError('BAD_TARGET_PRICE', '목표가는 0보다 큰 금액이어야 합니다.');
  }
  let start = isIsoDate(fromDate) ? fromDate : addDays(today, 1);
  if (start < today) start = today;
  let end = isIsoDate(toDate) ? toDate : addDays(start, DEFAULT_TARGET_SCAN_DAYS - 1);
  if (end < start) end = start;
  if (daysBetweenIso(start, end) > MAX_TARGET_SCAN_DAYS - 1) end = addDays(start, MAX_TARGET_SCAN_DAYS - 1);
  const firstNights = clampInt(minNights, 1, MAX_RECOMMENDED_STAY_NIGHTS, 2);
  const lastNights = Math.max(firstNights, clampInt(maxNights, 1, MAX_RECOMMENDED_STAY_NIGHTS, Math.max(firstNights, 5)));
  const max = clampInt(limit, 1, MAX_TARGET_LIMIT, DEFAULT_TARGET_LIMIT);
  const ctx = routeScanContext({ origin, destination, customCityName, customDestinations, adults, children, infants, directOnly, fareQuote });

  const dayBests = [];
  let scannedDays = 0;
  for (let dep = start; dep <= end; dep = addDays(dep, 1)) {
    scannedDays += 1;
    let best = null;
    for (let nights = firstNights; nights <= lastNights; nights++) {
      const ret = addDays(dep, nights);
      const pair = cheapestRoundTripPair(ctx, dep, ret);
      if (pair && (!best || pairPriceKrw(pair) < pairPriceKrw(best.pair))) best = { ret, pair };
    }
    if (best) dayBests.push({ dep, ...best });
  }
  dayBests.sort((a, b) => pairPriceKrw(a.pair) - pairPriceKrw(b.pair) || a.dep.localeCompare(b.dep));
  const matching = dayBests.filter((b) => pairPriceKrw(b.pair) <= target);
  const describe = (b) => describeRoundTrip(ctx, b.dep, b.ret, b.pair);

  return {
    origin,
    originCity: ctx.originMeta.city,
    destination,
    destinationCity: ctx.destMeta.city,
    targetPrice: target,
    fromDate: start,
    toDate: end,
    minNights: firstNights,
    maxNights: lastNights,
    scannedDays,
    daysWithFares: dayBests.length,
    matchCount: matching.length,
    matches: matching.slice(0, max).map(describe),
    cheapest: dayBests.length ? describe(dayBests[0]) : null
  };
}

const MAX_EXTERNAL_SCAN_ITEMS = 40;
// 프록시가 운임을 받아 온 시각(표시용): 이보다 오래되었거나 이보다 앞선(시계가 어긋난·꾸민) 값은 버린다
const FETCHED_AT_MAX_AGE_MS = 8 * 24 * 3600000;
const FETCHED_AT_MAX_AHEAD_MS = 24 * 3600000;

function freshFetchedAt(value, nowMs) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms < nowMs - FETCHED_AT_MAX_AGE_MS || ms > nowMs + FETCHED_AT_MAX_AHEAD_MS) return null;
  return new Date(ms).toISOString();
}

/**
 * 프록시(Travelpayouts 최근 검색가)가 훑은 목표가 스캔 결과를 저장하기 전에 다시 검증한다 — 브라우저를 거쳐 들어오므로 믿지 않는다
 * - 일정: 오늘부터 기간 끝(+하루 여유) 안의 가는 날, 박수 범위 안의 오는 날 / 편도: 형식·금액·공항 (같은 한국 공항으로 오가는 짝만,
 *   직항만 찾는 알림이면 경유 구간은 버림)
 * - 보낸 목록과 '가장 싼 일정'을 함께 검증해 목표가 이하(하루 한 건, 싼 순서로 limit 개)와 가장 싼 일정을 이 엔진이 다시 가린다
 * - 보낸 일정이 있는데 하나도 검증을 못 넘으면 NO_REAL_FARES (빈 결과로 지난 결과를 지우지 않게)
 * - 예약 링크·인원 총액은 보낸 값을 쓰지 않고 이 엔진이 다시 만든다 (describeRoundTrip)
 */
function rebuildExternalTargetScan(
  raw,
  {
    origin = 'ICN',
    destination = 'NRT',
    customCityName = '',
    customDestinations = [],
    targetPrice,
    windowDays = DEFAULT_TARGET_SCAN_DAYS,
    minNights = 2,
    maxNights = 5,
    adults = 1,
    children = 0,
    infants = 0,
    directOnly = true,
    limit = DEFAULT_TARGET_LIMIT,
    today = kstToday(),
    nowMs = Date.now()
  }
) {
  const sourceApi = String(raw?.sourceApi || '');
  if (!CACHED_FARE_SOURCE_APIS.includes(sourceApi)) {
    throw codedError('BAD_FARE_SOURCE', '알 수 없는 운임 출처입니다 (목표가 알림은 Travelpayouts 최근 검색가만 받습니다).');
  }
  const target = Number(targetPrice);
  if (!Number.isFinite(target) || target <= 0) {
    throw codedError('BAD_TARGET_PRICE', '목표가는 0보다 큰 금액이어야 합니다.');
  }
  const days = clampInt(windowDays, 1, MAX_TARGET_SCAN_DAYS, DEFAULT_TARGET_SCAN_DAYS);
  const firstNights = clampInt(minNights, 1, MAX_RECOMMENDED_STAY_NIGHTS, 2);
  const lastNights = Math.max(firstNights, clampInt(maxNights, 1, MAX_RECOMMENDED_STAY_NIGHTS, Math.max(firstNights, 5)));
  const max = clampInt(limit, 1, MAX_TARGET_LIMIT, DEFAULT_TARGET_LIMIT);
  const fromDate = addDays(today, 1);
  // 프록시는 '내일부터 days 일' 을 훑는다 — 자정 무렵에 받은 결과도 버리지 않게 하루 여유를 둔다
  const latestDeparture = addDays(fromDate, days);
  const ctx = routeScanContext({ origin, destination, customCityName, customDestinations, adults, children, infants, directOnly, fareQuote: null });
  const legContext = {
    koreanCodes: origin === 'ALL_KOREA' ? INDIVIDUAL_KOREAN_AIRPORTS.map((a) => a.code) : [String(origin).toUpperCase()],
    foreignCode: String(destination).toUpperCase(),
    keepSourceUrl: true,
    today
  };

  const rebuild = (item) => {
    if (!item || typeof item !== 'object') return null;
    const dep = String(item.departureDate || '');
    const ret = String(item.returnDate || '');
    if (!isIsoDate(dep) || !isIsoDate(ret) || dep < today || dep > latestDeparture) return null;
    const nights = daysBetweenIso(dep, ret);
    if (nights < firstNights || nights > lastNights) return null;
    const out = sanitizeExternalLeg(item.outboundLeg, { ...legContext, direction: 'OUTBOUND', date: dep });
    const back = sanitizeExternalLeg(item.inboundLeg, { ...legContext, direction: 'INBOUND', date: ret });
    if (!out || !back || out.fromAirportCode !== back.toAirportCode) return null;
    // 직항만 찾는 알림에 경유 구간이 섞여 오면 버린다 (카톡·카드에는 '직항' 으로 나가므로)
    if (directOnly && (out.stops > 0 || back.stops > 0)) return null;
    return describeRoundTrip(ctx, dep, ret, { out, back });
  };
  const byPriceThenDate = (a, b) =>
    a.combinedAdultPriceKrw - b.combinedAdultPriceKrw || a.departureDate.localeCompare(b.departureDate);
  const seenDays = new Set();
  const firstOfItsDay = (m) => {
    if (seenDays.has(m.departureDate)) return false;
    seenDays.add(m.departureDate);
    return true;
  };

  const sentMatches = Array.isArray(raw.matches) ? raw.matches.slice(0, MAX_EXTERNAL_SCAN_ITEMS) : [];
  const sentItems = [...sentMatches, raw.cheapest].filter((item) => item && typeof item === 'object');
  const pool = sentItems.map(rebuild).filter(Boolean).sort(byPriceThenDate);
  if (sentItems.length > 0 && pool.length === 0) {
    throw codedError('NO_REAL_FARES', '받은 최근 검색가가 이 알림의 노선·날짜·조건과 하나도 맞지 않음');
  }
  const matches = pool.filter((m) => m.combinedAdultPriceKrw <= target).filter(firstOfItsDay).slice(0, max);
  const cheapest = pool[0] || null;
  // 목표가 이하인 날의 수: 보낸 목록이 다 차지 않았으면 그 목록이 전부이므로 검증한 개수를 쓰고,
  // 다 찼으면(limit 개) 목록 밖의 날은 이 엔진이 확인할 수 없어 보낸 값을 기간 일수 안에서만 받는다
  const listWasFull = sentMatches.length >= max;
  const matchCount = matches.length && listWasFull ? Math.max(matches.length, clampInt(raw.matchCount, 0, days, 0)) : matches.length;
  const scannedDays = clampInt(raw.scannedDays, 0, days, 0);

  return {
    origin,
    originCity: ctx.originMeta.city,
    destination,
    destinationCity: ctx.destMeta.city,
    targetPrice: target,
    fromDate,
    toDate: addDays(fromDate, days - 1),
    minNights: firstNights,
    maxNights: lastNights,
    scannedDays,
    daysWithFares: Math.max(Math.min(clampInt(raw.daysWithFares, 0, days, 0), scannedDays), matchCount),
    matchCount,
    matches,
    cheapest,
    sourceApi,
    fetchedAt: freshFetchedAt(raw.fetchedAt, nowMs),
    partial: raw.partial === true
  };
}

/**
 * [신규 핵심 기능] 도시를 지정하지 않고 향후 6개월(180일) 이내 전 세계 노선 중 가장 저렴한 항공편을
 * TOP 10 (1~10위), TOP 20 (11~20위), TOP 30 (21~30위) 3가지 그룹으로 구분 선정!
 * - origin: 'ALL_KOREA' (대한민국 전체 공항 통합) | 'ICN' | 'GMP' | 'PUS' | 'CJJ' | 'TAE' | 'CJU' | 'MWX'
 * - sortBy: 'LOWEST_PRICE' (무조건 가장 싼 금액순) | 'HIGHEST_DISCOUNT' (2년 평균가 대비 할인율 최고순)
 * - region: 'ALL' | '일본' | '동남아' | '중화권' | '미주/대양주' | '유럽'
 */
function getAnywhereTop10Next6Months({
  origin = 'ALL_KOREA',
  region = 'ALL',
  sortBy = 'LOWEST_PRICE',
  adults = 1,
  children = 0,
  infants = 0,
  directOnly = true,
  customDestinations = [],
  limit = 30
}) {
  const originMeta = getOriginByCode(origin);
  const allDests = [...INTERNATIONAL_DESTINATIONS, ...(customDestinations || [])];

  const targetDests =
    region === 'ALL' ? allDests : allDests.filter((d) => d.region === region);

  const today = new Date().toISOString().slice(0, 10);
  // 향후 6개월(180일) 동안의 대표적인 화/수/목 특가 출발 오프셋 샘플링
  const sampleOffsets = [12, 21, 33, 45, 57, 69, 83, 97, 111, 125, 139, 153, 167, 176];

  const primaryDealPerCity = [];
  const secondaryDealsPool = [];

  for (const dest of targetDests) {
    const b2y = dest.benchmark2Y || {};
    const avg2Y = b2y.avg2YKrw || dest.basePriceKrw || 320000;
    const lowest2Y = b2y.lowest2YKrw || Math.round(avg2Y * 0.55);

    const defaultStayNights =
      dest.region === '일본' || dest.region === '중화권'
        ? 3
        : dest.region === '동남아'
        ? 4
        : 6;

    const citySchedules = [];

    for (const offset of sampleOffsets) {
      const departureDate = addDays(today, offset);
      const returnDate = addDays(departureDate, defaultStayNights);

      // 카드 가격이 같은 일정의 귀국일표·가격 추이·알림 등록 가격과 같도록 별도 할인 계수를 두지 않음
      const outList = computeOneWayCandidateOffers({
        origin,
        destination: dest.code,
        dateStr: departureDate,
        direction: 'OUTBOUND',
        directOnly,
        adults,
        children,
        infants,
        customDestinations
      });
      const bestOut = { ...outList[0] };
      const actualOriginCode = bestOut.originAirportCode || (origin === 'ALL_KOREA' ? 'ICN' : origin);
      const actualOriginCity = bestOut.originAirportCity || originMeta.city;

      const inList = computeOneWayCandidateOffers({
        origin: actualOriginCode,
        destination: dest.code,
        dateStr: returnDate,
        direction: 'INBOUND',
        directOnly,
        adults,
        children,
        infants,
        customDestinations
      });

      const bestIn = { ...inList[0] };
      const combinedAdultPriceKrw = bestOut.oneWayPriceKrw + bestIn.oneWayPriceKrw;
      const discountVs2YAvgPercent = Math.round(((avg2Y - combinedAdultPriceKrw) / avg2Y) * 100);
      const savedVs2YAvgKrw = Math.max(0, avg2Y - combinedAdultPriceKrw);
      const passengerPricing = calculatePassengerPricing(combinedAdultPriceKrw, {
        adults,
        children,
        infants
      });

      const depDateObj = new Date(`${departureDate}T00:00:00`);
      const monthLabel = `${depDateObj.getFullYear()}년 ${depDateObj.getMonth() + 1}월`;

      const bookingLinks = buildBookingLinks({
        origin: actualOriginCode,
        destination: dest.code,
        departureDate,
        returnDate,
        adults: passengerPricing.adults,
        children: passengerPricing.children,
        infants: passengerPricing.infants,
        directOnly,
        outboundAirline: bestOut.airline,
        inboundAirline: bestIn.airline,
        outboundAirlineCode: bestOut.airlineCode,
        inboundAirlineCode: bestIn.airlineCode
      });

      bestOut.naverOneWayUrl = bookingLinks.outboundNaverUrl;
      bestOut.officialBookingUrl = bookingLinks.outboundAirlineOfficialUrl;
      bestIn.naverOneWayUrl = bookingLinks.inboundNaverUrl;
      bestIn.officialBookingUrl = bookingLinks.inboundAirlineOfficialUrl;

      citySchedules.push({
        requestedOrigin: origin,
        origin: actualOriginCode,
        originCity: actualOriginCity,
        destination: dest.code,
        destinationCity: dest.city,
        country: dest.country,
        region: dest.region,
        flightDuration: dest.flightDuration,
        departureDate,
        departureDayOfWeekKo: getDayOfWeekKo(departureDate),
        returnDate,
        returnDayOfWeekKo: getDayOfWeekKo(returnDate),
        monthLabel,
        stayNights: defaultStayNights,
        stayLabel: `${defaultStayNights}박 ${defaultStayNights + 1}일`,
        outboundLeg: bestOut,
        inboundLeg: bestIn,
        combinedAdultPriceKrw,
        totalPassengersPriceKrw: passengerPricing.totalPassengersPriceKrw,
        passengerSummaryText: passengerPricing.passengerSummaryText,
        avg2YKrw: avg2Y,
        lowest2YKrw: lowest2Y,
        top10Deal2YKrw: b2y.top10Deal2YKrw || dest.dealThresholdKrw,
        discountVs2YAvgPercent,
        savedVs2YAvgKrw,
        isNearHistoricLow: combinedAdultPriceKrw <= lowest2Y * 1.08,
        bookingLinks
      });
    }

    citySchedules.sort((a, b) => a.combinedAdultPriceKrw - b.combinedAdultPriceKrw);
    if (citySchedules.length > 0) {
      primaryDealPerCity.push(citySchedules[0]);
      // 특정 권역 선택 시 도시 수가 30개 미만인 경우를 대비하여 월/일정이 다른 차순위 특가도 후보군에 보관
      if (citySchedules[2]) secondaryDealsPool.push(citySchedules[2]);
      if (citySchedules[5]) secondaryDealsPool.push(citySchedules[5]);
    }
  }

  const sortFn = anywhereSortFn(sortBy);
  primaryDealPerCity.sort(sortFn);
  secondaryDealsPool.sort(sortFn);

  const combinedPool = [...primaryDealPerCity];
  if (combinedPool.length < 30) {
    for (const extra of secondaryDealsPool) {
      combinedPool.push(extra);
      if (combinedPool.length >= 30) break;
    }
  }

  return buildAnywhereTop30Response({
    pool: combinedPool,
    sortBy,
    origin,
    originCity: originMeta.city,
    region,
    scannedCitiesCount: targetDests.length,
    horizonDays: 180,
    limit
  });
}

function anywhereSortFn(sortBy) {
  return sortBy === 'HIGHEST_DISCOUNT'
    ? (a, b) =>
        b.discountVs2YAvgPercent - a.discountVs2YAvgPercent ||
        a.combinedAdultPriceKrw - b.combinedAdultPriceKrw
    : (a, b) => a.combinedAdultPriceKrw - b.combinedAdultPriceKrw;
}

/**
 * TOP 30 후보 묶음 → 1~30위 순위와 TOP 10/20/30 세 묶음 (모의 TOP 30 과 실제 운임 TOP 30(프록시)이 같은 모양을 쓴다)
 */
function buildAnywhereTop30Response({
  pool,
  sortBy = 'LOWEST_PRICE',
  origin,
  originCity,
  region = 'ALL',
  scannedCitiesCount = 0,
  horizonDays = 180,
  limit = 30
}) {
  const maxCount = Math.max(10, Math.min(30, Number(limit) || 30));
  const ranked30 = [...pool].sort(anywhereSortFn(sortBy)).slice(0, 30).map((item, index) => {
    const rank = index + 1;
    const tierGroup = rank <= 10 ? 'TOP 10' : rank <= 20 ? 'TOP 20' : 'TOP 30';
    return {
      rank,
      tierGroup,
      ...item
    };
  });

  const buildTierMeta = (sliceItems, cumulativeItems, tierCode, rankStart, rankEnd, title, subtitle) => {
    const prices = sliceItems.map((d) => d.combinedAdultPriceKrw);
    const minPriceKrw = prices.length ? Math.min(...prices) : 0;
    const maxPriceKrw = prices.length ? Math.max(...prices) : 0;
    const avgPriceKrw = prices.length
      ? Math.round(prices.reduce((acc, v) => acc + v, 0) / prices.length / 100) * 100
      : 0;

    return {
      tierCode,
      rankStart,
      rankEnd,
      title,
      label: title,
      subtitle,
      description: subtitle,
      count: sliceItems.length,
      minPriceKrw,
      maxPriceKrw,
      avgPriceKrw,
      items: sliceItems,
      cumulativeItems
    };
  };

  const tierTop10 = buildTierMeta(
    ranked30.slice(0, 10),
    ranked30.slice(0, 10),
    'TOP_10',
    1,
    10,
    '🥇 TOP 10 (1위 ~ 10위 · 초저가 최상위 그룹)',
    '향후 6개월 내 무조건 가장 저렴하게 떠날 수 있는 1~10위 노선'
  );
  const tierTop20 = buildTierMeta(
    ranked30.slice(10, 20),
    ranked30.slice(0, 20),
    'TOP_20',
    11,
    20,
    '🥈 TOP 20 (11위 ~ 20위 · 가성비 인기 그룹)',
    '인기 중·단거리 여행지가 대거 포진된 11~20위 노선'
  );
  const tierTop30 = buildTierMeta(
    ranked30.slice(20, 30),
    ranked30.slice(0, 30),
    'TOP_30',
    21,
    30,
    '🥉 TOP 30 (21위 ~ 30위 · 실속 특가 그룹)',
    '동남아 주요 휴양지 및 대도시 직항이 포함된 21~30위 노선'
  );

  return {
    origin,
    originCity,
    region,
    sortBy,
    scannedCitiesCount,
    horizonDays,
    top10Deals: ranked30.slice(0, maxCount),
    top30Deals: ranked30,
    tiers: {
      top10: tierTop10,
      top20: tierTop20,
      top30: tierTop30
    }
  };
}

/**
 * 오늘의 한국 출발 실시간 편도조합 급락 특가 큐레이션
 */
function getCuratedKoreanDeals() {
  const today = new Date().toISOString().slice(0, 10);

  const featuredSpecs = [
    { origin: 'ICN', destination: 'FUK', depOffset: 15, stayDays: 3, tag: '2년 최저가 근접 🔥' },
    { origin: 'ICN', destination: 'KIX', depOffset: 19, stayDays: 3, tag: '이종 항공사 편도조합 특가' },
    { origin: 'ICN', destination: 'NRT', depOffset: 25, stayDays: 3, tag: '출국 LCC + 귀국 프레미아' },
    { origin: 'PUS', destination: 'TPE', depOffset: 29, stayDays: 3, tag: '김해 출발 편도조합' },
    { origin: 'ICN', destination: 'DAD', depOffset: 33, stayDays: 4, tag: '2년 평균 대비 -29%' },
    { origin: 'ICN', destination: 'PQC', depOffset: 37, stayDays: 4, tag: '푸꾸옥 직항 편도특가' },
    { origin: 'CJJ', destination: 'KIX', depOffset: 27, stayDays: 3, tag: '청주 출발 초특가' },
    { origin: 'ICN', destination: 'GUM', depOffset: 43, stayDays: 4, tag: '유아 동반 가족 추천 👶' }
  ];

  return featuredSpecs.map((item, idx) => {
    const originMeta = getOriginByCode(item.origin);
    const destMeta = getDestinationByCode(item.destination);
    const b2y = destMeta.benchmark2Y || {};
    const departureDate = addDays(today, item.depOffset);
    const returnDate = addDays(departureDate, item.stayDays);

    const outList = computeOneWayCandidateOffers({
      origin: item.origin,
      destination: item.destination,
      dateStr: departureDate,
      direction: 'OUTBOUND',
      directOnly: true,
      jitterRatio: -0.08
    });
    const inList = computeOneWayCandidateOffers({
      origin: item.origin,
      destination: item.destination,
      dateStr: returnDate,
      direction: 'INBOUND',
      directOnly: true,
      jitterRatio: -0.08
    });

    const bestOut = outList[0];
    const bestIn = inList[0];
    const priceKrw = bestOut.oneWayPriceKrw + bestIn.oneWayPriceKrw;
    const avg2YKrw = b2y.avg2YKrw || destMeta.basePriceKrw;
    const discountPercent = Math.round(((avg2YKrw - priceKrw) / avg2YKrw) * 100);
    const suggestedTargetPrice = Math.round((priceKrw * 1.02) / 1000) * 1000;

    return {
      id: `deal_${idx + 1}`,
      origin: item.origin,
      originCity: originMeta.city,
      destination: item.destination,
      destinationCity: destMeta.city,
      country: destMeta.country,
      region: destMeta.region,
      departureDate,
      returnDate,
      staySummary: `${item.stayDays}박 ${item.stayDays + 1}일`,
      priceKrw,
      outboundLeg: bestOut,
      inboundLeg: bestIn,
      airline: `${bestOut.airline}(출국) + ${bestIn.airline}(귀국)`,
      marketAverageKrw: avg2YKrw,
      lowest2YKrw: b2y.lowest2YKrw || Math.round(priceKrw * 0.9),
      discountPercent,
      suggestedTargetPrice,
      tag: item.tag,
      bookingLinks: buildBookingLinks({
        origin: item.origin,
        destination: item.destination,
        departureDate,
        returnDate,
        adults: 1,
        children: 0,
        infants: 0,
        directOnly: true,
        outboundAirline: bestOut.airline,
        inboundAirline: bestIn.airline
      })
    };
  });
}

/**
 * [v2.4] 선택 노선(폼 기준) 편도합산 가격 추이
 * - 지정한 출발일 기준 ±windowDays 범위의 출발일별로, 동일 체류기간(박수)을 유지한
 *   가는편 편도 최저가 · 오는편 편도 최저가 · 편도합산 최저가를 계산합니다.
 * - 등록된 알림 규칙과 무관하게 어떤 도착 도시든 즉시 차트로 표시할 수 있도록 하기 위함
 *   (이전 버전은 첫 번째 알림 규칙(도쿄 나리타)만 차트에 표시되는 오류가 있었음)
 */
function getRoutePriceTrend({
  origin = 'ALL_KOREA',
  destination = 'NRT',
  customCityName = '',
  customDestinations = [],
  departureDate,
  returnDate,
  adults = 1,
  children = 0,
  infants = 0,
  directOnly = true,
  windowDays = 7,
  fareQuote = null
}) {
  const originMeta = getOriginByCode(origin);
  const destMeta = getDestinationByCode(destination, customDestinations, customCityName);
  const benchmark2Y = destMeta.benchmark2Y || {};
  const quote = resolveFareQuote(fareQuote);
  const byAirport = pairsByKoreanAirport(fareQuote, origin);

  const todayStr = new Date().toISOString().slice(0, 10);
  const safeDep = departureDate || addDays(todayStr, 21);
  let stayNights = 3;
  if (returnDate) {
    const diff = Math.round(
      (new Date(`${returnDate}T00:00:00Z`) - new Date(`${safeDep}T00:00:00Z`)) / 86400000
    );
    // 당일 귀국(0박)과 긴 체류도 실제 일정 그대로 써야 선택일 가격이 알림 등록 가격과 같다
    if (diff >= 0 && diff <= MAX_TREND_STAY_NIGHTS) stayNights = diff;
  }

  const tomorrow = addDays(todayStr, 1);
  let startDate = addDays(safeDep, -windowDays);
  if (startDate < tomorrow) startDate = tomorrow;
  const totalPoints = windowDays * 2 + 1;

  const points = [];
  for (let i = 0; i < totalPoints; i++) {
    const depDate = addDays(startDate, i);
    const retDate = addDays(depDate, stayNights);

    const outCandidates = quote({
      origin,
      destination,
      dateStr: depDate,
      direction: 'OUTBOUND',
      directOnly,
      adults,
      children,
      infants,
      customDestinations,
      customCityName
    });
    // 실제 운임 캘린더에 값이 없는 출발일·귀국일은 점을 찍지 않는다
    if (!outCandidates.length) continue;
    const firstOut = outCandidates[0];
    const actualOriginCode = firstOut.originAirportCode || (origin === 'ALL_KOREA' ? 'ICN' : origin);

    const inCandidates = quote({
      origin: byAirport ? 'ALL_KOREA' : actualOriginCode,
      destination,
      dateStr: retDate,
      direction: 'INBOUND',
      directOnly,
      adults,
      children,
      infants,
      customDestinations,
      customCityName
    });
    if (!inCandidates.length) continue;
    const pair = byAirport ? cheapestSameAirportPair(outCandidates, inCandidates) : null;
    if (byAirport && !pair) continue;
    const bestOut = pair ? pair.out : firstOut;
    const bestIn = pair ? pair.back : inCandidates[0];
    const combinedAdultPriceKrw = bestOut.oneWayPriceKrw + bestIn.oneWayPriceKrw;

    points.push({
      departureDate: depDate,
      returnDate: retDate,
      departureDayOfWeekKo: getDayOfWeekKo(depDate),
      returnDayOfWeekKo: getDayOfWeekKo(retDate),
      origin: pair ? pair.out.originAirportCode : actualOriginCode,
      outboundAirline: bestOut.airline,
      inboundAirline: bestIn.airline,
      outboundPriceKrw: bestOut.oneWayPriceKrw,
      inboundPriceKrw: bestIn.oneWayPriceKrw,
      combinedAdultPriceKrw,
      totalPassengersPriceKrw: calculatePassengerPricing(combinedAdultPriceKrw, { adults, children, infants })
        .totalPassengersPriceKrw,
      isSelectedDate: depDate === safeDep
    });
  }

  const cheapest = [...points].sort((a, b) => a.combinedAdultPriceKrw - b.combinedAdultPriceKrw)[0] || null;
  const selected = points.find((p) => p.isSelectedDate) || null;

  return {
    requestedOrigin: origin,
    originCity: originMeta.city,
    destination,
    destinationCity: destMeta.city,
    departureDate: safeDep,
    stayNights,
    benchmark2Y: {
      avg2YKrw: benchmark2Y.avg2YKrw || destMeta.basePriceKrw,
      lowest2YKrw: benchmark2Y.lowest2YKrw || Math.round((destMeta.basePriceKrw || 300000) * 0.6),
      top10Deal2YKrw: benchmark2Y.top10Deal2YKrw || destMeta.dealThresholdKrw
    },
    cheapestPoint: cheapest,
    selectedPoint: selected,
    points
  };
}

module.exports = {
  LIVE_FARE_SOURCE_APIS,
  CACHED_FARE_SOURCE_APIS,
  isSimulatedFareSource,
  describeFareSource,
  fetchLowestRoundTripPrice,
  getReturnDatePriceMatrix,
  getRecommendedCheapSchedules,
  getFlexibleDateDeals,
  scanTargetPriceDeals,
  rebuildExternalTargetScan,
  withRoundTripLinks,
  withoutRoundTripLinks,
  getAnywhereTop10Next6Months,
  buildAnywhereTop30Response,
  getCuratedKoreanDeals,
  getRoutePriceTrend
};
