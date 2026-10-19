/**
 * SkyBell KR 실제 운임 모드 — PIN 을 확인한 뒤 프록시(Vercel)로 실제 운임을 받아 온다 (app.js 다음에 불러온다)
 * - 조회량이 많은 기능(TOP 30 · 12개월 시세 · 귀국일표 · 추천 일정 · 가격 추이): Travelpayouts 최근 검색가
 *   (다른 이용자들이 최근 48시간 안에 검색한 가격, 실시간 아님 · 무료 한도가 넉넉함)
 * - 알림 등록·재조회·일괄 조회: 구글 플라이트 실시간 조회 (SerpApi 무료 월 250회, 한 번에 가는 편·오는 편 2회)
 *   단, 최근 검색가 카드에서 바로 '알림 등록'하면 그 카드의 편도 두 장을 그대로 써서 SerpApi 횟수를 쓰지 않는다
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
  '<span data-cached-fare-chip class="ml-1 align-middle text-[10px] font-bold px-1.5 py-0.5 rounded bg-sky-100 text-sky-800 border border-sky-200" title="다른 이용자들이 최근 48시간 안에 검색한 실제 운임입니다 (실시간 아님)">최근 검색가</span>';

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

// 실제 운임 출처 링크 (Travelpayouts 가 준 Aviasales 검색 결과 주소 — 이 가격을 직접 확인할 수 있는 곳)
function fareSourceLinkHtml(leg, label = '가격 출처 ↗') {
  const url = leg?.sourceUrl;
  if (!url || !SAFE_URL_PATTERN.test(url)) return '';
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer nofollow" class="text-sky-700 hover:underline font-semibold">${escapeHtml(label)}</a>`;
}

// 각 기능 위에 붙는 출처 한 줄 (실제 운임이면 수집 시각, 실제 조회가 실패했으면 그 이유)
function fareSourceLineHtml(data) {
  if (data?.realFare) {
    const when = data.fetchedAt ? ` · ${formatDateTime(data.fetchedAt)} 수집` : '';
    const partial = data.partial ? ' · 일부 조회 실패' : '';
    return `<div data-fare-source-line="CACHED" class="text-[11px] font-semibold text-sky-900 bg-sky-50 border border-sky-200 rounded-lg px-2.5 py-1.5">📡 실제 운임 · Travelpayouts 최근 검색가 (다른 이용자들이 최근 48시간 안에 검색한 가격 · 실시간 아님${escapeHtml(when + partial)})</div>`;
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
        <b>✅ 실제 운임 모드</b> · TOP 30·12개월 시세·귀국일표·추천 일정·가격 추이는 <b>Travelpayouts 최근 검색가</b>(다른 이용자들이 최근 48시간 안에 검색한 가격 · 실시간 아님),
        알림 등록·재조회는 <b>구글 플라이트 실시간 조회</b>(SerpApi 무료 월 250회 · 한 번에 2회)를 씁니다. 좌석·최종 가격은 예약 사이트에서 확인하세요.
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
    loadRoutePriceTrend()
  ]);
  results
    .filter((r) => r.status === 'rejected')
    .forEach((r) => console.error('가격 다시 불러오기 실패:', r.reason));
  renderStatusAndKpis();
  renderWatchRules();
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

/**
 * 알림 규칙에 넘길 실제 운임 후보 (서버·Pages 엔진의 externalCandidates 모양)
 */
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

// 화면에 떠 있는 최근 검색가 카드(TOP 30·귀국일표·추천 일정)의 가는 편·오는 편 짝
function cachedDealPairs() {
  const pairs = [];
  const top = state.anywhereTop10Data;
  if (top?.realFare && top.tiers) {
    ['top10', 'top20', 'top30'].forEach((tierKey) => {
      (top.tiers[tierKey]?.items || []).forEach((d) =>
        pairs.push({ origin: d.origin, destination: d.destination, out: d.outboundLeg, back: d.inboundLeg, fetchedAt: top.fetchedAt })
      );
    });
  }
  const matrix = state.returnMatrixData;
  if (matrix?.realFare && matrix.outboundLeg) {
    // 전국 통합은 귀국일마다 한국 공항(가는 편)이 다를 수 있다 → 칸의 가는 편을 먼저 쓴다
    (matrix.returnOptions || []).forEach((o) =>
      pairs.push({
        origin: o.origin || matrix.origin,
        destination: matrix.destination,
        out: o.outboundLeg || matrix.outboundLeg,
        back: o.inboundLeg,
        fetchedAt: matrix.fetchedAt
      })
    );
  }
  const recs = state.scheduleRecommendData;
  if (recs?.realFare) {
    (recs.recommendations || []).forEach((r) =>
      pairs.push({ origin: r.origin, destination: r.destination, out: r.outboundLeg, back: r.inboundLeg, fetchedAt: recs.fetchedAt })
    );
  }
  return pairs;
}

function findCachedDealCandidates({ origin, destination, departureDate, returnDate }) {
  const hit = cachedDealPairs().find(
    (p) => p.origin === origin && p.destination === destination && p.out?.date === departureDate && p.back?.date === returnDate
  );
  return hit ? { sourceApi: CACHED_FARE_SOURCE, fetchedAt: hit.fetchedAt || null, outbound: [hit.out], inbound: [hit.back] } : null;
}

/**
 * 알림 등록용 실제 운임: 최근 검색가 카드에서 바로 등록하면 그 카드 값 → 아니면 구글 플라이트 실시간 → 둘 다 안 되면 모의 가격
 * 반환: { externalCandidates (없으면 null), fallbackReason (실제 운임 모드인데 못 쓴 이유, 없으면 null) }
 */
async function prepareRuleExternalCandidates(route, { preferCachedDeal = false } = {}) {
  if (!realFareState.enabled) return { externalCandidates: null, fallbackReason: null };
  if (preferCachedDeal) {
    const cached = findCachedDealCandidates(route);
    if (cached) return { externalCandidates: cached, fallbackReason: null };
  }
  if (!realFareState.providers.serpapi) {
    return { externalCandidates: null, fallbackReason: '구글 플라이트(SerpApi) 키가 프록시에 아직 없음' };
  }
  try {
    return { externalCandidates: await fetchLiveExternalCandidates(route), fallbackReason: null };
  } catch (err) {
    return { externalCandidates: null, fallbackReason: describeRealFareFailure(err) };
  }
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
