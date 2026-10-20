/**
 * SkyBell KR 노선·인원 설정 메뉴의 두 기능 (app.js · realFares.js 다음에 불러온다)
 * 1) ±3일 최저가: 입력한 가는 날·오는 날을 각각 앞뒤 3일 옮긴 조합 중 싼 순서로 20개
 * 2) 목표가 알림: 날짜를 정하지 않고 희망 목표가(성인 1인 왕복)만 정하면, 앞으로 정한 기간의 출발일을 하루씩 훑어
 *    목표가 이하 항공권을 찾아 알려 준다 (앱을 열 때 하루 한 번 자동 · 알림 목록의 조회 · 로컬 서버는 3시간마다)
 * 실제 운임 모드(PIN)면 둘 다 프록시의 Travelpayouts 최근 검색가(flex-dates · target-scan)를 쓴다
 * — 구글 플라이트(SerpApi) 검색 횟수는 쓰지 않는다
 */

const FLEX_SEARCH_DAYS = 3;
const FLEX_SEARCH_LIMIT = 20;
const TARGET_WINDOW_OPTIONS = [30, 60, 90, 180];
const TARGET_DEFAULT_MIN_NIGHTS = 2;
const TARGET_DEFAULT_MAX_NIGHTS = 5;
const TARGET_MAX_NIGHTS = 30;
const TARGET_PRICE_MIN_KRW = 10000;
const TARGET_MATCHES_SHOWN = 5; // 알림 카드에 처음 보이는 목표가 이하 일정 수 (나머지는 '모두 보기')
const TARGET_SCAN_LIMIT = 20;
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
// 프록시 target-scan 결과에서 앱 API 로 보내는 편도 칸 (앱이 다시 검증하고 예약 링크는 앱이 다시 만든다 — 링크는 보내지 않음)
const TARGET_SCAN_LEG_FIELDS = [
  'airline',
  'airlineCode',
  'flightNumber',
  'fromAirportCode',
  'toAirportCode',
  'date',
  'scheduleTime',
  'stops',
  'oneWayPriceKrw',
  'searchedOn',
  'sourceUrl'
];

let flexRequestSeq = 0;
let flexLatestQuery = null; // 가장 최근에 찾기 시작한 조건 (조회·PIN 전환 때 이 조건으로 다시 찾는다)
let targetAutoScanRunning = false;
let targetAlertSubmitting = false; // 목표가 알림 등록이 끝나기 전에 또 눌러 같은 알림이 둘 생기지 않게
const targetAlertBusy = {}; // { [alertId]: true } — 같은 알림을 겹쳐 훑지 않게

function kstTodayIso(now = Date.now()) {
  return new Date(now + KST_OFFSET_MS).toISOString().slice(0, 10);
}

function isoDaysBetween(fromIso, toIso) {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / DAY_MS);
}

const monthDayText = (iso) => `${String(iso).slice(5, 7)}/${String(iso).slice(8, 10)}`;

function tripDatesText(deal) {
  return `${monthDayText(deal.departureDate)}(${escapeHtml(deal.departureDayOfWeekKo)}) → ${monthDayText(deal.returnDate)}(${escapeHtml(deal.returnDayOfWeekKo)})`;
}

// onclick 인자로 넣는 알림 id (앱이 만든 'talert_…' 모양만)
function safeAlertId(id) {
  return SAFE_ID_PATTERN.test(String(id || '')) ? String(id) : '';
}

function safeHref(url) {
  return url && SAFE_URL_PATTERN.test(url) ? escapeHtml(url) : '#';
}

// 노선·인원 설정의 출발·도착·인원·직항 (±3일 최저가와 목표가 알림이 함께 쓴다)
function readRouteForm() {
  const { adults, children, infants } = getFormPassengers();
  return {
    origin: document.getElementById('inputOrigin')?.value || 'ALL_KOREA',
    destination: document.getElementById('inputDestination')?.value || 'NRT',
    directOnly: document.getElementById('inputDirectOnly')?.checked ?? true,
    adults,
    children,
    infants
  };
}

// 목록을 다시 그린 뒤 방금 누른 펼치기 버튼에 초점을 돌려준다 (키보드로 펼친 내용에 바로 이어 가게)
function focusRowToggle(key) {
  document.querySelector?.(`[data-row-toggle="${key}"]`)?.focus();
}

async function postJsonToApp(url, body = {}) {
  const res = await apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { res, data: await res.json().catch(() => ({})) };
}

/**
 * 왕복 일정 한 건의 펼친 내용 — 가는 편·오는 편(검색한 날·가격 출처 등 구간별 예약 링크)과 왕복 예약 버튼
 * (±3일 최저가 목록과 목표가 알림 카드가 함께 쓴다)
 */
function roundTripLegHtml(leg, { isOutbound, links, party, fareSource }) {
  if (!leg) return '';
  const airline = escapeHtml(leg.airline);
  const naverUrl = isOutbound ? links.outboundNaverUrl || leg.naverOneWayUrl : links.inboundNaverUrl || leg.naverOneWayUrl;
  const officialUrl = isOutbound
    ? links.outboundAirlineOfficialUrl || leg.officialBookingUrl
    : links.inboundAirlineOfficialUrl || leg.officialBookingUrl;
  const routeGoogleUrl = isOutbound ? links.outboundGoogleFlightsUrl : links.inboundGoogleFlightsUrl;
  const stops = Number(leg.stops) > 0 ? ` · 경유 ${Number(leg.stops)}회` : '';
  return `
    <div>
      <div class="flex items-start justify-between gap-2">
        <span class="text-slate-500 shrink-0">${isOutbound ? '🛫 가는 편' : '🛬 오는 편'} (${escapeHtml(leg.fromAirportCode)}→${escapeHtml(leg.toAirportCode)})</span>
        <span class="font-bold text-slate-800 text-right">${airline} (${escapeHtml(leg.flightNumber)}) · ${formatKrw(leg.oneWayPriceKrw)}</span>
      </div>
      <div class="text-[11px] text-slate-500 text-right">${escapeHtml(leg.scheduleTime)}${stops}</div>
      <div class="flex flex-wrap items-center justify-end gap-x-2 gap-y-0.5 mt-0.5 text-[11px]">
        ${searchedOnHtml(leg)}
        ${legBookingLinksHtml(leg, { fareSource, routeGoogleUrl, party })}
        <a href="${safeHref(naverUrl)}" target="_blank" rel="noopener noreferrer" class="${isOutbound ? 'text-sky-600' : 'text-indigo-600'} hover:underline font-bold">네이버 편도 ↗</a>
        <span class="text-slate-300">·</span>
        <a href="${safeHref(officialUrl)}" target="_blank" rel="noopener noreferrer" class="text-slate-600 hover:underline font-semibold">${airline} 공식 ↗</a>
      </div>
    </div>`;
}

function roundTripButtonHtml(url, label, className) {
  return `<a href="${safeHref(url)}" target="_blank" rel="noopener noreferrer" class="text-center text-[11px] py-1.5 rounded-lg font-bold transition ${className}">${label} <span class="whitespace-nowrap">왕복 ↗</span></a>`;
}

function roundTripDetailHtml(deal, { fareSource, actionsHtml = '' }) {
  const links = deal.bookingLinks || {};
  const party = links.bookingMeta;
  return `
    <div class="bg-slate-50 rounded-xl p-2.5 border border-slate-200/70 space-y-1.5 text-xs">
      ${roundTripLegHtml(deal.outboundLeg, { isOutbound: true, links, party, fareSource })}
      <div class="border-t border-slate-200/60 pt-1">${roundTripLegHtml(deal.inboundLeg, { isOutbound: false, links, party, fareSource })}</div>
    </div>
    <div class="mt-2 space-y-1.5">
      ${bookingNoteHtml(fareSource)}
      ${roundTripLinksNoteHtml(party, { fareSource, legs: [deal.outboundLeg, deal.inboundLeg] })}
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
        ${roundTripButtonHtml(links.naverUrl, '🟢 네이버', 'bg-emerald-600 hover:bg-emerald-500 text-white')}
        ${roundTripButtonHtml(links.skyscannerUrl, '🔵 스카이스캐너', 'bg-sky-600 hover:bg-sky-500 text-white')}
        ${roundTripButtonHtml(links.googleFlightsUrl, '🌐 구글', 'bg-slate-100 hover:bg-slate-200 text-slate-700')}
        ${roundTripButtonHtml(links.tripComUrl, '✈️ 트립닷컴', 'bg-slate-100 hover:bg-slate-200 text-slate-700')}
      </div>
      ${actionsHtml}
    </div>`;
}

/**
 * 접었다 펴는 왕복 일정 한 줄 — 위 줄(버튼)은 날짜·편도 요약·금액, 펼치면 roundTripDetailHtml
 * badgesHtml: 날짜 옆 표시 · noteHtml: 금액 아래 한 줄 · toggleCall: 펼치기 onclick (숫자 인자만)
 * toggleKey: 다시 그린 뒤 초점을 돌려줄 버튼 표시 (focusRowToggle · 숫자로만 만든 값)
 */
function roundTripRowHtml(deal, { rankHtml = '', badgesHtml = '', noteHtml = '', isOpen, toggleCall, toggleKey = '', tone, fareSource, actionsHtml = '' }) {
  return `
    <div class="rounded-xl border ${tone} bg-white">
      <button type="button" onclick="${toggleCall}" data-row-toggle="${toggleKey}" aria-expanded="${isOpen ? 'true' : 'false'}" class="w-full p-2.5 sm:p-3 flex items-start justify-between gap-2 text-left rounded-xl hover:bg-slate-50/80 transition">
        <div class="min-w-0 space-y-1">
          <div class="flex flex-wrap items-center gap-1.5">
            ${rankHtml}
            <span class="text-sm font-extrabold text-slate-900 whitespace-nowrap">${tripDatesText(deal)}</span>
            <span class="text-[11px] text-slate-500 font-semibold whitespace-nowrap">${escapeHtml(deal.stayLabel)}</span>
            ${badgesHtml}
          </div>
          <div class="text-[11px] text-slate-500 truncate">🛫 ${escapeHtml(deal.originCity)}(${escapeHtml(deal.origin)}) · ${escapeHtml(deal.outboundLeg?.airline)} ${formatKrw(deal.outboundLeg?.oneWayPriceKrw)} · 🛬 ${escapeHtml(deal.inboundLeg?.airline)} ${formatKrw(deal.inboundLeg?.oneWayPriceKrw)}</div>
        </div>
        <div class="text-right shrink-0">
          <div class="text-base sm:text-lg font-extrabold text-slate-900 whitespace-nowrap">${formatKrw(deal.combinedAdultPriceKrw)}${fareChipHtml(fareSource)}</div>
          <div class="text-[11px] text-sky-700 font-bold whitespace-nowrap">${escapeHtml(deal.passengerSummaryText)} ${formatKrw(deal.totalPassengersPriceKrw)}</div>
          ${noteHtml ? `<div class="text-[10px] whitespace-nowrap">${noteHtml}</div>` : ''}
          <div class="text-[10px] text-slate-400 font-semibold">${isOpen ? '접기 ▲' : '예약·상세 ▼'}</div>
        </div>
      </button>
      ${isOpen ? `<div class="px-2.5 sm:px-3 pb-3">${roundTripDetailHtml(deal, { fareSource, actionsHtml })}</div>` : ''}
    </div>`;
}

/* ───────────────────────── ±3일 최저가 ───────────────────────── */

function setFlexSearchBusy(busy) {
  const btn = document.getElementById('btnFlexSearch');
  if (!btn) return;
  btn.disabled = busy;
  btn.setAttribute('aria-busy', busy ? 'true' : 'false');
  btn.textContent = busy ? '⏳ 찾는 중…' : '🔍 ±3일 최저가 찾기';
}

async function handleFlexSearch(event) {
  if (event) event.preventDefault();
  const departureDate = document.getElementById('inputDepDate')?.value || '';
  const returnDate = document.getElementById('inputRetDate')?.value || '';
  if (!departureDate || !returnDate || returnDate < departureDate) {
    showToast('가는 날·오는 날을 확인하세요 (오는 날은 가는 날과 같거나 그 뒤).', '⚠️');
    return null;
  }
  return loadFlexDeals({ ...readRouteForm(), departureDate, returnDate });
}

/**
 * ±3일 최저가 불러오기: 실제 운임 모드면 프록시 flex-dates(Travelpayouts), 아니면(또는 실패하면) 앱의 모의 가격 엔진
 * 늦게 온 옛 응답은 버린다 (조건을 바꿔 다시 찾았을 때)
 */
async function loadFlexDeals(query) {
  const params = new URLSearchParams({
    origin: query.origin,
    destination: query.destination,
    departureDate: query.departureDate,
    returnDate: query.returnDate,
    flexDays: String(FLEX_SEARCH_DAYS),
    limit: String(FLEX_SEARCH_LIMIT),
    adults: String(query.adults),
    children: String(query.children),
    infants: String(query.infants),
    directOnly: String(query.directOnly)
  });
  const seq = ++flexRequestSeq;
  flexLatestQuery = query;
  setFlexSearchBusy(true);
  try {
    const data = await loadFareFeature('flex-dates', params, () => apiFetch(`/api/flex-dates?${params.toString()}`));
    if (seq !== flexRequestSeq) return null;
    if (data.error) throw new Error(data.error);
    state.flexDealsData = { ...data, query };
    state.flexOpenIndex = 0;
    renderFlexDeals();
    return state.flexDealsData;
  } catch (err) {
    if (seq !== flexRequestSeq) return null;
    state.flexDealsData = { error: err.message || '±3일 최저가를 찾지 못했습니다.', query };
    renderFlexDeals();
    return state.flexDealsData;
  } finally {
    if (seq === flexRequestSeq) setFlexSearchBusy(false);
  }
}

// 노선·인원 설정의 '🔍 조회'·PIN 모드 전환 때: 목록이 떠 있을(또는 찾는 중일) 때만 가장 최근에 찾은 조건으로 다시 찾는다
// (찾는 중에 누르면 그 새 조건을 버리고 옛 조건을 다시 찾지 않게 — 끝난 결과의 조건이 아니라 마지막으로 요청한 조건)
function refreshFlexDealsIfShown() {
  const query = flexLatestQuery || state.flexDealsData?.query;
  return query ? loadFlexDeals(query) : Promise.resolve(null);
}

function toggleFlexDeal(index) {
  state.flexOpenIndex = state.flexOpenIndex === index ? -1 : index;
  renderFlexDealsList();
  focusRowToggle(`flex:${index}`);
}

function flexShiftText(days, word) {
  if (days === 0) return `${word} 그대로`;
  return `${word} ${days > 0 ? '+' : '−'}${Math.abs(days)}일`;
}

function flexDiffHtml(deal, requestedPrice) {
  if (deal.isRequestedDates || !Number.isFinite(requestedPrice)) return '';
  const diff = deal.combinedAdultPriceKrw - requestedPrice;
  if (diff < 0) return `<span class="text-emerald-700 font-extrabold">입력 일정보다 −${formatKrw(-diff)}</span>`;
  if (diff > 0) return `<span class="text-slate-400 font-semibold">입력 일정보다 +${formatKrw(diff)}</span>`;
  return '<span class="text-slate-400 font-semibold">입력 일정과 같은 값</span>';
}

function flexSummaryHtml(data) {
  const { query } = data;
  const deals = data.deals || [];
  const requestedPrice = data.requestedDates?.combinedAdultPriceKrw;
  const best = deals[0];
  const saving = best && Number.isFinite(requestedPrice) ? requestedPrice - best.combinedAdultPriceKrw : 0;
  const requestedText = Number.isFinite(requestedPrice)
    ? `입력한 일정 그대로 <b>${formatKrw(requestedPrice)}</b>${saving > 0 ? ` → 날짜를 옮기면 최대 <b class="text-emerald-700">−${formatKrw(saving)}</b>` : ' · 입력한 일정이 가장 쌉니다'}`
    : '입력한 일정 그대로는 가격이 없음';
  return `
    <div class="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1 text-xs text-slate-600">
      <span>📅 <b>${escapeHtml(data.originCity)} → ${escapeHtml(data.destinationCity)}</b> · 입력한 일정 <b>${monthDayText(query.departureDate)}~${monthDayText(query.returnDate)}</b> 앞뒤 ${Number(data.flexDays) || FLEX_SEARCH_DAYS}일 · ${Number(data.comboCount) || 0}개 조합 중 싼 순서 ${deals.length}개</span>
      <span>${requestedText}</span>
    </div>`;
}

function flexDealActionsHtml(index) {
  return `
    <div class="grid grid-cols-2 gap-1.5">
      <button type="button" onclick="applyFlexDealToForm(${index})" class="text-xs py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold transition">📅 이 일정으로 폼 바꾸기</button>
      <button type="button" onclick="createTargetAlertFromFlexDeal(${index})" class="text-xs py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold transition">🎯 이 가격 이하 알림</button>
    </div>`;
}

// 화면 읽기 프로그램에 알릴 결과 한 줄 (#flexResultsStatus — 글자로만 넣는다)
function flexStatusText(data) {
  if (data.error) return `±3일 최저가를 찾지 못했습니다: ${data.error}`;
  const deals = data.deals || [];
  if (deals.length === 0) return '±3일 최저가: 입력한 일정 앞뒤로 가격이 있는 일정을 찾지 못했습니다.';
  const best = deals[0];
  return `±3일 최저가 ${deals.length}개를 싼 순서로 찾았습니다. 가장 싼 일정은 ${monthDayText(best.departureDate)}~${monthDayText(best.returnDate)} ${formatKrw(best.combinedAdultPriceKrw)}입니다.`;
}

// 찾은 결과 전체(출처 줄·요약·목록·알림 한 줄) — 오류는 요약 칸에 보이고 목록은 비운다
function renderFlexDeals() {
  const box = document.getElementById('flexResultsBox');
  const summary = document.getElementById('flexResultsSummary');
  if (!box || !summary) return;
  const data = state.flexDealsData;
  box.classList.toggle('hidden', !data);
  if (!data) return;
  setFareSourceLine('flexFareSourceLine', data);
  summary.innerHTML = data.error
    ? `<div data-flex-error class="text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2.5">⚠️ ${escapeHtml(data.error)}</div>`
    : flexSummaryHtml(data);
  renderFlexDealsList();
  const status = document.getElementById('flexResultsStatus');
  if (status) status.textContent = flexStatusText(data);
}

// 목록만 다시 그린다 (줄을 펴고 접을 때 — 요약 칸은 그대로 두어 다시 읽히지 않게)
function renderFlexDealsList() {
  const list = document.getElementById('flexResultsList');
  const data = state.flexDealsData;
  if (!list || !data) return;
  if (data.error) {
    list.innerHTML = '';
    return;
  }
  const deals = data.deals || [];
  if (deals.length === 0) {
    list.innerHTML = `<div class="text-center py-6 px-4 text-slate-500 text-sm border border-dashed border-slate-200 rounded-2xl">입력한 일정 앞뒤 ${FLEX_SEARCH_DAYS}일 안에 가는 편·오는 편 ${data.realFare ? '최근 검색가가 모두 있는' : '가격이 모두 있는'} 일정을 찾지 못했습니다. 날짜를 바꾸거나 '직항만'을 해제해 보세요.</div>`;
    return;
  }
  const requestedPrice = data.requestedDates?.combinedAdultPriceKrw;
  list.innerHTML = deals
    .map((deal, index) => {
      const shiftBadge = deal.isRequestedDates
        ? '<span class="text-[10px] font-extrabold px-1.5 py-0.5 rounded-md bg-sky-100 text-sky-800 border border-sky-200 whitespace-nowrap">📌 입력한 일정</span>'
        : `<span class="text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-600 whitespace-nowrap">${flexShiftText(deal.depShiftDays, '가는 날')} · ${flexShiftText(deal.retShiftDays, '오는 날')}</span>`;
      const rankHtml =
        index === 0
          ? '<span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-emerald-600 text-white whitespace-nowrap">🥇 최저</span>'
          : `<span class="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-slate-200 text-slate-700">#${index + 1}</span>`;
      return roundTripRowHtml(deal, {
        rankHtml,
        badgesHtml: shiftBadge,
        noteHtml: flexDiffHtml(deal, requestedPrice),
        isOpen: state.flexOpenIndex === index,
        toggleCall: `toggleFlexDeal(${index})`,
        toggleKey: `flex:${index}`,
        tone: index === 0 ? 'border-emerald-400' : deal.isRequestedDates ? 'border-sky-300' : 'border-slate-200',
        fareSource: data.fareSource,
        actionsHtml: flexDealActionsHtml(index)
      });
    })
    .join('');
}

function flexDealAt(index) {
  return state.flexDealsData?.deals?.[index] || null;
}

function applyFlexDealToForm(index) {
  const deal = flexDealAt(index);
  if (!deal) return;
  document.getElementById('inputDepDate').value = deal.departureDate;
  document.getElementById('inputRetDate').value = deal.returnDate;
  document.getElementById('inputTargetPrice').value = deal.combinedAdultPriceKrw;
  updatePassengerTotalPreview();
  loadReturnDateMatrix();
  syncPriceChartToForm();
  showToast(`${deal.departureDate} ~ ${deal.returnDate} 일정과 그 가격을 폼에 넣었습니다.`, '✨');
}

// 목록을 찾은 조건(직항·인원)으로 등록한다 — 그 뒤 폼을 바꿨어도 이 가격이 나온 조건 그대로
function createTargetAlertFromFlexDeal(index) {
  const deal = flexDealAt(index);
  if (!deal) return null;
  const { directOnly, adults, children, infants } = state.flexDealsData.query;
  return createTargetAlertFromDeal(deal.origin, deal.destination, deal.departureDate, deal.returnDate, deal.combinedAdultPriceKrw, {
    directOnly,
    adults,
    children,
    infants
  });
}

/* ───────────────────────── 목표가 알림 ───────────────────────── */

// 최소 박수를 최대 박수보다 크게 고르면 최대 박수를 따라 올린다 (반대도)
function handleTargetNightsChange(changed) {
  const minEl = document.getElementById('inputTargetMinNights');
  const maxEl = document.getElementById('inputTargetMaxNights');
  if (!minEl || !maxEl) return;
  if (Number(minEl.value) > Number(maxEl.value)) {
    if (changed === 'min') maxEl.value = minEl.value;
    else minEl.value = maxEl.value;
  }
}

function readTargetAlertForm() {
  const targetPrice = Math.round(Number(document.getElementById('inputTargetPrice')?.value || 0));
  if (!Number.isFinite(targetPrice) || targetPrice < TARGET_PRICE_MIN_KRW) {
    showToast(`희망 목표가(성인 1인 왕복)를 ${formatKrw(TARGET_PRICE_MIN_KRW)} 이상으로 넣어 주세요.`, '⚠️');
    return null;
  }
  const windowDays = Number(document.getElementById('inputTargetWindow')?.value) || 90;
  const minNights = Number(document.getElementById('inputTargetMinNights')?.value) || TARGET_DEFAULT_MIN_NIGHTS;
  const maxNights = Math.max(minNights, Number(document.getElementById('inputTargetMaxNights')?.value) || TARGET_DEFAULT_MAX_NIGHTS);
  return { ...readRouteForm(), targetPrice, windowDays, minNights, maxNights };
}

async function handleCreateTargetAlert(event) {
  if (event) event.preventDefault();
  const body = readTargetAlertForm();
  if (!body) return null;
  try {
    return await submitTargetAlert(body, { reveal: true });
  } catch (err) {
    showToast(err.message, '⚠️');
    return null;
  }
}

/**
 * 카드(TOP 30·귀국일표·추천 일정·±3일 목록)의 '🎯 목표가 알림': 그 노선, 그 카드 가격을 목표가로
 * 카드 일정이 들어가는 가장 짧은 기간(1·2·3·6개월)과 그 박수가 들어가는 박수 범위로 등록한다
 * conditions: 그 가격이 나온 직항·인원 (없으면 폼 그대로 — 폼을 바꾸면 다시 불러오는 카드들)
 */
async function createTargetAlertFromDeal(origin, destination, departureDate, returnDate, priceKrw, conditions = null) {
  const stayNights = Math.max(1, isoDaysBetween(departureDate, returnDate) || 1);
  const daysAhead = isoDaysBetween(kstTodayIso(), departureDate);
  const windowDays = TARGET_WINDOW_OPTIONS.find((days) => days >= daysAhead) || TARGET_WINDOW_OPTIONS[TARGET_WINDOW_OPTIONS.length - 1];
  const body = {
    ...readRouteForm(),
    ...(conditions || {}),
    origin,
    destination,
    targetPrice: Math.round(Number(priceKrw)),
    windowDays,
    minNights: Math.min(TARGET_DEFAULT_MIN_NIGHTS, stayNights),
    maxNights: Math.min(TARGET_MAX_NIGHTS, Math.max(TARGET_DEFAULT_MAX_NIGHTS, stayNights))
  };
  try {
    return await submitTargetAlert(body, { reveal: false, note: dealOutsideScanNote(daysAhead, stayNights, windowDays) });
  } catch (err) {
    showToast(err.message, '⚠️');
    return null;
  }
}

// 누른 카드 일정이 목표가 알림이 훑는 범위(내일 출발부터 최대 6개월 · 최대 30박) 밖이면 알려 줄 한 줄 (안이면 '')
function dealOutsideScanNote(daysAhead, stayNights, windowDays) {
  if (daysAhead < 1) return '오늘 출발 일정은 훑지 않습니다 (알림은 내일 출발부터)';
  if (daysAhead > windowDays) return `이 일정은 ${daysAhead}일 뒤 출발이라 훑는 기간(내일부터 ${windowDays}일) 밖 — 그 안의 출발일만 찾습니다`;
  if (stayNights > TARGET_MAX_NIGHTS) return `이 일정은 ${stayNights}박이라 최대 ${TARGET_MAX_NIGHTS}박까지만 찾습니다`;
  return '';
}

function targetScanQuery(alert) {
  return {
    origin: alert.origin,
    destination: alert.destination,
    targetPrice: String(alert.targetPrice),
    days: String(alert.windowDays),
    minNights: String(alert.minNights),
    maxNights: String(alert.maxNights),
    adults: String(alert.adults),
    children: String(alert.children),
    infants: String(alert.infants),
    directOnly: String(alert.directOnly !== false),
    limit: String(TARGET_SCAN_LIMIT)
  };
}

function compactScanItem(item) {
  if (!item) return null;
  const leg = (raw) => (raw ? Object.fromEntries(TARGET_SCAN_LEG_FIELDS.map((key) => [key, raw[key]])) : null);
  return {
    departureDate: item.departureDate,
    returnDate: item.returnDate,
    outboundLeg: leg(item.outboundLeg),
    inboundLeg: leg(item.inboundLeg)
  };
}

function compactTargetScan(data) {
  return {
    sourceApi: data.fareSource || CACHED_FARE_SOURCE,
    fetchedAt: data.fetchedAt || null,
    partial: data.partial === true,
    scannedDays: data.scannedDays,
    daysWithFares: data.daysWithFares,
    matchCount: data.matchCount,
    matches: (data.matches || []).map(compactScanItem),
    cheapest: compactScanItem(data.cheapest)
  };
}

/**
 * 실제 운임 모드의 목표가 스캔: 프록시 target-scan (Travelpayouts 최근 검색가 · SerpApi 안 씀)
 * 반환 { scanResult (모의 가격이면 null), fallbackReason (실제 운임 모드인데 못 쓴 이유) }
 */
async function fetchTargetScanResult(alert) {
  if (!realFareState.enabled) return { scanResult: null, fallbackReason: null };
  if (!isRealFareActive('travelpayouts')) return { scanResult: null, fallbackReason: 'Travelpayouts 토큰이 프록시에 아직 없음' };
  try {
    const data = await proxyFetch('target-scan', { params: targetScanQuery(alert) });
    return { scanResult: compactTargetScan(data), fallbackReason: null };
  } catch (err) {
    return { scanResult: null, fallbackReason: describeRealFareFailure(err) };
  }
}

function targetAlertStatusText(alert) {
  if (alert.isTargetReached) return `목표가 이하 ${alert.matchCount}일 (최저 ${formatKrw(alert.bestPriceKrw)})`;
  if (alert.cheapest) return `아직 목표가 이하 없음 · 기간 최저 ${formatKrw(alert.cheapest.combinedAdultPriceKrw)}`;
  return '아직 가격을 찾은 날이 없음';
}

// 요약 지표 '현재 최저가' 후보 (app.js renderStatusAndKpis) — 목표가 알림은 기간 중 가장 싼 일정
function targetAlertLowestKpi(alert) {
  const { cheapest } = alert;
  const out = cheapest.outboundLeg?.airline || '';
  const back = cheapest.inboundLeg?.airline || '';
  const airlines = out === back ? out : `${out}+${back}`;
  return {
    price: cheapest.combinedAdultPriceKrw,
    route: `${alert.originCity} ↔ ${alert.destCity} (${airlines} · ${monthDayText(cheapest.departureDate)} 출발)`
  };
}

function setTargetAlertSubmitBusy(busy) {
  const btn = document.getElementById('btnCreateTargetAlert');
  if (!btn) return;
  btn.disabled = busy;
  btn.setAttribute('aria-busy', busy ? 'true' : 'false');
  btn.textContent = busy ? '⏳ 등록 중…' : '🔔 목표가 알림 등록';
}

/**
 * 목표가 알림 등록 (폼·카드 공통): 실제 운임 모드면 먼저 프록시로 훑은 결과를 함께 보낸다
 * 앱이 그 결과를 쓸 수 없다고 하면(422) 모의 가격으로 다시 등록하고 이유를 알린다
 * 등록이 끝나기 전에 또 누르면(폼 두 번·Enter·카드) 보내지 않는다 — 같은 알림이 둘 생겨 카톡이 두 번 가지 않게
 * note: 등록 안내 뒤에 붙일 한 줄 (카드 일정이 훑는 범위 밖일 때)
 */
async function submitTargetAlert(body, { reveal = false, note = '' } = {}) {
  if (targetAlertSubmitting) {
    showToast('목표가 알림을 등록하는 중입니다 — 끝난 뒤에 다시 눌러 주세요.', '⏳');
    return null;
  }
  targetAlertSubmitting = true;
  setTargetAlertSubmitBusy(true);
  try {
    if (realFareState.enabled) {
      showToast('Travelpayouts 최근 검색가로 기간 안의 출발일을 하루씩 훑는 중입니다 (구글 플라이트 검색 횟수는 쓰지 않음)...', '📡');
    }
    const real = await fetchTargetScanResult(body);
    let fallbackReason = real.fallbackReason;
    let { res, data } = await postJsonToApp('/api/target-alerts', { ...body, scanResult: real.scanResult });
    if (res.status === 422 && real.scanResult) {
      fallbackReason = data.error || '실제 운임 결과를 쓸 수 없음';
      ({ res, data } = await postJsonToApp('/api/target-alerts', body));
    }
    if (!res.ok) throw new Error(data.error || '목표가 알림 등록 실패');

    const { alert } = data;
    if (data.notificationResult) state.selectedPreviewNoti = data.notificationResult;
    const route = `${alert.originCity} → ${alert.destCity}`;
    const status = `${targetAlertStatusText(alert)}${data.notificationResult ? ' · 카톡 알림' : ''}`;
    const extra = note ? ` · ${note}` : '';
    if (fallbackReason) {
      showToast(`실제 운임 조회 실패(${fallbackReason}) → 모의 가격으로 목표가 알림을 등록했습니다 · ${status}${extra}`, '⚠️');
    } else if (data.notificationError) {
      showToast(`목표가 알림을 등록했지만 ${data.notificationError}${extra}`, '⚠️');
    } else {
      showToast(`🎯 목표가 알림 등록: ${route} ${formatKrw(alert.targetPrice)} 이하 · ${status}${extra}`, note ? '⚠️' : '🔔');
    }
    await loadDashboard();
    if (reveal) jumpToSection('sectionWatchlist');
    return data;
  } finally {
    targetAlertSubmitting = false;
    setTargetAlertSubmitBusy(false);
  }
}

function promptPinForTargetAlert() {
  showToast('실제 운임(최근 검색가)으로 받은 목표가 알림이라 PIN 을 넣어야 다시 훑습니다 (모의 가격으로 덮어쓰지 않음).', '🔑');
  openRealFarePinModal();
}

/**
 * 목표가 알림 한 건을 다시 훑는다 (실제 운임 모드면 프록시 결과를 보내고, 아니면 앱의 모의 가격 엔진)
 * - 실제 운임 알림인데 PIN 이 없으면 보내지 않는다 ({ needsPin }) — 모의 가격으로 덮어쓰지 않게
 * - 실제 운임 알림의 프록시 조회가 실패하면 지난 결과를 그대로 두고 오류를 던진다
 */
async function scanTargetAlert(alertId, { manual = true } = {}) {
  const alert = (state.targetAlerts || []).find((a) => a.id === alertId);
  if (!alert || targetAlertBusy[alertId]) return null;
  if (alert.isRealFare && !realFareState.enabled) {
    if (manual) promptPinForTargetAlert();
    return { needsPin: true };
  }
  targetAlertBusy[alertId] = true;
  if (manual) renderWatchRules();
  try {
    const real = await fetchTargetScanResult(alert);
    if (alert.isRealFare && !real.scanResult) {
      throw new Error(`실제 운임 조회 실패(${real.fallbackReason}) — 지난 결과를 그대로 둡니다.`);
    }
    const { res, data } = await postJsonToApp(
      `/api/target-alerts/${encodeURIComponent(alertId)}/scan`,
      real.scanResult ? { scanResult: real.scanResult } : {}
    );
    if (!res.ok) {
      if (data.code === 'REAL_FARE_NEEDS_PIN') {
        if (manual) promptPinForTargetAlert();
        return { needsPin: true };
      }
      // 422: 앱이 받은 최근 검색가를 쓸 수 없다고 함 — 저장하지 않았으므로 지난 결과가 그대로 남는다
      throw new Error(res.status === 422 ? `실제 운임 결과를 쓸 수 없음(${data.error}) — 지난 결과를 그대로 둡니다.` : data.error || '목표가 알림 조회 실패');
    }
    if (data.notificationResult) state.selectedPreviewNoti = data.notificationResult;
    return { ...data, fallbackReason: real.fallbackReason };
  } finally {
    delete targetAlertBusy[alertId];
  }
}

async function handleScanTargetAlert(alertId) {
  if (targetAlertBusy[alertId]) {
    showToast('이 목표가 알림은 지금 훑는 중입니다 — 끝나면 결과가 바로 보입니다.', '⏳');
    return null;
  }
  try {
    showToast(realFareState.enabled ? '🔍 최근 검색가로 목표가 알림을 다시 훑는 중입니다...' : '🔍 목표가 알림을 다시 훑는 중입니다...', '🎯');
    const result = await scanTargetAlert(alertId, { manual: true });
    if (!result || result.needsPin) {
      renderWatchRules(); // '훑는 중…' 버튼을 되돌린다 (PIN 이 필요해 멈췄을 때도)
      return result;
    }
    const fallback = result.fallbackReason ? `실제 운임 조회 실패(${result.fallbackReason}) → 모의 가격 · ` : '';
    const notify = result.notificationResult ? ' · 카톡 알림' : result.notificationError ? ` · ${result.notificationError}` : '';
    showToast(`${fallback}${targetAlertStatusText(result.alert)}${notify}`, result.fallbackReason || result.notificationError ? '⚠️' : '✅');
    await loadDashboard();
    return result;
  } catch (err) {
    showToast(err.message, '⚠️');
    renderWatchRules();
    return null;
  }
}

async function handleNotifyTargetAlert(alertId) {
  try {
    const { res, data } = await postJsonToApp(`/api/target-alerts/${encodeURIComponent(alertId)}/notify`);
    if (!res.ok) throw new Error(data.error || '카톡 발송 실패');
    state.selectedPreviewNoti = data.notificationResult;
    showToast(
      data.notificationResult.status === 'KAKAO_SENT'
        ? '실제 카카오톡(나에게 보내기)으로 목표가 알림을 보냈습니다!'
        : '카카오톡 미리보기 카드에 목표가 알림 메시지를 만들었습니다!',
      '💬'
    );
    await loadDashboard();
  } catch (err) {
    showToast(err.message, '⚠️');
  }
}

async function handleDeleteTargetAlert(alertId, clickEvent) {
  if (isRepeatClick(clickEvent)) return;
  try {
    const res = await apiFetch(`/api/target-alerts/${encodeURIComponent(alertId)}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    const alreadyGone = res.status === 404;
    if (!res.ok && !alreadyGone) throw new Error(data.error || '목표가 알림 삭제 실패');
    showToast(alreadyGone ? '이미 삭제된 목표가 알림입니다. 목록을 새로 고쳤습니다.' : '목표가 알림이 삭제되었습니다.', alreadyGone ? 'ℹ️' : '🗑️');
    await loadDashboard();
  } catch (err) {
    showToast(err.message, '⚠️');
  }
}

/**
 * 목표가 알림을 차례로 훑는다 (자동 조회·일괄 조회 공통 · 하나가 실패해도 나머지는 계속)
 * 반환 { checked, reached, notified, needsPin, fallbacks: [실제 운임을 못 써 모의 가격으로 훑은 이유], failures: [Error] }
 */
async function scanTargetAlertsInOrder(alerts) {
  const summary = { checked: 0, reached: 0, notified: 0, needsPin: 0, fallbacks: [], failures: [] };
  for (const alert of alerts) {
    try {
      const result = await scanTargetAlert(alert.id, { manual: false });
      if (!result) continue;
      if (result.needsPin) {
        summary.needsPin += 1;
        continue;
      }
      summary.checked += 1;
      if (result.alert?.isTargetReached) summary.reached += 1;
      if (result.notificationResult) summary.notified += 1;
      if (result.fallbackReason) summary.fallbacks.push(result.fallbackReason);
    } catch (err) {
      summary.failures.push(err);
    }
  }
  return summary;
}

const hasTargetScanProblem = (summary) => summary.failures.length > 0 || summary.fallbacks.length > 0;

function targetScanSummaryText(summary, label) {
  const parts = [`${label} ${summary.checked}건 · 목표가 이하 ${summary.reached}건`];
  if (summary.notified) parts.push(`카톡 ${summary.notified}건`);
  if (summary.fallbacks.length) parts.push(`${summary.fallbacks.length}건은 실제 운임 조회 실패(${summary.fallbacks[0]})로 모의 가격`);
  if (summary.needsPin) parts.push(`PIN 이 필요한 ${summary.needsPin}건은 건너뜀`);
  if (summary.failures.length) parts.push(`${summary.failures.length}건 실패 (${summary.failures[0].message})`);
  return parts.join(' · ');
}

/**
 * 자동으로 다시 훑을 목표가 알림: 오늘 아직 훑지 않은 것 + 최근 검색가를 쓸 수 있으면 모의 가격으로만 훑은 것
 * 최근 검색가로 받은 알림은 PIN 이 없으면 훑지 않는다 (모의 가격으로 덮어쓰지 않게)
 */
function isTargetAlertDue(alert, canUseCachedFares) {
  if (alert.isActive === false) return false;
  if (alert.isRealFare) return canUseCachedFares && !alert.checkedToday;
  return !alert.checkedToday || canUseCachedFares;
}

// 앱을 열 때(그리고 PIN 을 넣었을 때) 다시 훑을 목표가 알림을 한 번씩 훑는다 — '하루 한 번' 확인
async function autoScanTargetAlerts() {
  if (targetAutoScanRunning) return null;
  const canUseCachedFares = isRealFareActive('travelpayouts');
  const due = (state.targetAlerts || []).filter((alert) => isTargetAlertDue(alert, canUseCachedFares));
  if (due.length === 0) return null;
  targetAutoScanRunning = true;
  try {
    const summary = await scanTargetAlertsInOrder(due);
    await loadDashboard();
    showToast(`🎯 오늘의 목표가 확인: ${targetScanSummaryText(summary, '알림')}`, hasTargetScanProblem(summary) ? '⚠️' : '🎯');
    return summary;
  } catch (err) {
    console.error('목표가 알림 자동 조회 실패:', err);
    return null;
  } finally {
    targetAutoScanRunning = false;
  }
}

/**
 * 실제 운임 모드의 알림 일괄 조회에서 목표가 알림 부분 (Travelpayouts 최근 검색가 · SerpApi 안 씀)
 * 활성 목표가 알림이 없으면 null
 */
async function scanActiveTargetAlertsForBatch() {
  const active = (state.targetAlerts || []).filter((a) => a.isActive !== false);
  if (active.length === 0) return null;
  showToast(`목표가 알림 ${active.length}건을 최근 검색가로 다시 훑는 중…`, '🔄');
  const summary = await scanTargetAlertsInOrder(active);
  return {
    message: targetScanSummaryText(summary, '목표가 알림'),
    icon: hasTargetScanProblem(summary) ? '⚠️' : '✅',
    summary
  };
}

/* ── 알림 목록 카드 ── */

// 펼친 일정은 '알림id:순번' 으로 기억한다 (알림을 지워 순서가 바뀌어도 다른 알림의 일정이 펼쳐지지 않게)
const targetMatchKey = (alert, matchIndex) => `${alert.id}:${matchIndex}`;

function toggleTargetMatch(alertIndex, matchIndex) {
  const alert = state.targetAlerts[alertIndex];
  if (!alert) return;
  const key = targetMatchKey(alert, matchIndex);
  state.openTargetMatchKey = state.openTargetMatchKey === key ? null : key;
  renderWatchRules();
  focusRowToggle(`target:${alertIndex}:${matchIndex}`);
}

function toggleTargetAlertAllMatches(alertIndex) {
  const alert = state.targetAlerts[alertIndex];
  if (!alert) return;
  state.expandedTargetAlertIds = { ...state.expandedTargetAlertIds, [alert.id]: !state.expandedTargetAlertIds[alert.id] };
  renderWatchRules();
  focusRowToggle(`target-all:${alertIndex}`);
}

function targetAlertStatusBadgeHtml(alert) {
  if (alert.isTargetReached) {
    return `<span class="inline-flex items-center gap-1 text-xs font-bold px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-300 whitespace-nowrap">✅ 목표가 이하 ${alert.matchCount}일</span>`;
  }
  if (alert.cheapest) {
    return `<span class="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">⏳ 아직 없음 · 기간 최저 ${formatKrw(alert.cheapest.combinedAdultPriceKrw)} (목표까지 +${formatKrw(alert.gapToTargetKrw)})</span>`;
  }
  const text = alert.lastScan ? '가격을 찾은 날 없음' : '아직 훑지 않음';
  return `<span class="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">${text}</span>`;
}

function targetAlertMatchesHtml(alert, alertIndex) {
  const matches = alert.matches || [];
  const rows = matches.length ? matches : alert.cheapest ? [alert.cheapest] : [];
  if (rows.length === 0) return '';
  const showAll = Boolean(state.expandedTargetAlertIds?.[alert.id]);
  const shown = showAll ? rows : rows.slice(0, TARGET_MATCHES_SHOWN);
  const heading = matches.length
    ? `목표가 이하 일정 (싼 순서 · 하루 한 건${alert.matchCount > matches.length ? ` · 상위 ${matches.length}일` : ''})`
    : '기간 중 가장 싼 일정 (아직 목표가보다 비쌈)';
  const moreButton =
    rows.length > TARGET_MATCHES_SHOWN
      ? `<button type="button" onclick="toggleTargetAlertAllMatches(${alertIndex})" data-row-toggle="target-all:${alertIndex}" aria-expanded="${showAll ? 'true' : 'false'}" class="w-full text-[11px] py-1.5 rounded-lg bg-white border border-slate-200 hover:bg-slate-50 text-slate-600 font-bold">${showAll ? '접기 ▲' : `모두 보기 (${rows.length}일) ▼`}</button>`
      : '';
  return `
    <div class="mt-3 space-y-1.5">
      <div class="text-[11px] font-extrabold text-slate-500">${heading}</div>
      ${shown
        .map((deal, matchIndex) =>
          roundTripRowHtml(deal, {
            rankHtml: matches.length && matchIndex === 0 ? '<span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-emerald-600 text-white whitespace-nowrap">🥇 최저</span>' : '',
            noteHtml: matches.length
              ? `<span class="text-emerald-700 font-bold">목표가보다 −${formatKrw(alert.targetPrice - deal.combinedAdultPriceKrw)}</span>`
              : `<span class="text-amber-700 font-bold">목표가보다 +${formatKrw(deal.combinedAdultPriceKrw - alert.targetPrice)}</span>`,
            isOpen: state.openTargetMatchKey === targetMatchKey(alert, matchIndex),
            toggleCall: `toggleTargetMatch(${alertIndex}, ${matchIndex})`,
            toggleKey: `target:${alertIndex}:${matchIndex}`,
            tone: matches.length && matchIndex === 0 ? 'border-emerald-300' : 'border-slate-200',
            fareSource: alert.sourceApi
          })
        )
        .join('')}
      ${moreButton}
    </div>`;
}

function targetAlertCardHtml(alert, alertIndex) {
  const id = safeAlertId(alert.id);
  const busy = Boolean(targetAlertBusy[alert.id]);
  const needsPin = alert.isRealFare && !realFareState.enabled;
  const scan = alert.lastScan;
  const fareKind = describeFareSource(alert.sourceApi);
  const sourceText =
    fareKind === 'CACHED'
      ? `📡 최근 검색가 (Travelpayouts${alert.fareFetchedAt ? ` · ${escapeHtml(formatDateTime(alert.fareFetchedAt))} 수집` : ''})`
      : '🧮 모의 가격';
  const windowRange = scan ? ` (${monthDayText(scan.fromDate)}~${monthDayText(scan.toDate)} 출발)` : '';
  const checked = alert.lastCheckedAt ? `🕒 ${escapeHtml(formatDateTime(alert.lastCheckedAt))} 조회` : '🕒 아직 조회 전';
  return `
    <div data-target-alert="${escapeHtml(alert.id)}" class="rounded-2xl p-3.5 sm:p-4 border ${alert.isTargetReached ? 'border-emerald-300 bg-emerald-50/30' : 'border-amber-200 bg-amber-50/20'}">
      <div class="flex flex-col sm:flex-row sm:items-start justify-between gap-2">
        <div class="space-y-1.5 min-w-0">
          <div class="flex flex-wrap items-center gap-1.5">
            <span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 border border-amber-200 whitespace-nowrap">🎯 목표가 알림</span>
            <span class="text-sm sm:text-base font-extrabold text-slate-900">${escapeHtml(alert.routeSummary)}</span>
            <span class="text-[11px] sm:text-xs px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 font-semibold">${alert.directOnly ? '직항' : '경유포함'} · 👨‍👩‍👧‍👦 ${escapeHtml(alert.passengerSummaryText)}</span>
            ${targetAlertStatusBadgeHtml(alert)}
          </div>
          <div class="text-xs text-slate-500 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>🗓️ 앞으로 <b>${escapeHtml(alert.windowLabel)}</b>${windowRange} · <b>${Number(alert.minNights)}~${Number(alert.maxNights)}박</b></span>
            <span>${sourceText}${scan?.partial ? ' · 일부 조회 실패' : ''}</span>
            <span>${checked}</span>
          </div>
        </div>
        <div class="shrink-0 sm:text-right border-t sm:border-t-0 pt-2 sm:pt-0 border-slate-100">
          <div class="text-[10px] sm:text-[11px] text-slate-400">희망 목표가 · 성인 1인 왕복</div>
          <div class="text-lg sm:text-xl font-extrabold ${alert.isTargetReached ? 'text-emerald-600' : 'text-slate-900'} whitespace-nowrap">${formatKrw(alert.targetPrice)} 이하</div>
          <div class="text-[11px] font-bold text-sky-700 whitespace-nowrap">총액(${escapeHtml(alert.passengerSummaryText)}) ${formatKrw(alert.targetTotalPassengersPriceKrw)} 이하</div>
        </div>
      </div>
      ${targetAlertMatchesHtml(alert, alertIndex)}
      ${needsPin ? '<div class="mt-2 text-[11px] text-amber-800 font-semibold">🔑 실제 운임(최근 검색가)으로 받은 알림이라 PIN 을 넣어야 다시 훑습니다 (모의 가격으로 덮어쓰지 않음)</div>' : ''}
      ${
        id
          ? `<div class="mt-3 pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2">
        <div class="flex flex-wrap items-center gap-1.5">
          <button type="button" onclick="handleScanTargetAlert('${id}')" ${busy ? 'disabled' : ''} class="text-xs px-2.5 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold transition disabled:opacity-60 disabled:cursor-wait">${busy ? '⏳ 훑는 중…' : '🔍 지금 다시 훑기'}</button>
          <button type="button" onclick="handleNotifyTargetAlert('${id}')" class="text-xs px-2.5 py-1.5 rounded-lg kakao-yellow hover:brightness-95 font-bold transition">💬 카톡 발송</button>
        </div>
        <button type="button" onclick="handleDeleteTargetAlert('${id}', event)" class="text-xs px-2 py-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition" title="목표가 알림 삭제" aria-label="목표가 알림 삭제">🗑️</button>
      </div>`
          : ''
      }
    </div>`;
}

// 카톡 미리보기(app.js)의 목표가 이하 일정 — 보낸 메시지의 목록과 같은 최대 3개 (없으면 '')
function targetMatchesPreviewHtml(noti) {
  const matches = Array.isArray(noti.topMatches) ? noti.topMatches : [];
  if (matches.length === 0) return '';
  const rows = matches
    .map(
      (m, i) => `
      <div class="flex justify-between gap-2">
        <span class="text-slate-500">${i + 1}) ${escapeHtml(monthDayText(m.departureDate))}→${escapeHtml(monthDayText(m.returnDate))} · ${Number(m.stayNights) || 0}박</span>
        <span class="font-bold text-slate-800">${formatKrw(m.combinedAdultPriceKrw)}</span>
      </div>`
    )
    .join('');
  return `<div data-target-preview-matches class="space-y-1 border-b border-slate-100 pb-2.5">
      <div class="text-[11px] font-extrabold text-slate-500">목표가 이하 일정 (싼 순서)</div>${rows}
    </div>`;
}

// 알림 목록 맨 위의 목표가 알림들 (없으면 '')
function targetAlertsListHtml() {
  const alerts = state.targetAlerts || [];
  if (alerts.length === 0) return '';
  return `
    <div class="flex flex-wrap items-center justify-between gap-1">
      <div class="text-xs font-extrabold text-amber-800">🎯 목표가 알림 ${alerts.length}건</div>
      <div class="text-[10px] text-slate-400 font-semibold">앱을 열 때 하루 한 번 자동으로 다시 훑습니다</div>
    </div>
    ${alerts.map((alert, index) => targetAlertCardHtml(alert, index)).join('')}`;
}
