/**
 * SkyBell KR 실제 운임 모드 — PIN 을 확인한 뒤 프록시(Vercel)로 실제 운임을 받아 온다 (app.js 다음에 불러온다)
 * - 조회량이 많은 기능(TOP 30 · 12개월 시세 · 귀국일표 · 추천 일정 · 가격 추이 · ±3일 최저가 · 목표가 알림 등록·훑기):
 *   Travelpayouts 최근 검색가 (다른 이용자들이 최근 검색한 가격 — 길게는 1주일 전 값이라 구간마다 검색한 날을 보여 준다,
 *   실시간 아님 · 무료 한도가 넉넉함 · ±3일 최저가와 목표가 알림 화면은 flexTargetUi.js)
 * - 날짜 지정 알림(이전 방식 · 새로 등록하지 않음)의 재조회·일괄 조회만 구글 플라이트 실시간 조회
 *   (SerpApi 무료 월 250회, 한 번에 가는 편·오는 편 2회 · 일괄 조회는 확인 창으로 먼저 묻는다)
 * - PIN 은 이 탭의 sessionStorage 에만 둔다 (탭을 닫으면 지워짐). 맞는 PIN 값은 프록시 환경 변수에만 있다.
 * - 실제 조회가 실패하면 그 기능만 모의 가격으로 보여 주고 이유를 표시한다.
 */

const REAL_FARE_PROXY_URL = String(window.SKYBELL_PROXY_URL || 'https://skybell-fare-proxy.vercel.app').replace(/\/+$/, '');
const REAL_FARE_PIN_STORAGE_KEY = 'SKYBELL_REAL_FARE_PIN';
const REAL_FARE_PIN_PATTERN = /^\d{4,8}$/;
const REAL_FARE_TIMEOUT_MS = 58000; // 프록시 함수 최대 실행 시간(60초)보다 조금 짧게
const REAL_FARE_SESSION_TIMEOUT_MS = 10000; // PIN 확인은 금방 끝난다 — 프록시가 멈춰도 화면 시작을 오래 막지 않게
const CACHED_FARE_SOURCE = 'TRAVELPAYOUTS_PRICES';
const LIVE_FARE_SOURCE = 'SERPAPI_GOOGLE_FLIGHTS';

const realFareState = {
  enabled: false, // PIN 확인을 거쳐 실제 운임 모드인지
  pin: '',
  providers: { serpapi: false, travelpayouts: false } // 프록시에 키가 들어 있는 공급자
};

class RealFareError extends Error {
  constructor(code, message, status = 0, retryAfterSec = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

function readStoredRealFarePin() {
  try {
    return sessionStorage.getItem(REAL_FARE_PIN_STORAGE_KEY) || '';
  } catch (_e) {
    return '';
  }
}

function storeRealFarePin(pin) {
  try {
    if (pin) sessionStorage.setItem(REAL_FARE_PIN_STORAGE_KEY, pin);
    else sessionStorage.removeItem(REAL_FARE_PIN_STORAGE_KEY);
  } catch (_e) {
    // 저장소를 못 쓰는 창(사생활 보호 등)에서는 이 페이지를 떠나면 PIN 을 다시 넣는다
  }
}

/**
 * 프록시 응답 정리 — 외부 API 에서 온 글자는 화면(innerHTML·onclick)에 들어가므로 믿지 않는다
 * - 링크(…Url): https 주소만 남긴다 (그 밖은 빈 값 → 화면에서 '#')
 * - 가격·박수 같은 숫자 칸: 숫자만 남긴다 (onclick 인자로 들어가는 값)
 * - 그 밖의 글자: 태그·따옴표·& · 역슬래시·제어 문자를 지운다
 */
const UNSAFE_TEXT_CHARS = /[\x00-\x1f\x7f<>"'`&\\]/g;
const SAFE_URL_PATTERN = /^https:\/\/[^\s"'<>`\\]+$/i;
const NUMERIC_KEY_PATTERN = /(?:Krw|Percent|Nights|Days|Count|Sec|Minutes)$|^(?:rank|rankStart|rankEnd|count|stops|transfers)$/;
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_PAYLOAD_DEPTH = 12;
const MAX_ARRAY_ITEMS = 500;
const MAX_TEXT_LENGTH = 300;

function sanitizeProxyValue(value, key = '', depth = 0) {
  if (depth > MAX_PAYLOAD_DEPTH) return null;
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeProxyValue(item, key, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    Object.entries(value).forEach(([k, v]) => {
      if (!BLOCKED_KEYS.has(k)) out[k] = sanitizeProxyValue(v, k, depth + 1);
    });
    return out;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    if (/Url$/i.test(key)) return SAFE_URL_PATTERN.test(value) ? value : '';
    if (NUMERIC_KEY_PATTERN.test(key)) {
      const n = Number(value);
      return value.trim() !== '' && Number.isFinite(n) ? n : null;
    }
    return value.replace(UNSAFE_TEXT_CHARS, '').slice(0, MAX_TEXT_LENGTH);
  }
  if (typeof value === 'boolean' || value === null) return value;
  return null;
}

/**
 * 프록시 호출 — PIN 은 X-Access-Pin 머리글로만 보낸다 (주소·저장소 밖으로 내보내지 않음)
 */
async function proxyFetch(route, { params = null, method = 'GET', pin = realFareState.pin, timeoutMs = REAL_FARE_TIMEOUT_MS } = {}) {
  const query = params ? `?${new URLSearchParams(params).toString()}` : '';
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    let res;
    try {
      res = await fetch(`${REAL_FARE_PROXY_URL}/api/${route}${query}`, {
        method,
        headers: { 'X-Access-Pin': pin },
        cache: 'no-store',
        credentials: 'omit',
        signal: controller ? controller.signal : undefined
      });
    } catch (_err) {
      throw new RealFareError('NETWORK', '실제 운임 프록시에 연결하지 못했습니다.');
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const message = String(body?.error || `실제 운임 조회 실패 (HTTP ${res.status})`).replace(UNSAFE_TEXT_CHARS, '');
      const retryAfterSec = Number.isFinite(Number(body?.retryAfterSec)) ? Number(body.retryAfterSec) : null;
      throw new RealFareError(String(body?.code || `HTTP_${res.status}`).replace(UNSAFE_TEXT_CHARS, ''), message, res.status, retryAfterSec);
    }
    if (!body || typeof body !== 'object') throw new RealFareError('BAD_RESPONSE', '실제 운임 프록시의 응답을 읽지 못했습니다.', res.status);
    return sanitizeProxyValue(body);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isRealFareActive(provider) {
  return realFareState.enabled && Boolean(realFareState.providers[provider]);
}

// 실제 조회 실패를 짧은 화면 문구로 바꾼다. PIN 이 더는 맞지 않으면(바뀐 경우) 실제 운임 모드를 끈다
function describeRealFareFailure(err) {
  const code = err?.code || '';
  if (code === 'PIN_INVALID') {
    if (realFareState.enabled) exitRealFareMode({ reload: false, message: 'PIN 이 바뀌었거나 맞지 않아 모의 가격으로 돌아갑니다.' });
    return 'PIN 이 맞지 않음';
  }
  if (code === 'PIN_LOCKED') return `PIN 잠김 · ${Math.ceil((err.retryAfterSec || 600) / 60)}분 뒤 다시`;
  if (code === 'PROVIDER_NOT_CONFIGURED') return '프록시에 API 키가 아직 없음';
  if (code === 'TP_RATE_LIMIT' || code === 'SERPAPI_LIMIT') return '무료 조회 한도 초과';
  if (code === 'NETWORK') return '프록시 연결 실패';
  return err?.message || '실제 운임 조회 실패';
}

/**
 * 조회량이 많은 기능의 공통 로더: 실제 운임 모드면 Travelpayouts(프록시), 아니면(또는 실패하면) 앱의 모의 가격 엔진
 * - loadSimulated 는 app.js 의 apiFetch('/api/…') 호출 (모의 가격 경로를 app.js 에 그대로 둔다)
 */
async function loadFareFeature(route, params, loadSimulated) {
  let fallbackReason = null;
  if (isRealFareActive('travelpayouts')) {
    try {
      return await proxyFetch(route, { params });
    } catch (err) {
      fallbackReason = describeRealFareFailure(err);
    }
  } else if (realFareState.enabled) {
    fallbackReason = 'Travelpayouts 토큰이 프록시에 아직 없음';
  }
  const res = await loadSimulated();
  const data = await res.json();
  return fallbackReason ? { ...data, realFareFallback: fallbackReason } : data;
}

/**
 * 가격 출처 표시 (모의 / 최근 검색가 / 실시간)
 */
const CACHED_FARE_CHIP_HTML =
  '<span data-cached-fare-chip class="ml-1 align-middle text-[10px] font-bold px-1.5 py-0.5 rounded bg-sky-100 text-sky-800 border border-sky-200" title="다른 이용자들이 최근 검색한 실제 운임입니다 (실시간 아님 · 길게는 1주일 전 값이라 구간마다 검색한 날을 표시)">최근 검색가</span>';

function liveFareChipHtml(fetchedAt) {
  const when = fetchedAt ? ` ${formatDateTime(fetchedAt)}` : '';
  return `<span data-live-fare-chip class="ml-1 align-middle text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 border border-emerald-200" title="구글 플라이트에서 조회한 실시간 운임입니다">실시간${escapeHtml(when)}</span>`;
}

function fareChipHtml(sourceApi, fetchedAt = null) {
  const kind = describeFareSource(sourceApi);
  if (kind === 'LIVE') return liveFareChipHtml(fetchedAt);
  if (kind === 'CACHED') return CACHED_FARE_CHIP_HTML;
  return SIMULATED_FARE_CHIP_HTML;
}

function bookingNoteHtml(sourceApi, fetchedAt = null) {
  const kind = describeFareSource(sourceApi);
  if (kind === 'CACHED') {
    return '<div data-cached-fare-note class="text-[10px] text-sky-800 font-semibold">ℹ️ 최근 검색가(실시간 아님) · 좌석·최종 가격은 예약 사이트에서 다시 확인하세요</div>';
  }
  if (kind === 'LIVE') {
    const when = fetchedAt ? ` (${escapeHtml(formatDateTime(fetchedAt))} 조회)` : '';
    return `<div data-live-fare-note class="text-[10px] text-emerald-800 font-semibold">ℹ️ 실시간 조회가${when} · 좌석·가격은 수시로 바뀝니다</div>`;
  }
  return BOOKING_LINK_NOTE_HTML;
}

// 최근 검색가가 검색된 날 (프록시가 출처 링크의 search_date 에서 뽑음) — 2일 이상 지나면 주황 (10-19 실측: 지금 값과 −5~+51%)
// search_date 는 한국보다 늦은 시간대의 날짜라 한국 자정 직후엔 하루 더 묵어 보일 수 있다 (덜 묵어 보이는 것보다 안전한 쪽)
const STALE_SEARCH_DAYS = 2;
const KST_OFFSET_MS = 9 * 3600000;
const DAY_MS = 86400000;

function searchedOnHtml(leg, now = Date.now()) {
  const on = String(leg?.searchedOn || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) return '';
  const todayKst = new Date(now + KST_OFFSET_MS).toISOString().slice(0, 10);
  const days = Math.round((Date.parse(`${todayKst}T00:00:00Z`) - Date.parse(`${on}T00:00:00Z`)) / DAY_MS);
  // 하루 앞선 날은 기기 시계 차이로 보고 '오늘', 그보다 앞서면 믿지 않는다 (묵은 값이 새것처럼 보이지 않게)
  if (!Number.isFinite(days) || days < -1) return '';
  const ago = days <= 0 ? '오늘' : `${days}일 전`;
  const tone = days >= STALE_SEARCH_DAYS ? 'text-amber-700 font-bold' : 'text-slate-400 font-semibold';
  return `<span data-searched-on="${on}" class="whitespace-nowrap ${tone}" title="이 값이 검색된 날입니다 — 지금 예약 사이트 금액과 다를 수 있습니다">${on.slice(5, 7)}/${on.slice(8, 10)} 검색 · ${ago}</span>`;
}

// 예약 링크가 실제로 연 인원 (bookingLinks.bookingMeta · 알림 규칙) — 그 사이 바뀌었을 수 있는 화면 폼은 쓰지 않는다
// 링크에 넣는 인원과 같은 범위로 센다 (설명의 'N명 총액' 이 링크가 연 인원과 어긋나지 않게)
function linkPartyOf(meta) {
  const { adults, children, infants } = linkPassengerCounts(meta);
  const kids = children + infants;
  return { total: adults + kids, hasKids: kids > 0 };
}

// 구글 링크 금액의 기준 — 1명이면 카드의 구간 금액과 같고, 2명 이상이면 구글이 그 인원 총액으로 보여 준다
function googlePartyBasis(party) {
  const { total, hasKids } = linkPartyOf(party);
  return total > 1
    ? `${total}명 총액으로 나옵니다 — 두 구간을 더해 카드의 총액과 비교하세요${hasKids ? ' (소아·유아 금액은 앱이 추정한 값)' : ''}`
    : '카드의 구간 금액(1인 편도)과 같은 기준';
}

const DEFAULT_LEG_LINK_CLASS = 'text-emerald-700 hover:underline font-bold';
// '구글' 이라고 적는 링크는 구글 플라이트 주소만 (노선 검색 /travel/flights/search · 예약 화면 /travel/flights/booking)
const GOOGLE_FLIGHTS_URL_PATTERN = /^https:\/\/www\.google\.com\/travel\/flights(?:\/[a-z]+)?\?[^\s"'<>`\\]*$/;

// 구간별 구글 플라이트 편도 검색(노선 검색) — 모의 가격이거나 그 항공편을 특정할 수 없을 때 쓴다
function googleOneWayLinkHtml(url, { party, className = DEFAULT_LEG_LINK_CLASS } = {}) {
  if (!GOOGLE_FLIGHTS_URL_PATTERN.test(String(url || ''))) return '';
  // 카드를 눌러 하는 일(차트 선택·귀국일 선택)은 하지 않고 링크만 연다
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" class="whitespace-nowrap ${escapeHtml(className)}" title="구글 플라이트에서 이 구간만 편도로 검색합니다 — ${googlePartyBasis(party)}">구글 편도 ↗</a>`;
}

/**
 * 가격을 가져온 곳에서 '그 항공편'을 여는 예약 링크 (2026-10-20 실제 사이트에서 확인)
 * - 최근 검색가(Travelpayouts): 그 값이 나온 Aviasales 검색의 공유 링크(sourceUrl — 항공편 서명 t·기대 가격·itinerary_key).
 *   열면 주소창의 매개변수는 지워지지만 그 항공편의 판매처별 가격 창이 뜬다. currency=krw 를 붙이면 원화
 *   (화면 글자는 영어 · 값을 모은 조건 그대로 성인 1명)
 * - 실시간(구글 플라이트 · SerpApi): 편명·날짜·공항으로 만든 구글 '선택한 항공편' 예약 화면 (판매처별 가격)
 *   — 최근 검색가 구간에도 '구글 같은 편' 으로 붙인다 (같은 항공편의 지금 구글 값)
 * - 모의 가격은 편명이 계산식이라 특정 항공편 링크를 만들지 않는다 (지금처럼 '구글 편도' 노선 검색)
 */
// 엔진·프록시의 검사보다 좁게 — /search/ 뒤 검색 코드 한 칸(+ 매개변수)만: 점 경로(../)로 같은 사이트의 다른 곳을 열지 않게
const AVIASALES_TICKET_URL_PATTERN = /^https:\/\/www\.aviasales\.com\/search\/[A-Za-z0-9]+(?:\?[A-Za-z0-9=&_.%:\/-]*)?$/;
const IATA_CODE_PATTERN = /^[A-Z]{3}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const AIRLINE_CODE_PATTERN = /^[A-Z0-9]{2}$/;
const FLIGHT_NUMBER_DIGITS_PATTERN = /^\d{1,4}$/;
const SOURCE_LINK_SHAPE = 'inline-flex items-center rounded-md px-1.5 py-0.5';
const SOURCE_LINK_COLORS = { aviasales: 'bg-sky-600 hover:bg-sky-500', google: 'bg-emerald-600 hover:bg-emerald-500' };

function aviasalesTicketUrl(sourceUrl) {
  const url = String(sourceUrl || '');
  if (!AVIASALES_TICKET_URL_PATTERN.test(url)) return '';
  if (/[?&]currency=/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}currency=krw`;
}

// 구글 플라이트 tfs (프로토콜 버퍼 → base64url) — src/config/airports.js 의 노선 검색 링크와 같은 칸에,
// 구간(3) 안 '선택한 항공편'(4: 1 출발 · 2 날짜 · 3 도착 · 5 항공사 · 6 편 번호)을 더한다 (10-20 구글 예약 화면에서 확인)
// 인원 번호도 엔진과 같다 (1 성인 · 2 소아 · 3 무릎 유아) — 같은 인코딩인지는 시험이 엔진 링크와 맞춰 본다
const GOOGLE_TFS_PASSENGER = { ADULT: 1, CHILD: 2, LAP_INFANT: 3 };
const GOOGLE_TFS_NO_PRICE_LIMIT = [0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]; // { 1: -1 }
const MAX_LINK_PASSENGERS_PER_TYPE = 9; // 엔진 MAX_PASSENGERS_PER_TYPE 와 같은 상한

function tfsVarint(value) {
  const bytes = [];
  let rest = value;
  while (rest > 0x7f) {
    bytes.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  bytes.push(rest);
  return bytes;
}

const tfsVarintField = (fieldNumber, value) => [...tfsVarint(fieldNumber * 8), ...tfsVarint(value)];
const tfsBytesField = (fieldNumber, bytes) => [...tfsVarint(fieldNumber * 8 + 2), ...tfsVarint(bytes.length), ...bytes];
const tfsString = (text) => Array.from(new TextEncoder().encode(String(text)));
const tfsAirport = (code) => [...tfsVarintField(1, 1), ...tfsBytesField(2, tfsString(code))];

// 링크에 넣는 인원 (엔진 normalizePassengerCounts 와 같은 범위 — 유아는 성인 1명당 1명까지)
function linkPassengerCounts(meta) {
  const clamp = (value, min, max) => Math.min(max, Math.max(min, Math.floor(Number(value)) || 0));
  const adults = clamp(meta?.adults, 1, MAX_LINK_PASSENGERS_PER_TYPE);
  return { adults, children: clamp(meta?.children, 0, MAX_LINK_PASSENGERS_PER_TYPE), infants: clamp(meta?.infants, 0, adults) };
}

function googleFlightsTfs({ from, to, date, party, directOnly = true, selected = null }) {
  const { adults, children, infants } = linkPassengerCounts(party);
  const selectedFlight = selected
    ? tfsBytesField(4, [
        ...tfsBytesField(1, tfsString(from)),
        ...tfsBytesField(2, tfsString(date)),
        ...tfsBytesField(3, tfsString(to)),
        ...tfsBytesField(5, tfsString(selected.airlineCode)),
        ...tfsBytesField(6, tfsString(selected.number))
      ])
    : [];
  const leg = [
    ...tfsBytesField(2, tfsString(date)),
    ...selectedFlight,
    ...(directOnly ? tfsVarintField(5, 0) : []),
    ...tfsBytesField(13, tfsAirport(from)),
    ...tfsBytesField(14, tfsAirport(to))
  ];
  const passengers = [
    ...Array(adults).fill(GOOGLE_TFS_PASSENGER.ADULT),
    ...Array(children).fill(GOOGLE_TFS_PASSENGER.CHILD),
    ...Array(infants).fill(GOOGLE_TFS_PASSENGER.LAP_INFANT)
  ];
  const message = [
    ...tfsVarintField(1, 28),
    ...tfsVarintField(2, 2),
    ...tfsBytesField(3, leg),
    ...passengers.flatMap((type) => tfsVarintField(8, type)),
    ...tfsVarintField(9, 1), // 이코노미
    ...tfsVarintField(14, 1),
    ...tfsBytesField(16, GOOGLE_TFS_NO_PRICE_LIMIT),
    ...tfsVarintField(19, 2) // 편도
  ];
  return btoa(String.fromCharCode(...message)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// 구간 한 장을 '그 항공편'으로 특정할 수 있는지 — 직항 · 항공사 코드 + 숫자 1~4자리 편 번호 · 공항·날짜 꼴 (아니면 null)
// 경유 편은 첫 구간 편명만 알아 구글 '선택한 항공편'을 다 채울 수 없다
function selectedFlightOf(leg) {
  if (!leg || leg.stops !== 0) return null;
  const airlineCode = String(leg.airlineCode || '');
  const flightNumber = String(leg.flightNumber || '');
  const number = flightNumber.slice(airlineCode.length);
  if (!AIRLINE_CODE_PATTERN.test(airlineCode) || !flightNumber.startsWith(airlineCode) || !FLIGHT_NUMBER_DIGITS_PATTERN.test(number)) {
    return null;
  }
  const routeOk = IATA_CODE_PATTERN.test(String(leg.fromAirportCode || '')) && IATA_CODE_PATTERN.test(String(leg.toAirportCode || ''));
  return routeOk && ISO_DATE_PATTERN.test(String(leg.date || '')) ? { airlineCode, number } : null;
}

// 구글 '선택한 항공편' 예약 화면 — 그 편의 판매처(항공사·여행사)별 가격, 인원은 그 카드 링크의 인원
function googleFlightBookingUrl(leg, party) {
  const selected = selectedFlightOf(leg);
  if (!selected) return '';
  const tfs = googleFlightsTfs({ from: leg.fromAirportCode, to: leg.toAirportCode, date: leg.date, party, directOnly: true, selected });
  return `https://www.google.com/travel/flights/booking?tfs=${tfs}&hl=ko&gl=kr&curr=KRW`;
}

// 링크 설명에 넣는 '편명 MM/DD'
function flightTitleText(leg) {
  const date = String(leg?.date || '');
  return `${String(leg?.flightNumber || '')}${ISO_DATE_PATTERN.test(date) ? ` ${date.slice(5, 7)}/${date.slice(8, 10)}` : ''}`;
}

// 카드를 눌러 하는 일(차트 선택·귀국일 선택)은 하지 않고 링크만 연다 · 좁은 카드에서 글자 중간에 줄이 끊기지 않게 한 덩어리
// dataName: 화면 확인용 data 속성 이름 (영문 소문자와 '-' 만 — 아니면 그 속성 없이)
function legLinkHtml(url, { label, title, className, dataName = '', dataValue = '' }) {
  const dataAttr = /^[a-z]+(?:-[a-z]+)*$/.test(dataName) ? ` data-${dataName}="${escapeHtml(dataValue)}"` : '';
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()"${dataAttr} class="whitespace-nowrap ${escapeHtml(className)}" title="${escapeHtml(title)}">${escapeHtml(label)}</a>`;
}

const sourceLinkClass = (site, shape) => `${shape || SOURCE_LINK_SHAPE} ${SOURCE_LINK_COLORS[site]} text-white font-extrabold transition`;

/**
 * 구간 한 줄의 예약 링크 — 가격 출처(그 항공편)를 맨 앞에, 이어서 구글 같은 편, 특정할 수 없으면 노선 검색(구글 편도)
 * fareSource: 그 카드·알림의 출처(sourceApi) — 어떤 링크를 붙일지는 이것으로만 정한다 (구간의 출처 칸은 쓰지 않음)
 * routeGoogleUrl: 그 구간의 구글 노선 검색 주소 · party: 링크가 여는 인원
 * linkClass: 보조 링크 모양 · primaryShape: 가격 출처 링크의 크기·모서리 (색은 사이트마다 정해 둔다)
 */
function legBookingLinksHtml(leg, { fareSource = '', routeGoogleUrl = '', party, linkClass = DEFAULT_LEG_LINK_CLASS, primaryShape = '' } = {}) {
  const kind = describeFareSource(fareSource);
  const routeLinkHtml = googleOneWayLinkHtml(routeGoogleUrl, { party, className: linkClass });
  if (kind === 'SIMULATED') return routeLinkHtml;

  const flightUrl = googleFlightBookingUrl(leg, party);
  const flight = flightTitleText(leg);
  const basis = googlePartyBasis(party);
  if (fareSource === LIVE_FARE_SOURCE) {
    // 구글 플라이트 실시간: 가격 출처가 구글 — 그 항공편 예약 화면, 특정할 수 없으면(경유 편) 그 노선 검색 결과
    const url = flightUrl || (GOOGLE_FLIGHTS_URL_PATTERN.test(String(routeGoogleUrl || '')) ? routeGoogleUrl : '');
    if (!url) return '';
    const title = flightUrl
      ? `이 가격을 조회한 구글 플라이트에서 이 항공편(${flight})의 예약 화면(판매처별 가격)을 엽니다 — ${basis}`
      : `이 가격을 조회한 구글 플라이트의 이 구간 검색 결과에서 ${flight} 를 고르세요 — ${basis}`;
    return legLinkHtml(url, { label: '가격 출처 구글 ↗', title, className: sourceLinkClass('google', primaryShape), dataName: 'source-link', dataValue: 'google' });
  }

  const parts = [];
  const aviasalesUrl = kind === 'CACHED' ? aviasalesTicketUrl(leg?.sourceUrl) : '';
  if (aviasalesUrl) {
    const { total } = linkPartyOf(party);
    const title = `이 가격을 가져온 Aviasales 에서 이 항공편(${flight})의 판매처별 가격을 엽니다 — 1인 기준 · 원화(화면 글자는 영어) · 검색한 날 뒤로 값이 바뀌었을 수 있습니다${
      total > 1 ? ` · ${total}명은 그 화면에서 인원을 바꾸세요` : ''
    }`;
    parts.push(
      legLinkHtml(aviasalesUrl, { label: '가격 출처 Aviasales ↗', title, className: sourceLinkClass('aviasales', primaryShape), dataName: 'source-link', dataValue: 'aviasales' })
    );
  }
  parts.push(
    flightUrl
      ? legLinkHtml(flightUrl, {
          label: '구글 같은 편 ↗',
          title: `구글 플라이트에서 같은 항공편(${flight})의 예약 화면(판매처별 지금 가격)을 엽니다 — ${basis} · 구글에 없거나 매진인 편은 더 이상 예약할 수 없다고 나옵니다`,
          className: linkClass,
          dataName: 'same-flight-link',
          dataValue: 'google'
        })
      : routeLinkHtml
  );
  return parts.join('');
}

// 큰 예약 버튼(왕복 검색) 위 안내 — 왕복 운임은 편도 두 장 합과 다를 수 있다. 2명 이상이면 구글 링크는 인원 총액,
// 트립닷컴 왕복은 1인 가격으로 보여 준다 (10-19 실측) — 트립닷컴 버튼이 없는 카드(귀국일표 칸)는 tripCom: false
// legs: 그 카드의 가는 편·오는 편 — 안내는 구간에 실제로 붙은 링크(가격 출처 → 구글 같은 편 → 구글 편도)를 가리킨다
// (출처 링크를 저장하지 않은 옛 알림·Amadeus 실시간에는 '가격 출처' 가 없다 · 최근 검색가의 Aviasales 는 1인 가격으로 열린다)
function roundTripLinksNoteHtml(party, { tripCom = true, fareSource = '', legs = [] } = {}) {
  const { total, hasKids } = linkPartyOf(party);
  const kind = describeFareSource(fareSource);
  const realLegs = kind === 'SIMULATED' ? [] : legs.filter(Boolean);
  const hasAviasales = kind === 'CACHED' && realLegs.some((leg) => aviasalesTicketUrl(leg.sourceUrl));
  const hasSourceLink = hasAviasales || (fareSource === LIVE_FARE_SOURCE && realLegs.length > 0);
  const linkText = hasSourceLink
    ? "카드의 그 항공편은 구간별 '가격 출처'"
    : realLegs.some((leg) => selectedFlightOf(leg))
    ? "카드의 그 항공편은 구간별 '구글 같은 편'"
    : "같은 기준은 구간별 '구글 편도'";
  const partyText =
    total > 1
      ? ` — ${total}명 총액이라 두 구간을 더해 총액과 비교${hasAviasales ? ' · Aviasales 는 1인 가격' : ''}${tripCom ? ' · 트립닷컴 왕복은 1인 가격' : ''}${hasKids ? ' · 소아·유아 금액은 앱 추정' : ''}`
      : '';
  return `<div data-round-trip-note class="text-[10px] text-slate-500 font-semibold">↘ 아래 버튼은 왕복 검색이라 '편도 두 장 합'과 금액이 다를 수 있어요 · ${linkText}${partyText}</div>`;
}

// 각 기능 위에 붙는 출처 한 줄 (실제 운임이면 수집 시각, 실제 조회가 실패했으면 그 이유)
function fareSourceLineHtml(data) {
  if (data?.realFare) {
    const when = data.fetchedAt ? ` · ${formatDateTime(data.fetchedAt)} 수집` : '';
    const partial = data.partial ? ' · 일부 조회 실패' : '';
    return `<div data-fare-source-line="CACHED" class="text-[11px] font-semibold text-sky-900 bg-sky-50 border border-sky-200 rounded-lg px-2.5 py-1.5">📡 실제 운임 · Travelpayouts 최근 검색가 (다른 이용자들이 최근 검색한 가격 · 길게는 1주일 전 값 · 실시간 아님${escapeHtml(when + partial)})</div>`;
  }
  if (data?.realFareFallback) {
    return `<div data-fare-source-line="FALLBACK" class="text-[11px] font-semibold text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">⚠️ 실제 운임 조회 실패(${escapeHtml(data.realFareFallback)}) → 아래는 모의 가격입니다</div>`;
  }
  return '';
}

function setFareSourceLine(elementId, data) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const html = fareSourceLineHtml(data);
  el.innerHTML = html;
  el.classList.toggle('hidden', !html);
}

/**
 * 맨 위 가격 출처 안내 + 실제 운임 모드 켜기/끄기
 */
function providerChipHtml(label, ready) {
  return ready
    ? `<span class="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 border border-emerald-200">✓ ${label}</span>`
    : `<span class="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200" title="프록시에 이 공급자의 키가 아직 없어 해당 기능은 모의 가격으로 보입니다">${label} 미설정 → 모의 가격</span>`;
}

function renderRealFareNotice() {
  const el = document.getElementById('simulatedPriceNotice');
  if (!el) return;
  const buttonBase = 'shrink-0 text-[11px] sm:text-xs px-3 py-1.5 rounded-xl font-extrabold transition active:scale-95';
  if (!realFareState.enabled) {
    el.dataset.fareMode = 'SIMULATED';
    el.className = 'rounded-2xl border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-[11px] sm:text-xs text-amber-900 leading-relaxed flex flex-col sm:flex-row sm:items-center gap-2';
    el.innerHTML = `
      <div class="flex-1">
        <b>⚠️ 모의 가격 안내</b> · 이 앱의 운임·편명·출발 시각·2년 시세는 실제 항공권 데이터가 아니라 계산식으로 만든 <b>모의 값</b>이라 예약 사이트 가격과 다릅니다.
        실제 가격·좌석과 그 노선의 직항 운항 여부는 각 카드의 예약 링크(네이버·구글 플라이트·트립닷컴 등)에서 확인하세요.
      </div>
      <button type="button" onclick="openRealFarePinModal()" class="${buttonBase} bg-slate-900 hover:bg-slate-800 text-white">🔑 PIN 으로 실제 운임 보기</button>
    `;
    return;
  }
  const { serpapi, travelpayouts } = realFareState.providers;
  el.dataset.fareMode = 'REAL';
  el.className = 'rounded-2xl border border-emerald-300 bg-emerald-50 px-3.5 py-2.5 text-[11px] sm:text-xs text-emerald-950 leading-relaxed flex flex-col sm:flex-row sm:items-center gap-2';
  el.innerHTML = `
    <div class="flex-1 space-y-1">
      <div>
        <b>✅ 실제 운임 모드</b> · ±3일 최저가·목표가 알림·TOP 30·12개월 시세·귀국일표·추천 일정·가격 추이는 <b>Travelpayouts 최근 검색가</b>(다른 이용자들이 최근 검색한 가격 · 길게는 1주일 전 값이라 구간마다 검색한 날을 표시 · 실시간 아님 · 구글 플라이트 검색 횟수를 쓰지 않음),
        이전에 등록한 날짜 지정 알림의 재조회만 <b>구글 플라이트 실시간 조회</b>(SerpApi 무료 월 250회 · 한 번에 2회)를 씁니다. 좌석·최종 가격은 예약 사이트에서 확인하세요.
      </div>
      <div class="flex flex-wrap items-center gap-1.5">
        ${providerChipHtml('Travelpayouts', travelpayouts)}
        ${providerChipHtml('구글 플라이트(SerpApi)', serpapi)}
      </div>
    </div>
    <button type="button" onclick="exitRealFareMode()" class="${buttonBase} bg-white border border-emerald-300 hover:bg-emerald-100 text-emerald-900">모의 가격으로 돌아가기</button>
  `;
}

// 실제 운임 모드에서 뜻이 없는 선택지·제목을 맞춘다 (실제 검색가에는 '2년 평균'이 없다)
function syncRealFareControls() {
  const realTp = isRealFareActive('travelpayouts');
  const sortSelect = document.getElementById('anywhereSortSelect');
  const discountOption = sortSelect ? sortSelect.querySelector('option[value="HIGHEST_DISCOUNT"]') : null;
  if (discountOption) {
    discountOption.disabled = realTp;
    discountOption.textContent = realTp
      ? '📉 2년 평균가 대비 할인율순 (실제 운임 모드에선 쓸 수 없음)'
      : '📉 2년 평균가 대비 할인율순 (TOP 10·20·30)';
    if (realTp && sortSelect.value === 'HIGHEST_DISCOUNT') sortSelect.value = 'LOWEST_PRICE';
  }
  setTextById('navBenchmarkButton', realTp ? '📉 12개월 시세' : '📉 2년 시세표');
  setTextById(
    'benchmarkSectionTitle',
    realTp ? '선택 노선 향후 12개월 실제 검색가 & 월별·요일별 차트' : '선택 노선 2년(24개월) 모의 시세 기준표 & 월별·요일별 차트'
  );
  setTextById(
    'priceChartSectionTitle',
    realTp ? '편도합산 최저가 변동 추이 차트 (실제 검색가)' : '편도합산 최저가 변동 추이 & 2년 기준선 차트'
  );
  setTextById(
    'monthlyBenchmarkChartTitle',
    realTp ? '월별 평균 항공료 차트 (이번 달부터 12개월 · 가는 편 / 오는 편 구분)' : '월별 평균 항공료 차트 (1월~12월 · 가는 편 / 오는 편 구분)'
  );
}

/**
 * PIN 입력 창
 */
let pinModalReturnFocus = null;

function setRealFarePinError(message) {
  const el = document.getElementById('realFarePinError');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('hidden', !message);
}

// 창이 열려 있는 동안은 포커스가 어디 있든 Esc 로 닫는다
function handleRealFarePinModalKeydown(event) {
  if (event.key === 'Escape') closeRealFarePinModal();
}

function openRealFarePinModal() {
  const modal = document.getElementById('realFarePinModal');
  const input = document.getElementById('realFarePinInput');
  if (!modal || !input) return;
  pinModalReturnFocus = document.activeElement;
  input.value = '';
  setRealFarePinError('');
  modal.classList.remove('hidden');
  document.addEventListener('keydown', handleRealFarePinModalKeydown);
  input.focus();
}

function closeRealFarePinModal() {
  const modal = document.getElementById('realFarePinModal');
  if (modal) modal.classList.add('hidden');
  document.removeEventListener('keydown', handleRealFarePinModalKeydown);
  if (pinModalReturnFocus && typeof pinModalReturnFocus.focus === 'function') pinModalReturnFocus.focus();
  pinModalReturnFocus = null;
}

function pinErrorMessage(err) {
  if (err.code === 'PIN_INVALID') return 'PIN 이 맞지 않습니다. (15분 안에 5번 틀리면 15분 동안 잠깁니다)';
  if (err.code === 'PIN_LOCKED') return `PIN 을 여러 번 틀려 잠겼습니다. ${Math.ceil((err.retryAfterSec || 900) / 60)}분 뒤 다시 시도하세요.`;
  if (err.code === 'PIN_NOT_CONFIGURED') return '프록시에 PIN 이 아직 설정되지 않았습니다.';
  if (err.code === 'NETWORK') return '실제 운임 프록시에 연결하지 못했습니다. 잠시 뒤 다시 시도하세요.';
  return err.message || 'PIN 을 확인하지 못했습니다.';
}

async function handleRealFarePinSubmit(event) {
  event.preventDefault();
  const input = document.getElementById('realFarePinInput');
  const submitBtn = document.getElementById('realFarePinSubmit');
  const pin = String(input?.value || '').trim();
  if (!REAL_FARE_PIN_PATTERN.test(pin)) {
    setRealFarePinError('PIN 은 숫자 4~8자리입니다.');
    return;
  }
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = '확인 중…';
  }
  setRealFarePinError('');
  try {
    const session = await proxyFetch('session', { method: 'POST', pin, timeoutMs: REAL_FARE_SESSION_TIMEOUT_MS });
    closeRealFarePinModal();
    await enterRealFareMode(pin, session.providers);
  } catch (err) {
    setRealFarePinError(pinErrorMessage(err));
    if (input) input.select();
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = '확인';
    }
  }
}

function applyRealFareSession(pin, providers) {
  realFareState.enabled = true;
  realFareState.pin = pin;
  realFareState.providers = { serpapi: Boolean(providers?.serpapi), travelpayouts: Boolean(providers?.travelpayouts) };
  storeRealFarePin(pin);
  resetRealBenchmark();
  renderRealFareNotice();
  syncRealFareControls();
}

async function enterRealFareMode(pin, providers) {
  applyRealFareSession(pin, providers);
  const { serpapi, travelpayouts } = realFareState.providers;
  showToast(
    serpapi || travelpayouts
      ? '실제 운임 모드를 켰습니다. 최근 검색가·실시간 가격으로 다시 불러옵니다.'
      : '실제 운임 모드를 켰지만 프록시에 API 키가 아직 없어 가격은 모의 값으로 보입니다.',
    '🔑'
  );
  await reloadFareFeatures();
}

function exitRealFareMode({ reload = true, message = '모의 가격으로 돌아갔습니다.' } = {}) {
  realFareState.enabled = false;
  realFareState.pin = '';
  realFareState.providers = { serpapi: false, travelpayouts: false };
  storeRealFarePin('');
  resetRealBenchmark();
  renderRealFareNotice();
  syncRealFareControls();
  showToast(message, 'ℹ️');
  return reload ? reloadFareFeatures() : Promise.resolve();
}

// 모드를 바꾼 뒤 가격이 나오는 모든 칸을 다시 불러온다 (하나가 실패해도 나머지는 계속)
async function reloadFareFeatures() {
  renderBenchmark2YPanel();
  const results = await Promise.allSettled([
    loadAnywhereTop10(),
    loadReturnDateMatrix(),
    loadScheduleRecommendations(),
    loadRoutePriceTrend(),
    refreshFlexDealsIfShown()
  ]);
  results
    .filter((r) => r.status === 'rejected')
    .forEach((r) => console.error('가격 다시 불러오기 실패:', r.reason));
  renderStatusAndKpis();
  renderWatchRules();
  // PIN 을 넣으면 오늘 아직 최근 검색가로 훑지 못한 목표가 알림을 훑는다 (화면을 기다리게 하지 않음)
  autoScanTargetAlerts();
}

// 같은 탭에서 새로 고쳐도 실제 운임 모드를 이어 간다 (저장된 PIN 을 조용히 다시 확인)
async function restoreRealFareSession() {
  const pin = readStoredRealFarePin();
  if (REAL_FARE_PIN_PATTERN.test(pin)) {
    try {
      const session = await proxyFetch('session', { method: 'POST', pin, timeoutMs: REAL_FARE_SESSION_TIMEOUT_MS });
      applyRealFareSession(pin, session.providers);
      return;
    } catch (err) {
      if (err.code === 'PIN_INVALID') storeRealFarePin('');
      showToast(`실제 운임 모드를 이어 가지 못했습니다 (${describeRealFareFailure(err)}). 모의 가격으로 시작합니다.`, '⚠️');
    }
  }
  renderRealFareNotice();
  syncRealFareControls();
}

// 날짜 지정 알림(이전 방식) 재조회용 실제 운임 후보 (서버·Pages 엔진의 externalCandidates 모양)
// 구글 플라이트(SerpApi) 실시간 편도 두 번 — 가는 편·오는 편
// 한쪽이라도 결과가 없으면(예: 그날 직항 없음) 쓸 수 없으므로 이유가 담긴 오류로 돌려준다
async function fetchLiveExternalCandidates({ origin, destination, departureDate, returnDate, directOnly }) {
  const flights = await proxyFetch('flights', {
    params: { origin, destination, departureDate, returnDate, directOnly: String(directOnly !== false) }
  });
  const outbound = flights.outbound?.candidates || [];
  const inbound = flights.inbound?.candidates || [];
  if (!outbound.length || !inbound.length) {
    throw new RealFareError('NO_RESULTS', '구글 플라이트에 이 날짜·조건의 검색 결과가 없음');
  }
  return { sourceApi: LIVE_FARE_SOURCE, fetchedAt: flights.fetchedAt || null, outbound, inbound };
}

// SerpApi 남은 검색 횟수 (계정 조회는 검색 횟수에 들어가지 않는다). 모르면 null
async function fetchSerpapiSearchesLeft() {
  try {
    const status = await proxyFetch('status');
    const left = status?.serpapi?.account?.searchesLeft;
    return Number.isFinite(left) ? left : null;
  } catch (_err) {
    return null;
  }
}
