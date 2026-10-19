/**
 * SkyBell KR v2.3 - 모바일 최적화 & 메뉴별 접기/펼치기(Accordion) 통합 프론트엔드 로직
 * - 대한민국 전체 공항 통합(ALL_KOREA) 및 70개+ 전 세계 도시 검색/직접 입력(Custom)
 * - 도시 미지정 시 향후 6개월(180일) 이내 최저가 TOP 10 · TOP 20 · TOP 30 3단 구분
 * - 메뉴별(7개 대메뉴 + TOP 10/20/30 그룹별 + 알림 카드 상세별) 접었다 폈다 아코디언 기능
 * - 모바일 하단 고정 네비게이션 바 & 2열 컴팩트 카드 레이아웃 최적화
 */

const ALL_SECTION_IDS = [
  'sectionKpi',
  'sectionSearchForm',
  'sectionBenchmark2Y',
  'sectionExplorer',
  'sectionWatchlist',
  'sectionPriceChart',
  'sectionKakaoPreview'
];

// v2: 모든 대메뉴는 접힌 상태가 기본값 (이전 V1 저장값의 '펼침' 상태는 더 이상 복원하지 않음)
const COLLAPSE_STORAGE_KEY = 'SKYBELL_COLLAPSED_SECTIONS_V2';

function buildAllCollapsedSections() {
  const map = {};
  ALL_SECTION_IDS.forEach((id) => {
    map[id] = true;
  });
  return map;
}

let state = {
  origins: [],
  destinations: [],
  curatedDeals: [],
  watchRules: [],
  historiesByRule: {},
  notificationLogs: [],
  notificationLogsTotal: null, // 대시보드는 최근 30건만 내려주므로 전체 건수는 따로 받음
  apiQuotaStats: {},
  statusSummary: {},
  selectedRuleId: null,
  selectedPreviewNoti: null,
  activeExplorerTab: 'ANYWHERE_TOP10', // 'ANYWHERE_TOP10' | 'RETURN_MATRIX' | 'CHEAP_RECOMMEND'
  activeAnywhereTier: 'ALL_3_TIERS', // 'ALL_3_TIERS' | 'TOP10' | 'TOP20' | 'TOP30'
  anywhereCumulativeMode: false, // true일 때 TOP20은 1~20위, TOP30은 1~30위 누적 표시
  anywhereTop10Data: null,
  returnMatrixData: null,
  scheduleRecommendData: null,
  chartRouteMode: 'FORM', // 'FORM' (노선·인원 설정에서 선택한 노선) | ruleId (등록된 알림 노선)
  routeTrendData: null,
  routeTrendError: null,
  useStandaloneMode: false, // /api 서버가 없는 곳(GitHub Pages)에서 브라우저 내장 엔진을 쓰는지
  apiServerConfirmed: false, // 서버가 JSON 으로 한 번이라도 답했는지 (그 뒤로는 브라우저 엔진으로 바꾸지 않음)
  collapsedSections: buildAllCollapsedSections(), // { sectionId: boolean } - 기본값: 전부 접힘
  collapsedTiers: {}, // { TOP10: boolean, TOP20: boolean, TOP30: boolean }
  collapsedRuleIds: {} // { [ruleId]: boolean }
};

let priceChartInstance = null;
let monthlyBenchmarkChartInstance = null;
let dowBenchmarkChartInstance = null;
let routeTrendRequestSeq = 0;
// 실제 운임(프록시) 조회는 몇 초 걸릴 수 있어, 그사이 조건을 바꾸면 늦게 온 옛 응답은 버린다
let anywhereTop10RequestSeq = 0;
let returnMatrixRequestSeq = 0;
let scheduleRecommendRequestSeq = 0;

function formatKrw(amount) {
  if (amount === null || amount === undefined || Number.isNaN(Number(amount))) return '-';
  return `${Math.round(Number(amount)).toLocaleString('ko-KR')}원`;
}

// 사용자가 입력한 도시 이름·코드 등을 innerHTML 로 넣을 때 태그로 해석되지 않게 한다
function escapeHtml(value) {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value ?? '').replace(/[&<>"']/g, (ch) => entities[ch]);
}

// 가격 출처 (서버 flightApiService 의 describeFareSource 와 같은 목록).
// - 실시간: 조회한 그 순간의 실제 운임 (구글 플라이트 = SerpApi)
// - 검색 캐시: 다른 이용자들이 최근(최대 며칠 전) 검색한 결과에서 모은 실제 운임 (Travelpayouts)
// - 그 밖은 계산식으로 만든 모의 값이라 예약 사이트 가격과 다르다 (PIN 을 넣기 전 화면의 모든 가격)
const LIVE_FARE_SOURCE_APIS = ['AMADEUS_ONEWAY_COMBO', 'SERPAPI_GOOGLE_FLIGHTS'];
const CACHED_FARE_SOURCE_APIS = ['TRAVELPAYOUTS_PRICES'];

function describeFareSource(sourceApi) {
  if (LIVE_FARE_SOURCE_APIS.includes(sourceApi)) return 'LIVE';
  if (CACHED_FARE_SOURCE_APIS.includes(sourceApi)) return 'CACHED';
  return 'SIMULATED';
}

// 실제 운임(구글 플라이트 실시간·최근 검색가)으로 받아 온 알림 — PIN 없이 다시 조회하면 모의 가격이 되므로 PIN 을 묻는다
function isRealFareWatchRule(rule) {
  return describeFareSource(rule?.sourceApi) !== 'SIMULATED';
}

// 가격 옆 '모의' 표시와 예약 링크 위 안내 (예약 사이트에 보이는 가격이 실제 가격이다)
// 최근 검색가·실시간 표시는 realFares.js 의 fareChipHtml · bookingNoteHtml
const SIMULATED_FARE_CHIP_HTML =
  '<span data-simulated-fare-chip class="ml-1 align-middle text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200" title="실제 운임이 아니라 계산식으로 만든 모의 가격입니다">모의</span>';
const BOOKING_LINK_NOTE_HTML =
  '<div data-simulated-fare-note class="text-[10px] text-amber-800 font-semibold">⚠️ 위 가격·편명은 모의 값입니다 · 실제 가격은 예약 사이트에서 확인하세요</div>';

function formatDateTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function showToast(message, icon = '💬') {
  const banner = document.getElementById('toastBanner');
  document.getElementById('toastIcon').textContent = icon;
  document.getElementById('toastMessage').textContent = message;
  banner.classList.remove('hidden');
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => {
    banner.classList.add('hidden');
  }, 4300);
}

/**
 * [신규] 메뉴별 접었다 폈다 (Accordion Collapse/Expand) 상태 관리 및 렌더링
 */
function loadCollapsedStateFromStorage() {
  // 요구사항: 모든 대메뉴는 '접힌 상태'가 기본값 → 페이지 로드 시 항상 7개 메뉴를 접은 상태로 시작
  state.collapsedSections = buildAllCollapsedSections();
  try {
    const raw = localStorage.getItem(COLLAPSE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        state.collapsedTiers = parsed.tiers || {};
      }
    }
  } catch (_e) {
    // ignore storage errors
  }
  applyAllSectionCollapseDom();
}

function saveCollapsedStateToStorage() {
  try {
    localStorage.setItem(
      COLLAPSE_STORAGE_KEY,
      JSON.stringify({
        sections: state.collapsedSections,
        tiers: state.collapsedTiers
      })
    );
  } catch (_e) {
    // ignore storage errors
  }
}

function applySectionCollapseDom(sectionId) {
  const isCollapsed = Boolean(state.collapsedSections[sectionId]);
  const bodyEl = document.getElementById(`body_${sectionId}`);
  const btnEl = document.getElementById(`btnToggle_${sectionId}`);
  if (!bodyEl || !btnEl) return;

  if (isCollapsed) {
    bodyEl.classList.add('hidden');
    btnEl.textContent = '펼치기 ▼';
    if (sectionId === 'sectionBenchmark2Y') {
      btnEl.className = 'text-xs px-2.5 py-1 rounded-lg bg-amber-400 text-slate-950 font-extrabold shrink-0';
    } else {
      btnEl.className = 'text-xs px-2.5 py-1 rounded-lg bg-sky-50 border border-sky-200 text-sky-700 font-extrabold shrink-0';
    }
  } else {
    bodyEl.classList.remove('hidden');
    btnEl.textContent = '접기 ▲';
    if (sectionId === 'sectionBenchmark2Y') {
      btnEl.className = 'text-xs px-2.5 py-1 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 font-bold shrink-0';
    } else {
      btnEl.className = 'text-xs px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-slate-700 font-bold shrink-0';
    }
    // 숨겨진 상태에서 생성된 Chart.js 캔버스는 크기가 0이므로 펼칠 때 다시 그려줌
    if (sectionId === 'sectionPriceChart') {
      setTimeout(() => {
        if (priceChartInstance) priceChartInstance.resize();
        else renderPriceChart();
      }, 60);
    }
    if (sectionId === 'sectionBenchmark2Y') {
      setTimeout(() => {
        // 실제 운임 모드는 접혀 있는 동안 조회하지 않으므로 펼칠 때 그 노선의 실제 검색가를 불러온다
        if (!isRealFareActive('travelpayouts') && monthlyBenchmarkChartInstance && dowBenchmarkChartInstance) {
          monthlyBenchmarkChartInstance.resize();
          dowBenchmarkChartInstance.resize();
        } else {
          renderBenchmark2YPanel();
        }
      }, 60);
    }
  }
}

function applyAllSectionCollapseDom() {
  ALL_SECTION_IDS.forEach((id) => applySectionCollapseDom(id));
}

function toggleSectionCollapse(sectionId, forceOpen = null) {
  const current = Boolean(state.collapsedSections[sectionId]);
  const nextCollapsed = forceOpen !== null ? !forceOpen : !current;
  state.collapsedSections[sectionId] = nextCollapsed;
  applySectionCollapseDom(sectionId);
  saveCollapsedStateToStorage();
}

function expandAllSections() {
  ALL_SECTION_IDS.forEach((id) => {
    state.collapsedSections[id] = false;
  });
  state.collapsedTiers = { TOP10: false, TOP20: false, TOP30: false };
  state.collapsedRuleIds = {};
  applyAllSectionCollapseDom();
  renderAnywhereTop10();
  renderWatchRules();
  saveCollapsedStateToStorage();
  showToast('모든 메뉴와 세부 그룹이 펼쳐졌습니다.', '📂');
}

function collapseAllSections() {
  ALL_SECTION_IDS.forEach((id) => {
    state.collapsedSections[id] = true;
  });
  applyAllSectionCollapseDom();
  saveCollapsedStateToStorage();
  showToast('모든 메뉴가 깔끔하게 접혔습니다. 원하는 메뉴만 눌러 펼쳐보세요!', '📁');
}

function jumpToSection(sectionId) {
  state.collapsedSections[sectionId] = false;
  applySectionCollapseDom(sectionId);
  saveCollapsedStateToStorage();

  const el = document.getElementById(sectionId);
  if (el) {
    const headerOffset = 98;
    const y = el.getBoundingClientRect().top + window.pageYOffset - headerOffset;
    window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
  }
}

function jumpToExplorerTab(tabName) {
  state.collapsedSections['sectionExplorer'] = false;
  applySectionCollapseDom('sectionExplorer');
  saveCollapsedStateToStorage();
  switchExplorerTab(tabName);

  const el = document.getElementById('sectionExplorer');
  if (el) {
    const headerOffset = 98;
    const y = el.getBoundingClientRect().top + window.pageYOffset - headerOffset;
    window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
  }
}

function toggleTierGroupCollapse(tierKey) {
  state.collapsedTiers[tierKey] = !state.collapsedTiers[tierKey];
  saveCollapsedStateToStorage();
  renderAnywhereTop10();
}

function toggleRuleDetailCollapse(ruleId) {
  state.collapsedRuleIds[ruleId] = !state.collapsedRuleIds[ruleId];
  renderWatchRules();
}

function syncDirectOnlyCheckbox(checked) {
  const mainEl = document.getElementById('inputDirectOnly');
  const mobileEl = document.getElementById('inputDirectOnlyMobileProxy');
  if (mainEl) mainEl.checked = Boolean(checked);
  if (mobileEl) mobileEl.checked = Boolean(checked);
  handleRouteOrDateChange();
}

function getFormPassengers() {
  const adults = Math.max(1, Number(document.getElementById('inputAdults')?.value || 1));
  const children = Math.max(0, Number(document.getElementById('inputChildren')?.value || 0));
  let infants = Math.max(0, Number(document.getElementById('inputInfants')?.value || 0));

  if (infants > adults) {
    infants = adults;
    document.getElementById('inputInfants').value = String(infants);
    showToast('항공사 규정상 유아(만 24개월 미만)는 성인 1명당 1명까지만 동반 가능하여 자동 조정되었습니다.', '👶');
  }
  return { adults, children, infants };
}

function computeClientPassengerTotal(adultUnitKrw, { adults = 1, children = 0, infants = 0 }) {
  const adultFare = Math.round(adultUnitKrw);
  const childFare = Math.round((adultUnitKrw * 0.8) / 100) * 100;
  const infantFare = Math.round((adultUnitKrw * 0.1) / 100) * 100;
  return adults * adultFare + children * childFare + infants * infantFare;
}

/**
 * 서버(localhost:3000) 및 GitHub Pages 온라인 환경(Standalone 브라우저 엔진) 모두에서 작동하는 하이브리드 API 호출 래퍼
 */
// /api 경로가 없는 정적 호스팅이 돌려주는 응답 (없는 파일 404, 쓰기 요청 405·501, 모든 경로에 index.html 200)
const NO_API_SERVER_STATUSES = [404, 405, 501];

function looksLikeNoApiServer(res) {
  return res.ok || NO_API_SERVER_STATUSES.includes(res.status);
}

async function apiFetch(url, options = {}) {
  if (!state.useStandaloneMode) {
    try {
      const res = await fetch(url, options);
      const contentType = res.headers.get('content-type') || '';
      // JSON 응답은 상태 코드와 상관없이 서버의 답이다 (예: 이미 지운 알림 이력 → 404 {error})
      if (contentType.includes('application/json')) {
        state.apiServerConfirmed = true;
        return res;
      }
      // 서버가 확인된 뒤의 HTML 오류는 브라우저 저장소로 넘어가지 않고 그대로 돌려준다
      if (state.apiServerConfirmed) {
        return res;
      }
      // 그 밖의 HTML 오류(500 등)는 서버가 있는데 실패한 것 → 샘플 데이터로 몰래 넘어가지 않고 오류로 돌려준다
      if (!looksLikeNoApiServer(res)) {
        return res;
      }
      // GitHub Pages 처럼 /api 서버가 없는 곳 (HTML 404·405, 정적 호스팅의 index.html 200) → 브라우저 내장 엔진 사용
      state.useStandaloneMode = true;
    } catch (err) {
      if (state.apiServerConfirmed) throw err;
      state.useStandaloneMode = true;
    }
  }

  if (window.SkyBellStandaloneApi) {
    return window.SkyBellStandaloneApi.handleRequest(url, options);
  }
  throw new Error('API 서버에 연결할 수 없습니다.');
}

async function initApp() {
  try {
    loadCollapsedStateFromStorage();

    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('kakao_connected') === '1') {
      showToast('카카오톡 메시지 API(A안) 연동 완료! 이제 실제 카톡으로 편도조합 특가 알림이 전송됩니다.', '🎉');
      window.history.replaceState({}, document.title, window.location.pathname);
    } else if (urlParams.get('kakao_error')) {
      showToast(`카카오 연동 오류: ${urlParams.get('kakao_error')}`, '⚠️');
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    const metaRes = await apiFetch('/api/meta');
    const meta = await metaRes.json().catch(() => ({}));
    if (!metaRes.ok) throw new Error(meta.error || `공항 목록을 불러오지 못했습니다 (HTTP ${metaRes.status})`);
    state.origins = meta.origins || [];
    state.destinations = meta.destinations || [];
    state.curatedDeals = meta.curatedDeals || [];

    setDefaultFormDates();
    populateAirportSelects();
    // 이 탭에서 넣었던 PIN 이 있으면 실제 운임 모드를 이어 간다 (가격을 불러오기 전에 확인 · realFares.js)
    await restoreRealFareSession();
    if (realFareState.enabled) renderBenchmark2YPanel();

    await Promise.all([
      loadDashboard(),
      loadAnywhereTop10(),
      loadReturnDateMatrix(),
      loadScheduleRecommendations(),
      loadRoutePriceTrend()
    ]);
  } catch (err) {
    console.error('초기화 실패:', err);
    showToast('데이터를 불러오는 중 오류가 발생했습니다.', '⚠️');
  }
}

function setDefaultFormDates() {
  const dep = new Date();
  dep.setDate(dep.getDate() + 21);
  const ret = new Date(dep);
  ret.setDate(ret.getDate() + 3);

  document.getElementById('inputDepDate').value = dep.toISOString().slice(0, 10);
  document.getElementById('inputRetDate').value = ret.toISOString().slice(0, 10);
}

function populateAirportSelects(selectedDestCode = null) {
  const originSelect = document.getElementById('inputOrigin');
  const currentOrigin = originSelect.value || 'ALL_KOREA';
  originSelect.innerHTML = state.origins
    .map((o) => `<option value="${o.code}" ${o.code === currentOrigin ? 'selected' : ''}>${o.city} (${o.code === 'ALL_KOREA' ? '전국통합' : o.code}) - ${o.badge}</option>`)
    .join('');

  const anywhereOriginEl = document.getElementById('anywhereOriginSelect');
  if (anywhereOriginEl) {
    anywhereOriginEl.value = originSelect.value || 'ALL_KOREA';
  }

  renderDestinationOptions(selectedDestCode);
}

function renderDestinationOptions(selectedDestCode = null, filterKeyword = '') {
  const destSelect = document.getElementById('inputDestination');
  const prevCode = selectedDestCode || destSelect.value || 'NRT';
  const kw = String(filterKeyword || '').trim().toLowerCase();

  document.getElementById('destTotalCountLabel').textContent = state.destinations.length;

  const filteredList = kw
    ? state.destinations.filter(
        (d) =>
          d.city.toLowerCase().includes(kw) ||
          d.code.toLowerCase().includes(kw) ||
          (d.country && d.country.toLowerCase().includes(kw)) ||
          (d.region && d.region.toLowerCase().includes(kw))
      )
    : state.destinations;

  const regions = {};
  for (const d of filteredList) {
    const r = d.region || '기타';
    if (!regions[r]) regions[r] = [];
    regions[r].push(d);
  }

  let html = Object.entries(regions)
    .map(
      ([region, items]) =>
        `<optgroup label="── ${escapeHtml(region)} (${items.length}곳) ──">` +
        items
          .map((d) => {
            const avg2Y = d.benchmark2Y?.avg2YKrw || d.basePriceKrw;
            const low2Y = d.benchmark2Y?.lowest2YKrw || d.dealThresholdKrw;
            const isSel = d.code === prevCode ? 'selected' : '';
            return `<option value="${escapeHtml(d.code)}" ${isSel}>${escapeHtml(d.city)} (${escapeHtml(d.code)}) · 2년 최저 ${Math.round(low2Y / 10000)}만 / 평균 ${Math.round(avg2Y / 10000)}만</option>`;
          })
          .join('') +
        `</optgroup>`
    )
    .join('');

  // 검색어와 일치하는 도시가 없는 경우 직접 입력 안내 옵션 제공
  if (filteredList.length === 0 && kw.length >= 2) {
    const cleanUpper = kw.toUpperCase().slice(0, 3);
    html = `<option value="${escapeHtml(cleanUpper)}" selected>✍️ '${escapeHtml(kw)}' (${escapeHtml(cleanUpper)}) 직접 입력 도시로 바로 조회</option>`;
  }

  const shownCode = destSelect.value;
  destSelect.innerHTML = html;

  const activeCode = destSelect.value;
  // 목표가는 도착 도시가 실제로 바뀔 때만 그 도시 기본값으로 바꾼다 (같은 도시를 빠른 검색해도 고친 목표가 유지)
  if (activeCode !== shownCode) {
    applyDefaultTargetPrice(state.destinations.find((d) => d.code === activeCode));
  }
  renderBenchmark2YPanel();
  updatePassengerTotalPreview();
}

// 도착 도시를 새로 고르면 목표가 칸을 그 도시의 기본 목표가(2년 상위 10% 특가 기준)로 채운다
function applyDefaultTargetPrice(dest) {
  if (!dest) return;
  document.getElementById('inputTargetPrice').value = dest.benchmark2Y?.top10Deal2YKrw || dest.dealThresholdKrw;
}

function filterDestinationSelect() {
  const destSelect = document.getElementById('inputDestination');
  const prevCode = destSelect?.value || '';
  const kw = document.getElementById('destQuickFilter')?.value || '';
  renderDestinationOptions(null, kw);
  // 빠른 검색으로 선택 도시가 바뀌면 change 이벤트가 없으므로 귀국일표·추천 일정·가격 추이 차트를 직접 갱신
  if (destSelect && destSelect.value && destSelect.value !== prevCode) {
    handleDestinationChange();
  }
}

/**
 * [신규] 원하는 도시 / 공항 코드 직접 입력(Custom) 토글 및 영구 추가
 */
function toggleCustomCityBox() {
  const box = document.getElementById('customCityBox');
  box.classList.toggle('hidden');
}

async function handleAddCustomDestination() {
  const code = document.getElementById('customAirportCode').value.trim().toUpperCase();
  const city = document.getElementById('customCityNameInput').value.trim();
  const country = document.getElementById('customCountryInput').value.trim() || '해외';
  const region = document.getElementById('customRegionInput').value || '기타';
  const avg2YKrw = Number(document.getElementById('customAvgPriceInput').value) || 450000;

  if (!code || code.length !== 3 || !city) {
    showToast('3자리 영문 공항 코드(예: HEL)와 한글 도시명(예: 헬싱키)을 모두 입력해 주세요.', '⚠️');
    return;
  }

  try {
    const res = await apiFetch('/api/custom-destinations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, city, country, region, avg2YKrw })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '도시 추가 실패');

    // 메타 목록 다시 불러오기
    const metaRes = await apiFetch('/api/meta');
    const meta = await metaRes.json();
    state.destinations = meta.destinations || [];

    document.getElementById('destQuickFilter').value = '';
    populateAirportSelects(code);
    // 빠른 검색의 '직접 입력' 항목으로 이미 이 코드가 골라져 있었어도 목표가는 새 도시 기본값으로
    applyDefaultTargetPrice(state.destinations.find((d) => d.code === code));
    document.getElementById('customCityBox').classList.add('hidden');
    showToast(`${city}(${code}) 도시가 목록에 추가되고 선택되었습니다!`, '✈️');

    await Promise.all([
      loadAnywhereTop10(),
      loadReturnDateMatrix(),
      loadScheduleRecommendations(),
      syncPriceChartToForm()
    ]);
  } catch (err) {
    showToast(err.message, '⚠️');
  }
}

/**
 * 폼(출발 공항·도착 도시·날짜·인원)이 바뀌면 가격 추이 차트를 '현재 선택 노선' 모드로 되돌리고 다시 불러옴
 * (기존 오류: 차트가 첫 번째 알림 규칙(도쿄 나리타)만 표시하고 폼 변경 시 갱신되지 않았음)
 */
function syncPriceChartToForm() {
  state.chartRouteMode = 'FORM';
  if (state.selectedRuleId) {
    // 차트가 폼 노선으로 돌아가므로 알림 카드의 '차트 선택' 강조도 해제
    state.selectedRuleId = null;
    renderWatchRules();
  }
  return loadRoutePriceTrend();
}

function handleDestinationChange() {
  const destCode = document.getElementById('inputDestination').value;
  applyDefaultTargetPrice(state.destinations.find((d) => d.code === destCode));
  renderBenchmark2YPanel();
  updatePassengerTotalPreview();
  loadReturnDateMatrix();
  loadScheduleRecommendations();
  syncPriceChartToForm();
}

function handleRouteOrDateChange() {
  const originVal = document.getElementById('inputOrigin')?.value || 'ALL_KOREA';
  const anywhereOriginEl = document.getElementById('anywhereOriginSelect');
  if (anywhereOriginEl && anywhereOriginEl.value !== originVal) {
    anywhereOriginEl.value = originVal;
  }
  renderBenchmark2YPanel();
  updatePassengerTotalPreview();
  loadAnywhereTop10();
  loadReturnDateMatrix();
  loadScheduleRecommendations();
  syncPriceChartToForm();
}

function handleAnywhereOriginSelectChange() {
  const anywhereOriginVal = document.getElementById('anywhereOriginSelect')?.value || 'ALL_KOREA';
  const originSelect = document.getElementById('inputOrigin');
  if (originSelect && originSelect.value !== anywhereOriginVal) {
    originSelect.value = anywhereOriginVal;
  }
  handleRouteOrDateChange();
}

function handleDepartureDateChange() {
  const depVal = document.getElementById('inputDepDate').value;
  const retVal = document.getElementById('inputRetDate').value;
  if (depVal && (!retVal || retVal <= depVal)) {
    const d = new Date(`${depVal}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 3);
    document.getElementById('inputRetDate').value = d.toISOString().slice(0, 10);
  }
  loadReturnDateMatrix();
  syncPriceChartToForm();
}

function handleReturnDateChange() {
  updatePassengerTotalPreview();
  renderReturnDateMatrix();
  syncPriceChartToForm();
}

function handlePassengerCountChange() {
  getFormPassengers();
  updatePassengerTotalPreview();
  loadAnywhereTop10();
  loadReturnDateMatrix();
  loadScheduleRecommendations();
  syncPriceChartToForm();
}

function updatePassengerTotalPreview() {
  const { adults, children, infants } = getFormPassengers();
  const targetUnit = Number(document.getElementById('inputTargetPrice')?.value || 0);
  const totalTargetKrw = computeClientPassengerTotal(targetUnit, { adults, children, infants });

  const childPart = children > 0 ? ` + 소아 ${children}명(${formatKrw(Math.round(targetUnit * 0.8))})` : '';
  const infantPart = infants > 0 ? ` + 유아 ${infants}명(${formatKrw(Math.round(targetUnit * 0.1))})` : '';

  const previewEl = document.getElementById('passengerTotalPreview');
  previewEl.innerHTML = `
    <span>성인 ${adults}명(${formatKrw(targetUnit)})${childPart}${infantPart}</span>
    <span class="mx-1.5 text-slate-300">|</span>
    <span class="text-sky-700 font-extrabold">목표가 기준 전체 인원 총액: ${formatKrw(totalTargetKrw)}</span>
  `;
}

/**
 * 선택 노선 시세 패널: 실제 운임 모드면 향후 12개월 실제 검색가(Travelpayouts), 아니면 2년 모의 시세
 */
function renderBenchmark2YPanel() {
  if (isRealFareActive('travelpayouts')) {
    renderRealBenchmarkPanel();
    return;
  }
  renderSimulatedBenchmarkPanel();
}

/**
 * 선택된 노선의 지난 2년간(24개월) 최저가 · 평균가 · 특가 기준선 벤치마크 패널 렌더링 (모의 값)
 * - fallbackNotice: 실제 검색가를 못 받아 이 패널로 대신 보여 줄 때 맨 위에 붙이는 안내
 */
function renderSimulatedBenchmarkPanel(fallbackNotice = '') {
  const originCode = document.getElementById('inputOrigin')?.value || 'ICN';
  const destCode = document.getElementById('inputDestination')?.value || 'NRT';
  const origin = state.origins.find((o) => o.code === originCode) || { city: originCode, originFactor: 1.0 };
  const dest =
    state.destinations.find((d) => d.code === destCode) || {
      code: destCode,
      city: destCode,
      flightDuration: '직접 입력 노선',
      basePriceKrw: 420000,
      dealThresholdKrw: 315000,
      benchmark2Y: {
        lowest2YKrw: 245000,
        top10Deal2YKrw: 315000,
        avg2YKrw: 420000,
        peakHigh2YKrw: 720000,
        cheapestMonths: ['5월', '6월', '9월', '11월'],
        peakMonths: ['7~8월', '12~1월']
      }
    };

  // 2년 기준값은 도착 도시별 값이므로 TOP 30 카드·알림·가격 추이 차트와 같은 숫자를 그대로 씀
  // (이전에는 출발 공항별 임의 계수를 곱해 같은 도시의 '2년 최저'가 카드와 달랐음)
  const b2y = dest.benchmark2Y || {};
  const round1000 = (v) => Math.round((Number(v) || 0) / 1000) * 1000;
  const lowest2Y = round1000(b2y.lowest2YKrw || 150000);
  const top10Deal2Y = round1000(b2y.top10Deal2YKrw || dest.dealThresholdKrw);
  const avg2Y = round1000(b2y.avg2YKrw || dest.basePriceKrw);
  const peakHigh2Y = round1000(b2y.peakHigh2YKrw || dest.basePriceKrw * 1.7);
  const outAvgOneWay = round1000(b2y.outboundAvgOneWayKrw || avg2Y * 0.49);
  const inAvgOneWay = round1000(b2y.inboundAvgOneWayKrw || avg2Y * 0.51);

  const headerBadgeBenchmark = document.getElementById('headerBadgeBenchmark');
  if (headerBadgeBenchmark) {
    headerBadgeBenchmark.textContent = `${origin.city.replace('대한민국 ', '')}↔${dest.city} · 최저 ${Math.round(lowest2Y / 10000)}만`;
  }

  const panel = document.getElementById('benchmark2YPanel');
  panel.innerHTML = `
    ${
      fallbackNotice
        ? `<div class="mb-3 text-[11px] sm:text-xs font-semibold text-amber-200 bg-amber-500/15 border border-amber-400/40 rounded-xl px-3 py-2">${escapeHtml(fallbackNotice)}</div>`
        : ''
    }
    <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-3.5">
      <div class="space-y-1">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-xs font-extrabold px-2.5 py-0.5 rounded-full bg-amber-400 text-slate-950">
            📊 24개월 모의 시세
          </span>
          <span class="text-sm sm:text-base font-extrabold text-white">
            ${escapeHtml(origin.city)}(${originCode === 'ALL_KOREA' ? '전국통합' : escapeHtml(originCode)}) ↔ ${escapeHtml(dest.city)}(${escapeHtml(destCode)})
          </span>
          <span class="text-[11px] sm:text-xs text-slate-300">
            (${escapeHtml(dest.flightDuration)} · 출국평균 ${formatKrw(outAvgOneWay)} + 귀국평균 ${formatKrw(inAvgOneWay)})
          </span>
        </div>
        <p class="text-[11px] sm:text-xs text-slate-300 leading-relaxed">
          💡 <b>편도 조합 공략 팁:</b> ${escapeHtml(b2y.priceTip || '가는 편과 오는 편을 서로 다른 항공사 편도로 조합하면 왕복 묶음 대비 평균 12~18% 저렴합니다.')}
        </p>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-300 pt-0.5">
          <span>🟢 <b>비수기 최저가 월:</b> ${(b2y.cheapestMonths || []).join(', ')}</span>
          <span>🔴 <b>성수기 할증 구간:</b> ${(b2y.peakMonths || []).join(', ')}</span>
        </div>
      </div>

      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 shrink-0">
        <div
          onclick="applyTargetPriceFromBenchmark(${lowest2Y})"
          class="cursor-pointer bg-rose-500/20 hover:bg-rose-500/30 active:scale-95 border border-rose-400/40 rounded-xl p-2.5 text-center transition"
        >
          <div class="text-[11px] text-rose-200 font-semibold">🔥 2년 역대 최저가</div>
          <div class="text-sm sm:text-base font-extrabold text-white mt-0.5">${formatKrw(lowest2Y)}</div>
          <div class="text-[10px] text-rose-300 mt-0.5">[터치 시 목표가 적용]</div>
        </div>

        <div
          onclick="applyTargetPriceFromBenchmark(${top10Deal2Y})"
          class="cursor-pointer bg-emerald-500/20 hover:bg-emerald-500/30 active:scale-95 border border-emerald-400/40 rounded-xl p-2.5 text-center transition"
        >
          <div class="text-[11px] text-emerald-200 font-semibold">🎯 상위 10% 특가 기준</div>
          <div class="text-sm sm:text-base font-extrabold text-emerald-300 mt-0.5">${formatKrw(top10Deal2Y)}</div>
          <div class="text-[10px] text-emerald-200 mt-0.5">[추천 매수 기준선]</div>
        </div>

        <div class="bg-slate-800/90 border border-slate-700 rounded-xl p-2.5 text-center">
          <div class="text-[11px] text-slate-400 font-medium">📊 2년 평균 왕복가</div>
          <div class="text-sm sm:text-base font-bold text-slate-200 mt-0.5">${formatKrw(avg2Y)}</div>
          <div class="text-[10px] text-slate-400 mt-0.5">평시 발권 기준</div>
        </div>

        <div class="bg-slate-800/60 border border-slate-700/70 rounded-xl p-2.5 text-center">
          <div class="text-[11px] text-slate-400 font-medium">⚠️ 2년 성수기 최고가</div>
          <div class="text-sm sm:text-base font-bold text-slate-400 mt-0.5">${formatKrw(peakHigh2Y)}</div>
          <div class="text-[10px] text-slate-500 mt-0.5">연휴·성수기 상단</div>
        </div>
      </div>
    </div>
  `;

  renderBenchmark2YCharts({ dest, originLabel: origin.city.replace('대한민국 ', ''), destCode });
}

/**
 * [v2.4] 선택 노선 지난 2년간 월별 평균 항공료 차트 & 요일별 평균 항공료 차트 (가는 편 / 오는 편 구분)
 * - 막대 두 계열(가는 편 = 출국 편도 평균, 오는 편 = 귀국 편도 평균)을 한 축(원)에 그림
 * - 왕복 편도합산 평균은 축을 하나 더 만들지 않고 툴팁과 '표로 보기'에 표시
 * - 색: 어두운 패널 배경(#0f172a)에서 색각이상·일반 시력 구분 검증을 통과한 파랑/주황 조합
 */
const BENCHMARK_OUTBOUND_COLOR = '#3987e5';
const BENCHMARK_INBOUND_COLOR = '#d95926';

// 각 계열에서 가장 싼 막대 위에 '최저' 글자 표시 (막대 색을 바꾸면 가는 편/오는 편 구분이 깨지므로 글자로 표시)
// 실제 검색가는 값이 없는 달·요일(null)이 있어 숫자인 막대만 비교한다
const cheapestBarLabelPlugin = {
  id: 'cheapestBarLabel',
  afterDatasetsDraw(chart) {
    const minIndexOf = (values) =>
      values.reduce((best, v, i) => (Number.isFinite(v) && (best < 0 || v < values[best]) ? i : best), -1);
    const marks = chart.data.datasets
      .map((ds, di) => {
        const meta = chart.getDatasetMeta(di);
        if (meta.hidden || !ds.data.length) return null;
        const index = minIndexOf(ds.data);
        if (index < 0) return null;
        const bar = meta.data[index];
        return bar ? { x: bar.x, y: bar.y, index } : null;
      })
      .filter(Boolean);
    // 두 계열의 최저가 같은 달(요일)이면 막대 묶음 위에 한 번만 표시해 글자가 겹치지 않게 함
    const labels =
      marks.length === 2 && marks[0].index === marks[1].index
        ? [{ x: (marks[0].x + marks[1].x) / 2, y: Math.min(marks[0].y, marks[1].y) }]
        : marks;
    const { ctx } = chart;
    ctx.save();
    ctx.fillStyle = '#e2e8f0';
    ctx.font = '600 10px Pretendard, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    labels.forEach((m) => ctx.fillText('최저', m.x, m.y - 3));
    ctx.restore();
  }
};

function setTextById(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

// Chart.js(CDN)를 못 불러왔을 때 그래프가 들어갈 빈 칸(고정 높이 상자)을 숨긴다
function hideEmptyChartBox(canvas) {
  if (canvas && canvas.parentElement) canvas.parentElement.classList.add('hidden');
}

/**
 * 도착 도시의 월별(12개)·요일별(7개) 가는 편/오는 편 평균 시계열
 * - 엔진(airports.js)의 monthlyStats2Y / dayOfWeekStats2Y 를 그대로 쓰고, 없을 때만 기본 계수로 대체
 */
function buildBenchmarkSeries(dest) {
  const b2y = dest.benchmark2Y || {};
  const avg2Y = b2y.avg2YKrw || dest.basePriceKrw || 420000;
  const outBase = b2y.outboundAvgOneWayKrw || avg2Y * 0.49;
  const inBase = b2y.inboundAvgOneWayKrw || avg2Y * 0.51;
  const fallbackMonthFactors = [1.12, 1.04, 0.9, 0.92, 0.86, 0.88, 1.16, 1.22, 0.87, 0.95, 0.86, 1.15];
  const fallbackDow = [
    { label: '월', fullLabel: '월요일', o: 0.91, i: 1.08 },
    { label: '화', fullLabel: '화요일', o: 0.81, i: 0.83 },
    { label: '수', fullLabel: '수요일', o: 0.83, i: 0.82 },
    { label: '목', fullLabel: '목요일', o: 0.93, i: 0.85 },
    { label: '금', fullLabel: '금요일', o: 1.21, i: 0.96 },
    { label: '토', fullLabel: '토요일', o: 1.24, i: 1.03 },
    { label: '일', fullLabel: '일요일', o: 0.98, i: 1.27 }
  ];
  const round500 = (v) => Math.round((Number(v) || 0) / 500) * 500;
  const toRow = (r) => {
    const out = round500(r.outboundAvgKrw);
    const inn = round500(r.inboundAvgKrw);
    return { label: r.label, fullLabel: r.fullLabel || r.label, out, inn, combined: out + inn };
  };

  const monthlySource =
    b2y.monthlyStats2Y && b2y.monthlyStats2Y.length === 12
      ? b2y.monthlyStats2Y
      : fallbackMonthFactors.map((f, idx) => ({
          label: `${idx + 1}월`,
          outboundAvgKrw: outBase * f,
          inboundAvgKrw: inBase * f
        }));
  const dowSource =
    b2y.dayOfWeekStats2Y && b2y.dayOfWeekStats2Y.length === 7
      ? b2y.dayOfWeekStats2Y
      : fallbackDow.map((d) => ({
          label: d.label,
          fullLabel: d.fullLabel,
          outboundAvgKrw: outBase * d.o,
          inboundAvgKrw: inBase * d.i
        }));

  return { monthly: monthlySource.map(toRow), dow: dowSource.map(toRow) };
}

function renderBenchmarkTable(containerId, rows, firstColLabel) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = `
    <table class="w-full text-[11px] text-slate-300 tabular-nums">
      <thead>
        <tr class="text-slate-400">
          <th scope="col" class="text-left font-semibold py-1">${firstColLabel}</th>
          <th scope="col" class="text-right font-semibold py-1">🛫 가는 편</th>
          <th scope="col" class="text-right font-semibold py-1">🛬 오는 편</th>
          <th scope="col" class="text-right font-semibold py-1">왕복 합산</th>
        </tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (r) => `
          <tr class="border-t border-slate-800">
            <th scope="row" class="text-left font-medium py-1">${escapeHtml(r.fullLabel)}</th>
            <td class="text-right py-1">${formatKrw(r.out)}</td>
            <td class="text-right py-1">${formatKrw(r.inn)}</td>
            <td class="text-right py-1">${formatKrw(r.combined)}</td>
          </tr>`
          )
          .join('')}
      </tbody>
    </table>
  `;
}

function buildBenchmarkBarChart(canvas, rows) {
  const dataset = (label, key, color) => ({
    label,
    data: rows.map((r) => r[key]),
    backgroundColor: color,
    hoverBackgroundColor: color,
    borderRadius: 4,
    borderSkipped: 'start',
    maxBarThickness: 24,
    barPercentage: 0.86,
    categoryPercentage: 0.78
  });

  return new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: rows.map((r) => r.label),
      datasets: [
        dataset('🛫 가는 편 (출국 편도) 평균', 'out', BENCHMARK_OUTBOUND_COLOR),
        dataset('🛬 오는 편 (귀국 편도) 평균', 'inn', BENCHMARK_INBOUND_COLOR)
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      layout: { padding: { top: 14 } },
      plugins: {
        legend: {
          position: 'top',
          align: 'start',
          labels: { color: '#cbd5e1', boxWidth: 10, boxHeight: 10, font: { family: 'Pretendard', size: 10 } }
        },
        tooltip: {
          callbacks: {
            title: (items) => rows[items[0].dataIndex].fullLabel,
            label: (context) => `${context.dataset.label}: ${formatKrw(context.parsed.y)}`,
            footer: (items) => `왕복 편도합산 평균: ${formatKrw(rows[items[0].dataIndex].combined)}`
          }
        }
      },
      scales: {
        x: {
          ticks: { color: '#94a3b8', font: { size: 10 } },
          grid: { display: false }
        },
        y: {
          beginAtZero: true,
          ticks: { color: '#94a3b8', font: { size: 10 }, callback: (val) => `${Math.round(val / 10000)}만` },
          grid: { color: 'rgba(148, 163, 184, 0.14)' },
          border: { display: false }
        }
      }
    },
    plugins: [cheapestBarLabelPlugin]
  });
}

function renderBenchmark2YCharts({ dest, originLabel, destCode }) {
  const { monthly, dow } = buildBenchmarkSeries(dest);
  drawBenchmarkCharts({
    monthly,
    dow,
    monthlySubtitle: `${originLabel} ↔ ${dest.city}(${destCode}) · 월별 평균 (가는 편 ${originLabel}→${dest.city}, 오는 편 ${dest.city}→${originLabel})`,
    dowSubtitle: `${originLabel} ↔ ${dest.city}(${destCode}) · 가는 편은 출국 요일, 오는 편은 귀국 요일 기준 평균`
  });
}

// 값이 있는 행 중 가장 싼 행의 이름 (값이 하나도 없으면 '-')
function cheapestRowLabel(rows, key, labelKey = 'label') {
  const valid = rows.filter((r) => Number.isFinite(r[key]));
  if (!valid.length) return '-';
  return valid.reduce((best, r) => (r[key] < best[key] ? r : best), valid[0])[labelKey];
}

// 월별·요일별 막대 차트와 '표로 보기' (2년 모의 시세와 12개월 실제 검색가가 같이 쓴다)
function drawBenchmarkCharts({ monthly, dow, monthlySubtitle, dowSubtitle }) {
  const monthlyCanvas = document.getElementById('monthlyBenchmarkChart');
  const dowCanvas = document.getElementById('dowBenchmarkChart');
  if (!monthlyCanvas || !dowCanvas) return;

  const monthlySummary = `가는 편 최저 ${cheapestRowLabel(monthly, 'out')} · 오는 편 최저 ${cheapestRowLabel(monthly, 'inn')}`;
  const dowSummary = `가는 편 최저 ${cheapestRowLabel(dow, 'out', 'fullLabel')} · 오는 편 최저 ${cheapestRowLabel(dow, 'inn', 'fullLabel')}`;

  setTextById('monthlyCheapestBadge', monthlySummary);
  setTextById('dowCheapestBadge', dowSummary);
  setTextById('monthlyBenchmarkChartSubtitle', monthlySubtitle);
  setTextById('dowBenchmarkChartSubtitle', dowSubtitle);
  monthlyCanvas.setAttribute('aria-label', `월별 평균 항공료 막대 차트. ${monthlySummary}`);
  dowCanvas.setAttribute('aria-label', `요일별 평균 항공료 막대 차트. ${dowSummary}`);

  renderBenchmarkTable('monthlyBenchmarkTable', monthly, '월');
  renderBenchmarkTable('dowBenchmarkTable', dow, '요일');

  // Chart.js(CDN)를 못 불러오면 빈 차트 칸을 숨기고 위에서 채운 표를 펼쳐 보여 줌 (배지는 이미 갱신됨)
  if (typeof Chart === 'undefined') {
    [monthlyCanvas, dowCanvas].forEach(hideEmptyChartBox);
    ['monthlyBenchmarkTable', 'dowBenchmarkTable'].forEach((id) => {
      const details = document.getElementById(id)?.closest('details');
      if (details) details.open = true;
    });
    return;
  }
  if (monthlyBenchmarkChartInstance) monthlyBenchmarkChartInstance.destroy();
  monthlyBenchmarkChartInstance = buildBenchmarkBarChart(monthlyCanvas, monthly);

  if (dowBenchmarkChartInstance) dowBenchmarkChartInstance.destroy();
  dowBenchmarkChartInstance = buildBenchmarkBarChart(dowCanvas, dow);
}

/**
 * [실제 운임 모드] 선택 노선 향후 12개월 실제 검색가 (Travelpayouts · 프록시 /api/route-stats)
 * - 접혀 있는 동안은 조회하지 않는다 (전국 통합이면 공항 7곳 × 12개월을 조회)
 * - 같은 노선은 다시 조회하지 않고, 실패하면 1분 동안은 모의 시세로 보여 준 뒤 다시 시도한다
 */
const REAL_BENCHMARK_RETRY_MS = 60 * 1000;
// 도착지를 빠르게 바꾸면 마지막 노선만 조회한다 (노선 하나에 Travelpayouts 호출이 100번 넘게 든다 · 분당 600회 한도)
const REAL_BENCHMARK_DEBOUNCE_MS = 500;
const realBenchmark = { key: null, data: null, error: null, errorAt: 0, loading: false, seq: 0 };

// 실제 운임 모드를 켜거나 끌 때 (realFares.js) 지난 결과와 진행 중인 응답을 버린다
function resetRealBenchmark() {
  Object.assign(realBenchmark, { key: null, data: null, error: null, errorAt: 0, loading: false, seq: realBenchmark.seq + 1 });
}

function currentBenchmarkRoute() {
  return {
    origin: document.getElementById('inputOrigin')?.value || 'ICN',
    destination: document.getElementById('inputDestination')?.value || 'NRT',
    directOnly: document.getElementById('inputDirectOnly')?.checked ?? true
  };
}

function benchmarkRouteLabels({ origin, destination }) {
  const originMeta = state.origins.find((o) => o.code === origin) || { city: origin };
  const destMeta = state.destinations.find((d) => d.code === destination) || { city: destination };
  return { originCity: originMeta.city, originLabel: originMeta.city.replace('대한민국 ', ''), destCity: destMeta.city };
}

async function renderRealBenchmarkPanel() {
  const route = currentBenchmarkRoute();
  const key = `${route.origin}|${route.destination}|${route.directOnly}`;
  const { originLabel, destCity } = benchmarkRouteLabels(route);
  if (state.collapsedSections.sectionBenchmark2Y) {
    setTextById('headerBadgeBenchmark', `${originLabel}↔${destCity} · 펼치면 실제 검색가 조회`);
    return;
  }
  if (realBenchmark.key === key) {
    if (realBenchmark.loading) return; // 같은 노선을 이미 불러오는 중 (그 응답이 그린다)
    const errorIsFresh = realBenchmark.error && Date.now() - realBenchmark.errorAt < REAL_BENCHMARK_RETRY_MS;
    if (realBenchmark.data || errorIsFresh) {
      drawRealBenchmark(route);
      return;
    }
  }

  Object.assign(realBenchmark, { key, data: null, error: null, loading: true });
  const seq = ++realBenchmark.seq;
  setTextById('headerBadgeBenchmark', `${originLabel}↔${destCity} · 실제 검색가 불러오는 중`);
  document.getElementById('benchmark2YPanel').innerHTML = `
    <div class="text-xs text-slate-300 py-3">📡 ${escapeHtml(originLabel)} ↔ ${escapeHtml(destCity)} 향후 12개월 실제 검색가(Travelpayouts)를 불러오는 중입니다…</div>
  `;
  try {
    await new Promise((resolve) => setTimeout(resolve, REAL_BENCHMARK_DEBOUNCE_MS));
    if (seq !== realBenchmark.seq) return; // 그 사이 다른 노선을 골랐다
    const data = await proxyFetch('route-stats', {
      params: { origin: route.origin, destination: route.destination, directOnly: String(route.directOnly) }
    });
    if (seq !== realBenchmark.seq) return;
    realBenchmark.data = data;
  } catch (err) {
    if (seq !== realBenchmark.seq) return;
    realBenchmark.error = describeRealFareFailure(err);
    realBenchmark.errorAt = Date.now();
  }
  realBenchmark.loading = false;
  drawRealBenchmark(route);
}

function realBenchmarkRows(stats) {
  const round500 = (v) => (Number.isFinite(v) ? Math.round(v / 500) * 500 : null);
  return (stats || []).map((r) => {
    const out = round500(r.outboundAvgKrw);
    const inn = round500(r.inboundAvgKrw);
    return { label: r.label, fullLabel: r.fullLabel || r.label, out, inn, combined: out !== null && inn !== null ? out + inn : null };
  });
}

function realBenchmarkTileHtml({ title, priceKrw, sub, tone, applyable = false }) {
  const tones = {
    rose: 'bg-rose-500/20 border-rose-400/40 text-rose-200',
    sky: 'bg-sky-500/15 border-sky-400/40 text-sky-200',
    slate: 'bg-slate-800/90 border-slate-700 text-slate-400'
  };
  const clickable = applyable && Number.isFinite(priceKrw);
  return `
    <div
      ${clickable ? `onclick="applyTargetPriceFromBenchmark(${priceKrw})"` : ''}
      class="${clickable ? 'cursor-pointer hover:brightness-125 active:scale-95' : ''} border rounded-xl p-2.5 text-center transition ${tones[tone]}"
    >
      <div class="text-[11px] font-semibold">${title}</div>
      <div class="text-sm sm:text-base font-extrabold text-white mt-0.5">${formatKrw(priceKrw)}</div>
      <div class="text-[10px] mt-0.5 opacity-90">${sub}</div>
    </div>
  `;
}

function drawRealBenchmark(route) {
  const data = realBenchmark.data;
  if (!isRealFareActive('travelpayouts') || !data) {
    renderSimulatedBenchmarkPanel(
      realBenchmark.error ? `⚠️ 실제 검색가 조회 실패(${realBenchmark.error}) → 아래는 모의 2년 시세입니다` : ''
    );
    return;
  }
  const { originCity, originLabel, destCity } = benchmarkRouteLabels(route);
  const s = data.summary || {};
  const lowOut = s.lowestOutbound;
  const lowIn = s.lowestInbound;
  const lowestPairKrw = lowOut && lowIn ? lowOut.priceKrw + lowIn.priceKrw : null;
  const avgPairKrw = Number.isFinite(s.avgOutboundKrw) && Number.isFinite(s.avgInboundKrw) ? s.avgOutboundKrw + s.avgInboundKrw : null;
  const hasData = (s.outboundDays || 0) + (s.inboundDays || 0) > 0;
  const dayText = (low, verb) => (low ? `${low.date.slice(5)} ${verb}` : '최근 검색 없음');
  const fetchedText = data.fetchedAt ? `${formatDateTime(data.fetchedAt)} 수집` : '수집 시각 모름';

  setTextById(
    'headerBadgeBenchmark',
    `${originLabel}↔${destCity} · ${lowestPairKrw ? `실제 최저 ${Math.round(lowestPairKrw / 10000)}만` : '실제 검색가 없음'}`
  );
  document.getElementById('benchmark2YPanel').innerHTML = `
    <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-3.5" data-real-benchmark>
      <div class="space-y-1">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-xs font-extrabold px-2.5 py-0.5 rounded-full bg-sky-400 text-slate-950">📡 향후 12개월 실제 검색가</span>
          <span class="text-sm sm:text-base font-extrabold text-white">
            ${escapeHtml(originCity)}(${route.origin === 'ALL_KOREA' ? '전국통합' : escapeHtml(route.origin)}) ↔ ${escapeHtml(destCity)}(${escapeHtml(route.destination)})
          </span>
        </div>
        <p class="text-[11px] sm:text-xs text-slate-300 leading-relaxed">
          Travelpayouts 가 모은 <b>다른 이용자들의 최근 48시간 검색 가격</b>입니다 (실시간 아님 · ${escapeHtml(fetchedText)}${data.partial ? ' · 일부 달 조회 실패' : ''}).
          날짜별 최저가로 셈했고 값이 있는 날은 가는 편 ${s.outboundDays || 0}일 · 오는 편 ${s.inboundDays || 0}일이며, 검색이 없던 날은 비어 있습니다.
        </p>
        ${
          hasData
            ? ''
            : '<p class="text-[11px] sm:text-xs font-semibold text-amber-300">이 노선은 최근 검색된 가격이 없습니다. 다른 노선을 고르거나 모의 가격으로 보세요.</p>'
        }
      </div>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 shrink-0">
        ${realBenchmarkTileHtml({ title: '🔥 편도 최저 합', priceKrw: lowestPairKrw, sub: '[터치 시 목표가 적용]', tone: 'rose', applyable: true })}
        ${realBenchmarkTileHtml({ title: '🛫 가는 편 최저', priceKrw: lowOut?.priceKrw ?? null, sub: dayText(lowOut, '출발'), tone: 'sky' })}
        ${realBenchmarkTileHtml({ title: '🛬 오는 편 최저', priceKrw: lowIn?.priceKrw ?? null, sub: dayText(lowIn, '귀국'), tone: 'sky' })}
        ${realBenchmarkTileHtml({ title: '📊 평균 왕복(편도 합)', priceKrw: avgPairKrw, sub: '값이 있는 날 평균', tone: 'slate' })}
      </div>
    </div>
  `;

  drawBenchmarkCharts({
    monthly: realBenchmarkRows(data.monthlyStats),
    dow: realBenchmarkRows(data.dayOfWeekStats),
    monthlySubtitle: `${originLabel} ↔ ${destCity}(${route.destination}) · 이번 달부터 12개월, 날짜별 최저 검색가의 월 평균 (값이 없는 달은 비어 있음)`,
    dowSubtitle: `${originLabel} ↔ ${destCity}(${route.destination}) · 가는 편은 출국 요일, 오는 편은 귀국 요일 기준 평균 (최근 검색가)`
  });
}

function applyTargetPriceFromBenchmark(price) {
  document.getElementById('inputTargetPrice').value = price;
  handleTargetPriceInput();
  showToast(`희망 목표가가 ${formatKrw(price)}으로 설정되었습니다!`, '🎯');
}

function handleTargetPriceInput() {
  updatePassengerTotalPreview();
  refreshPriceChartTargetFromForm();
}

/**
 * 목표가를 바꾸면 '현재 선택 노선' 차트의 목표선과 매수 조언도 바로 바뀐다 (가격은 다시 불러오지 않고 다시 그림)
 */
function refreshPriceChartTargetFromForm() {
  const data = state.routeTrendData;
  if (state.chartRouteMode !== 'FORM' || !data || !data.query) return;
  const targetPrice = Number(document.getElementById('inputTargetPrice')?.value || 0);
  state.routeTrendData = { ...data, query: { ...data.query, targetPrice } };
  renderPriceChart({ animate: false });
}

/**
 * 스마트 일정 탐색기 3개 탭 전환
 */
function switchExplorerTab(tabName) {
  state.activeExplorerTab = tabName;
  const tabs = [
    { name: 'ANYWHERE_TOP10', btn: 'tabBtnAnywhereTop10', panel: 'panelAnywhereTop10' },
    { name: 'RETURN_MATRIX', btn: 'tabBtnReturnMatrix', panel: 'panelReturnMatrix' },
    { name: 'CHEAP_RECOMMEND', btn: 'tabBtnCheapRecommend', panel: 'panelCheapRecommend' }
  ];

  tabs.forEach((t) => {
    const btnEl = document.getElementById(t.btn);
    const panelEl = document.getElementById(t.panel);
    if (!btnEl || !panelEl) return;
    if (t.name === tabName) {
      btnEl.className = 'text-xs px-3 py-2.5 rounded-xl font-bold bg-slate-900 text-white shadow-sm transition text-center';
      panelEl.classList.remove('hidden');
    } else {
      btnEl.className = 'text-xs px-3 py-2.5 rounded-xl font-semibold text-slate-600 hover:text-slate-900 transition text-center';
      panelEl.classList.add('hidden');
    }
  });
}

/**
 * [핵심 기능] 도시를 지정하지 않고 향후 6개월(180일) 이내 무조건 가장 싼 금액순 TOP 10 · TOP 20 · TOP 30 로드 및 3단 구분 렌더링
 */
async function loadAnywhereTop10() {
  const origin = document.getElementById('anywhereOriginSelect')?.value || document.getElementById('inputOrigin')?.value || 'ALL_KOREA';
  const region = document.getElementById('anywhereRegionSelect')?.value || 'ALL';
  const sortBy = document.getElementById('anywhereSortSelect')?.value || 'LOWEST_PRICE';
  const directOnly = document.getElementById('inputDirectOnly')?.checked ?? true;
  const { adults, children, infants } = getFormPassengers();

  const params = new URLSearchParams({
    origin,
    region,
    sortBy,
    limit: '30',
    adults: String(adults),
    children: String(children),
    infants: String(infants),
    directOnly: String(directOnly)
  });

  const seq = ++anywhereTop10RequestSeq;
  if (isRealFareActive('travelpayouts')) {
    setTextById('anywhereScannedSummary', '📡 실제 검색가(Travelpayouts)를 불러오는 중… 처음 조회는 10초 넘게 걸릴 수 있습니다');
  }
  // 실제 운임 모드면 프록시(Travelpayouts), 아니면 또는 실패하면 아래 모의 가격 엔진 (realFares.js)
  const data = await loadFareFeature('anywhere-top10', params, () => apiFetch(`/api/anywhere-top10?${params.toString()}`));
  if (seq !== anywhereTop10RequestSeq) return;
  state.anywhereTop10Data = data;
  renderAnywhereTop10();
}

function switchAnywhereTierView(tierKey) {
  state.activeAnywhereTier = tierKey;
  if (tierKey === 'TOP10' || tierKey === 'TOP20' || tierKey === 'TOP30') {
    state.collapsedTiers[tierKey] = false;
  }
  renderAnywhereTop10();
}

function toggleAnywhereCumulativeMode() {
  state.anywhereCumulativeMode = !state.anywhereCumulativeMode;
  renderAnywhereTop10();
}

function renderAnywhereDealCardHtml(deal, tierBadgeStyle) {
  const rankMedal =
    deal.rank === 1
      ? '🥇 1위'
      : deal.rank === 2
      ? '🥈 2위'
      : deal.rank === 3
      ? '🥉 3위'
      : `${deal.rank}위`;

  const rankColor =
    deal.rank === 1
      ? 'bg-amber-400 text-slate-950 font-extrabold'
      : deal.rank <= 3
      ? 'bg-sky-600 text-white font-extrabold'
      : deal.rank <= 10
      ? 'bg-slate-900 text-white font-bold'
      : deal.rank <= 20
      ? 'bg-indigo-600 text-white font-bold'
      : 'bg-emerald-700 text-white font-bold';

  const links = deal.bookingLinks || {};
  const outNaverUrl = links.outboundNaverUrl || deal.outboundLeg?.naverOneWayUrl || '#';
  const inNaverUrl = links.inboundNaverUrl || deal.inboundLeg?.naverOneWayUrl || '#';
  const outOfficialUrl = links.outboundAirlineOfficialUrl || deal.outboundLeg?.officialBookingUrl || '#';
  const inOfficialUrl = links.inboundAirlineOfficialUrl || deal.inboundLeg?.officialBookingUrl || '#';
  const naverRoundUrl = links.naverUrl || '#';
  const skyscannerUrl = links.skyscannerUrl || '#';
  const googleFlightsUrl = links.googleFlightsUrl || '#';
  const tripComUrl = links.tripComUrl || '#';
  const outAirline = escapeHtml(deal.outboundLeg.airline);
  const inAirline = escapeHtml(deal.inboundLeg.airline);

  const originCityShort = (deal.originCity || '인천').replace('서울/', '').replace('부산/', '');
  // 실제 검색가(최근 검색)에는 2년 기준값이 없다 → 할인율 대신 출처를, 2년 평균·최저 대신 가격 출처 링크를 보여 준다
  const hasBenchmark2Y = Number.isFinite(deal.discountVs2YAvgPercent);
  const discountBadgeHtml = hasBenchmark2Y
    ? `<span class="text-[11px] font-extrabold text-rose-600 bg-rose-50 border border-rose-200 px-2 py-0.5 rounded-md">2년평균 -${deal.discountVs2YAvgPercent}%</span>`
    : '<span class="text-[11px] font-extrabold text-sky-700 bg-sky-50 border border-sky-200 px-2 py-0.5 rounded-md">📡 최근 검색가</span>';
  const benchmarkLineHtml = hasBenchmark2Y
    ? `<span>2년평균 ${formatKrw(deal.avg2YKrw)}</span><span>2년최저 ${formatKrw(deal.lowest2YKrw)}</span>`
    : `<span>Travelpayouts 최근 검색 기준</span><span class="flex gap-1.5">${fareSourceLinkHtml(deal.outboundLeg, '가는 편 출처 ↗')}${fareSourceLinkHtml(deal.inboundLeg, '오는 편 출처 ↗')}</span>`;

  return `
    <div class="rounded-2xl border ${
      deal.rank <= 3
        ? 'border-sky-400 bg-sky-50/25 shadow-sm'
        : deal.rank <= 10
        ? 'border-slate-200/90 bg-white'
        : deal.rank <= 20
        ? 'border-indigo-200/80 bg-white'
        : 'border-emerald-200/80 bg-white'
    } p-3.5 flex flex-col justify-between hover:border-sky-500 transition">
      <div>
        <!-- 순위, 그룹 배지 및 할인율 -->
        <div class="flex items-center justify-between gap-1 mb-2">
          <div class="flex items-center gap-1">
            <span class="text-[11px] px-2.5 py-0.5 rounded-full ${rankColor}">
              ${rankMedal}
            </span>
            <span class="text-[10px] font-bold px-1.5 py-0.5 rounded ${tierBadgeStyle}">
              ${deal.tierGroup || (deal.rank <= 10 ? 'TOP 10' : deal.rank <= 20 ? 'TOP 20' : 'TOP 30')}
            </span>
          </div>
          ${discountBadgeHtml}
        </div>

        <!-- 한국 출발 공항 배지 + 도착 도시명 및 국가 -->
        <div class="flex items-center justify-between gap-1 mb-1">
          <span class="text-[10px] font-extrabold px-2 py-0.5 rounded-md bg-indigo-50 text-indigo-700 border border-indigo-200">
            🛫 ${originCityShort}(${deal.origin}) 출발
          </span>
          <span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 font-semibold shrink-0">
            ${escapeHtml(deal.country)}
          </span>
        </div>
        <div class="text-sm font-extrabold text-slate-900 truncate">
          ${originCityShort} ↔ ${escapeHtml(deal.destinationCity)} (${escapeHtml(deal.destination)})
        </div>

        <!-- 향후 6개월 내 최적 일정 -->
        <div class="mt-1.5 text-[11px] font-bold text-sky-800 bg-sky-100/70 px-2 py-1 rounded-lg">
          🗓️ [${deal.monthLabel}] ${deal.departureDate.slice(5)}(${deal.departureDayOfWeekKo}) ~ ${deal.returnDate.slice(5)}(${deal.returnDayOfWeekKo}) · ${deal.stayLabel}
        </div>

        <!-- 가는편 + 오는편 편도 조합 내역 및 편도별 즉시 예약 링크 -->
        <div class="mt-2 bg-slate-50 rounded-xl p-2 border border-slate-200/70 text-[11px] space-y-1.5">
          <div>
            <div class="flex justify-between items-center">
              <span class="text-slate-500">🛫 출국편도 (${deal.origin}→${deal.destination})</span>
              <span class="font-bold text-slate-800">${outAirline} ${formatKrw(deal.outboundLeg.oneWayPriceKrw)}</span>
            </div>
            <div class="flex items-center justify-end gap-1.5 mt-0.5 text-[10px]">
              <a href="${outNaverUrl}" target="_blank" rel="noopener noreferrer" class="text-sky-600 hover:underline font-bold">네이버 편도예약 ↗</a>
              <span class="text-slate-300">·</span>
              <a href="${outOfficialUrl}" target="_blank" rel="noopener noreferrer" class="text-slate-600 hover:underline font-semibold">${outAirline} 공식 ↗</a>
            </div>
          </div>

          <div class="border-t border-slate-200/60 pt-1">
            <div class="flex justify-between items-center">
              <span class="text-slate-500">🛬 귀국편도 (${deal.destination}→${deal.origin})</span>
              <span class="font-bold text-slate-800">${inAirline} ${formatKrw(deal.inboundLeg.oneWayPriceKrw)}</span>
            </div>
            <div class="flex items-center justify-end gap-1.5 mt-0.5 text-[10px]">
              <a href="${inNaverUrl}" target="_blank" rel="noopener noreferrer" class="text-indigo-600 hover:underline font-bold">네이버 편도예약 ↗</a>
              <span class="text-slate-300">·</span>
              <a href="${inOfficialUrl}" target="_blank" rel="noopener noreferrer" class="text-slate-600 hover:underline font-semibold">${inAirline} 공식 ↗</a>
            </div>
          </div>
        </div>

        <!-- 2년 최저/평균 대비 현재 가격 -->
        <div class="mt-2.5 pt-2 border-t border-slate-100">
          <div class="flex items-center justify-between gap-1 text-[10px] text-slate-400">
            ${benchmarkLineHtml}
          </div>
          <div class="flex items-baseline justify-between mt-1">
            <span class="text-[11px] font-semibold text-slate-500">1인 편도합산${fareChipHtml(deal.fareSource)}</span>
            <span class="text-base font-extrabold text-slate-900">${formatKrw(deal.combinedAdultPriceKrw)}</span>
          </div>
          <div class="flex items-baseline justify-between text-[11px] mt-0.5">
            <span class="text-slate-400 truncate">${deal.passengerSummaryText}</span>
            <span class="font-bold text-sky-700">${formatKrw(deal.totalPassengersPriceKrw)}</span>
          </div>
        </div>
      </div>

      <div class="mt-2.5 pt-2 border-t border-slate-100 space-y-1.5">
        <!-- 통합 예약 바로가기 링크 버튼 그룹 -->
        ${bookingNoteHtml(deal.fareSource)}
        <div class="grid grid-cols-2 gap-1">
          <a
            href="${naverRoundUrl}"
            target="_blank"
            rel="noopener noreferrer"
            class="text-center text-[11px] py-2 sm:py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 active:scale-95 text-white font-bold transition"
          >
            🟢 네이버 예약 ↗
          </a>
          <a
            href="${skyscannerUrl}"
            target="_blank"
            rel="noopener noreferrer"
            class="text-center text-[11px] py-2 sm:py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 active:scale-95 text-white font-bold transition"
          >
            🔵 스카이스캐너 ↗
          </a>
        </div>
        <div class="grid grid-cols-2 gap-1">
          <a
            href="${googleFlightsUrl}"
            target="_blank"
            rel="noopener noreferrer"
            class="text-center text-[10px] py-1.5 sm:py-1 rounded-md bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold transition"
          >
            🌐 구글 플라이트 ↗
          </a>
          <a
            href="${tripComUrl}"
            target="_blank"
            rel="noopener noreferrer"
            class="text-center text-[10px] py-1.5 sm:py-1 rounded-md bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold transition"
          >
            ✈️ 트립닷컴 예약 ↗
          </a>
        </div>

        <!-- 폼 적용 및 알림 등록 -->
        <div class="grid grid-cols-2 gap-1.5 pt-0.5">
          <button
            onclick="applyAnywhereDealToForm('${deal.origin}', '${deal.destination}', '${deal.departureDate}', '${deal.returnDate}', ${deal.combinedAdultPriceKrw})"
            class="text-[11px] py-2 sm:py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 active:scale-95 text-slate-800 font-bold transition"
          >
            노선·일정 선택
          </button>
          <button
            onclick="quickAddDealToWatchlist('${deal.origin}', '${deal.destination}', '${deal.departureDate}', '${deal.returnDate}', ${deal.combinedAdultPriceKrw})"
            class="text-[11px] py-2 sm:py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 active:scale-95 text-white font-bold transition"
          >
            + 알림 등록
          </button>
        </div>
      </div>
    </div>
  `;
}

// 실제 검색가는 노선이 30개보다 적을 수 있어, 빈 묶음은 '0원~0원' 대신 '해당 노선 없음'으로 보여 준다
function tierPriceRangeText(tier, separator = '~') {
  return tier?.items?.length ? `${formatKrw(tier.minPriceKrw)}${separator}${formatKrw(tier.maxPriceKrw)}` : '해당 노선 없음';
}

function tierAvgText(tier) {
  return tier?.items?.length ? formatKrw(tier.avgPriceKrw) : '-';
}

function renderAnywhereTop10() {
  const data = state.anywhereTop10Data;
  const summaryBarEl = document.getElementById('anywhereTierSummaryBar');
  const gridEl = document.getElementById('anywhereTop10Grid');
  if (!data || !data.tiers) return;

  const { top10, top20, top30 } = data.tiers;
  const activeTier = state.activeAnywhereTier || 'ALL_3_TIERS';

  const scopeText = `${data.originCity}(${data.origin === 'ALL_KOREA' ? '전국통합' : data.origin}) · ${
    data.region === 'ALL' ? '전 세계' : data.region
  }`;
  const totalDeals = [top10, top20, top30].reduce((acc, tier) => acc + (tier?.items?.length || 0), 0);
  document.getElementById('anywhereScannedSummary').textContent = data.realFare
    ? `${scopeText} · 최근 검색가가 있는 ${data.scannedCitiesCount}개 도시 중 ${totalDeals}개 노선`
    : `${scopeText} ${data.scannedCitiesCount}개 도시 스캔 · 총 30개 노선`;
  setFareSourceLine('anywhereFareSourceLine', data);

  if (data.realFare && totalDeals === 0) {
    if (summaryBarEl) summaryBarEl.innerHTML = '';
    gridEl.innerHTML = `
      <div class="text-center py-10 px-4 text-slate-500 text-sm border border-dashed border-slate-200 rounded-2xl">
        최근 48시간 안에 검색된 가격이 있는 노선을 찾지 못했습니다. 권역·출발 공항을 바꾸거나 '직항만'을 해제해 보세요.
      </div>
    `;
    return;
  }

  // 상단 3단계 구분 요약 및 탭 버튼 바 (모바일 2x2 그리드 최적화)
  if (summaryBarEl) {
    summaryBarEl.innerHTML = `
      <button
        onclick="switchAnywhereTierView('ALL_3_TIERS')"
        class="text-left rounded-2xl p-2.5 sm:p-3.5 border transition ${
          activeTier === 'ALL_3_TIERS'
            ? 'border-slate-900 bg-slate-900 text-white shadow-md'
            : 'border-slate-200 bg-slate-50 hover:bg-white text-slate-800'
        }"
      >
        <div class="flex items-center justify-between gap-1">
          <span class="text-[11px] sm:text-xs font-extrabold truncate">📊 전체 3단 보기</span>
          <span class="text-[10px] px-1.5 sm:px-2 py-0.5 rounded-full shrink-0 ${
            activeTier === 'ALL_3_TIERS' ? 'bg-sky-500 text-white font-bold' : 'bg-slate-200 text-slate-700 font-semibold'
          }">${totalDeals}개</span>
        </div>
        <div class="text-[10px] sm:text-[11px] mt-1 ${activeTier === 'ALL_3_TIERS' ? 'text-slate-300' : 'text-slate-500'}">
          <b>TOP 10·20·30</b> 그룹별 접기/펼치기
        </div>
      </button>

      <button
        onclick="switchAnywhereTierView('TOP10')"
        class="text-left rounded-2xl p-2.5 sm:p-3.5 border transition ${
          activeTier === 'TOP10'
            ? 'border-sky-600 bg-sky-600 text-white shadow-md'
            : 'border-sky-200 bg-sky-50/50 hover:bg-sky-50 text-slate-800'
        }"
      >
        <div class="flex items-center justify-between gap-1">
          <span class="text-[11px] sm:text-xs font-extrabold truncate">🥇 TOP 10 (1~10위)</span>
          <span class="text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ${
            activeTier === 'TOP10' ? 'bg-white text-sky-700 font-extrabold' : 'bg-sky-100 text-sky-800 font-bold'
          }">초특가</span>
        </div>
        <div class="text-[11px] sm:text-xs font-extrabold mt-1 truncate ${activeTier === 'TOP10' ? 'text-white' : 'text-sky-900'}">
          ${tierPriceRangeText(top10)}
        </div>
        <div class="text-[10px] mt-0.5 truncate ${activeTier === 'TOP10' ? 'text-sky-100' : 'text-slate-500'}">
          평균 <b>${tierAvgText(top10)}</b>
        </div>
      </button>

      <button
        onclick="switchAnywhereTierView('TOP20')"
        class="text-left rounded-2xl p-2.5 sm:p-3.5 border transition ${
          activeTier === 'TOP20'
            ? 'border-indigo-600 bg-indigo-600 text-white shadow-md'
            : 'border-indigo-200 bg-indigo-50/50 hover:bg-indigo-50 text-slate-800'
        }"
      >
        <div class="flex items-center justify-between gap-1">
          <span class="text-[11px] sm:text-xs font-extrabold truncate">🥈 TOP 20 (11~20위)</span>
          <span class="text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ${
            activeTier === 'TOP20' ? 'bg-white text-indigo-700 font-extrabold' : 'bg-indigo-100 text-indigo-800 font-bold'
          }">가성비</span>
        </div>
        <div class="text-[11px] sm:text-xs font-extrabold mt-1 truncate ${activeTier === 'TOP20' ? 'text-white' : 'text-indigo-900'}">
          ${tierPriceRangeText(top20)}
        </div>
        <div class="text-[10px] mt-0.5 truncate ${activeTier === 'TOP20' ? 'text-indigo-100' : 'text-slate-500'}">
          평균 <b>${tierAvgText(top20)}</b>
        </div>
      </button>

      <button
        onclick="switchAnywhereTierView('TOP30')"
        class="text-left rounded-2xl p-2.5 sm:p-3.5 border transition ${
          activeTier === 'TOP30'
            ? 'border-emerald-600 bg-emerald-600 text-white shadow-md'
            : 'border-emerald-200 bg-emerald-50/50 hover:bg-emerald-50 text-slate-800'
        }"
      >
        <div class="flex items-center justify-between gap-1">
          <span class="text-[11px] sm:text-xs font-extrabold truncate">🥉 TOP 30 (21~30위)</span>
          <span class="text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ${
            activeTier === 'TOP30' ? 'bg-white text-emerald-700 font-extrabold' : 'bg-emerald-100 text-emerald-800 font-bold'
          }">실속형</span>
        </div>
        <div class="text-[11px] sm:text-xs font-extrabold mt-1 truncate ${activeTier === 'TOP30' ? 'text-white' : 'text-emerald-900'}">
          ${tierPriceRangeText(top30)}
        </div>
        <div class="text-[10px] mt-0.5 truncate ${activeTier === 'TOP30' ? 'text-emerald-100' : 'text-slate-500'}">
          평균 <b>${tierAvgText(top30)}</b>
        </div>
      </button>
    `;
  }

  // 개별 티어 섹션 HTML 빌더 (그룹별 접었다 폈다 아코디언 헤더 포함!)
  const buildTierSectionHtml = (tierKey, tierObj, theme, showCumulativeToggle = false) => {
    const isTierCollapsed = Boolean(state.collapsedTiers[tierKey]);
    const itemsToRender =
      showCumulativeToggle && state.anywhereCumulativeMode && tierObj.cumulativeItems
        ? tierObj.cumulativeItems
        : tierObj.items;

    const rangeText =
      showCumulativeToggle && state.anywhereCumulativeMode
        ? `1위 ~ ${tierObj.rankEnd}위 누적 (${itemsToRender.length}개)`
        : `${tierObj.rankStart}위 ~ ${tierObj.rankEnd}위 (${itemsToRender.length}개)`;

    return `
      <div class="rounded-2xl border ${theme.border} ${theme.bg} overflow-hidden">
        <!-- 티어 그룹 접기/펼치기 헤더 -->
        <div
          onclick="toggleTierGroupCollapse('${tierKey}')"
          class="cursor-pointer select-none p-3 sm:p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-2 hover:bg-white/50 transition ${
            isTierCollapsed ? '' : `border-b ${theme.divider}`
          }"
        >
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-1.5 sm:gap-2">
              <span class="text-xs font-extrabold px-2.5 py-1 rounded-lg ${theme.badge}">
                ${tierObj.label}
              </span>
              <span class="text-xs font-bold text-slate-700">
                ${rangeText}
              </span>
              <span class="text-[11px] font-bold ${theme.priceText} bg-white px-2 py-0.5 rounded-md border ${theme.border}">
                ${tierPriceRangeText(tierObj, ' ~ ')}
              </span>
            </div>
            <p class="text-[11px] text-slate-600 mt-1 hidden sm:block">
              ${tierObj.description}
            </p>
          </div>

          <div class="flex items-center justify-between sm:justify-end gap-2" onclick="event.stopPropagation()">
            ${
              showCumulativeToggle && !isTierCollapsed
                ? `
              <button
                type="button"
                onclick="toggleAnywhereCumulativeMode()"
                class="text-[11px] px-2.5 py-1 rounded-xl font-bold border transition ${
                  state.anywhereCumulativeMode
                    ? 'bg-slate-900 text-white border-slate-900'
                    : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
                }"
              >
                ${
                  state.anywhereCumulativeMode
                    ? `✓ 1~${tierObj.rankEnd}위 누적 중`
                    : `1~${tierObj.rankEnd}위 누적 보기`
                }
              </button>
            `
                : `<span class="text-[11px] text-slate-500 sm:hidden">${tierObj.description}</span>`
            }
            <button
              type="button"
              onclick="toggleTierGroupCollapse('${tierKey}')"
              class="text-xs px-2.5 py-1 rounded-lg font-bold border transition shrink-0 ${
                isTierCollapsed
                  ? 'bg-sky-600 text-white border-sky-600'
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
              }"
            >
              ${isTierCollapsed ? '목록 펼치기 ▼' : '목록 접기 ▲'}
            </button>
          </div>
        </div>

        <!-- 티어 그룹 본문 카드 그리드 -->
        <div class="${isTierCollapsed ? 'hidden' : 'p-3 sm:p-4'}">
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 sm:gap-3.5">
            ${
              itemsToRender.length
                ? itemsToRender.map((deal) => renderAnywhereDealCardHtml(deal, theme.cardBadge)).join('')
                : '<div class="col-span-full text-center py-6 text-xs text-slate-500">이 순위 구간에 해당하는 노선이 없습니다.</div>'
            }
          </div>
        </div>
      </div>
    `;
  };

  const themes = {
    TOP10: {
      border: 'border-sky-200',
      bg: 'bg-sky-50/30',
      divider: 'border-sky-200/70',
      badge: 'bg-sky-600 text-white',
      priceText: 'text-sky-700',
      cardBadge: 'bg-sky-100 text-sky-800'
    },
    TOP20: {
      border: 'border-indigo-200',
      bg: 'bg-indigo-50/30',
      divider: 'border-indigo-200/70',
      badge: 'bg-indigo-600 text-white',
      priceText: 'text-indigo-700',
      cardBadge: 'bg-indigo-100 text-indigo-800'
    },
    TOP30: {
      border: 'border-emerald-200',
      bg: 'bg-emerald-50/30',
      divider: 'border-emerald-200/70',
      badge: 'bg-emerald-600 text-white',
      priceText: 'text-emerald-700',
      cardBadge: 'bg-emerald-100 text-emerald-800'
    }
  };

  if (activeTier === 'TOP10') {
    gridEl.innerHTML = buildTierSectionHtml('TOP10', top10, themes.TOP10, false);
  } else if (activeTier === 'TOP20') {
    gridEl.innerHTML = buildTierSectionHtml('TOP20', top20, themes.TOP20, true);
  } else if (activeTier === 'TOP30') {
    gridEl.innerHTML = buildTierSectionHtml('TOP30', top30, themes.TOP30, true);
  } else {
    gridEl.innerHTML = [
      buildTierSectionHtml('TOP10', top10, themes.TOP10, false),
      buildTierSectionHtml('TOP20', top20, themes.TOP20, false),
      buildTierSectionHtml('TOP30', top30, themes.TOP30, false)
    ].join('');
  }
}

function applyAnywhereDealToForm(originCode, destCode, depDate, retDate, priceKrw) {
  // 실제 최저가가 나온 한국 출발 공항(예: 전국통합 스캔 → PUS)을 폼에도 그대로 반영해야
  // 이후 표시되는 가격·예약 링크가 카드 내용과 일치함
  const originSelect = document.getElementById('inputOrigin');
  if (originSelect && originCode && [...originSelect.options].some((o) => o.value === originCode)) {
    originSelect.value = originCode;
  }
  document.getElementById('destQuickFilter').value = '';
  renderDestinationOptions(destCode);
  document.getElementById('inputDepDate').value = depDate;
  document.getElementById('inputRetDate').value = retDate;
  document.getElementById('inputTargetPrice').value = priceKrw;
  renderBenchmark2YPanel();
  updatePassengerTotalPreview();
  loadReturnDateMatrix();
  loadScheduleRecommendations();
  syncPriceChartToForm();
  showToast(`${originCode} ↔ ${destCode} 노선(${depDate} ~ ${retDate})이 상단 폼에 적용되었습니다!`, '🌎');
}

/**
 * 하나의 출발일 지정 시 돌아오는 일정별(1박 2일 ~ 10박 11일) 가격 매트릭스
 */
async function loadReturnDateMatrix() {
  const origin = document.getElementById('inputOrigin')?.value || 'ALL_KOREA';
  const destination = document.getElementById('inputDestination')?.value || 'NRT';
  const departureDate = document.getElementById('inputDepDate')?.value;
  const directOnly = document.getElementById('inputDirectOnly')?.checked ?? true;
  const { adults, children, infants } = getFormPassengers();

  const params = new URLSearchParams({
    origin,
    destination,
    departureDate,
    adults: String(adults),
    children: String(children),
    infants: String(infants),
    directOnly: String(directOnly),
    maxStayDays: '10'
  });

  const seq = ++returnMatrixRequestSeq;
  const data = await loadFareFeature('return-date-matrix', params, () => apiFetch(`/api/return-date-matrix?${params.toString()}`));
  if (seq !== returnMatrixRequestSeq) return;
  state.returnMatrixData = data;
  renderReturnDateMatrix();
}

// 실제 검색가로 가는 편(또는 오는 편)을 못 찾았을 때의 안내
function renderEmptyReturnMatrix(data, headerEl, gridEl) {
  headerEl.innerHTML = `
    <div class="text-xs sm:text-sm text-slate-700">
      🛫 <b>${escapeHtml(data.departureDate)}(${escapeHtml(data.departureDayOfWeekKo)})</b>
      ${escapeHtml(data.originCity)} → ${escapeHtml(data.destinationCity)}(${escapeHtml(data.destination)}) 가는 편은 최근 검색가가 없습니다.
      다른 출발일을 고르거나 '가격 추이' 차트에서 값이 있는 날을 찾아보세요.
    </div>
  `;
  gridEl.innerHTML = '';
}

function renderReturnDateMatrix() {
  const data = state.returnMatrixData;
  if (!data) return;
  setFareSourceLine('matrixFareSourceLine', data);
  const headerEl = document.getElementById('outboundFixedHeader');
  const gridEl = document.getElementById('returnMatrixGrid');
  if (!data.outboundLeg) {
    if (data.realFare) renderEmptyReturnMatrix(data, headerEl, gridEl);
    return;
  }

  const currentReturnInput = document.getElementById('inputRetDate')?.value;
  const out = data.outboundLeg;
  const best = data.cheapestOption;
  const outAirline = escapeHtml(out.airline);

  headerEl.innerHTML = `
    <div class="flex flex-wrap items-center gap-2 text-xs sm:text-sm">
      <span class="px-2.5 py-1 rounded-lg bg-sky-600 text-white font-bold text-xs">
        🛫 지정된 가는 날 (${data.departureDate} ${data.departureDayOfWeekKo}요일)
      </span>
      <span class="font-extrabold text-slate-900">
        ${escapeHtml(data.originCity)}(${escapeHtml(data.origin)}) → ${escapeHtml(data.destinationCity)}(${escapeHtml(data.destination)})
      </span>
      <span class="text-slate-600">
        최저가 가는편: <b class="text-sky-700">${outAirline} (${escapeHtml(out.flightNumber)})</b> · ${escapeHtml(out.scheduleTime)} · <b>편도 ${formatKrw(out.oneWayPriceKrw)}</b>${fareChipHtml(data.fareSource)}
      </span>
      ${fareSourceLinkHtml(out, '가는 편 가격 출처 ↗')}
      <a
        href="${out.naverOneWayUrl || '#'}"
        target="_blank"
        rel="noopener noreferrer"
        class="text-xs px-2.5 py-1 rounded-lg bg-white border border-sky-300 text-sky-700 hover:bg-sky-100 font-bold transition"
      >
        가는편 네이버 예약 ↗
      </a>
      <a
        href="${out.officialBookingUrl || '#'}"
        target="_blank"
        rel="noopener noreferrer"
        class="text-xs px-2.5 py-1 rounded-lg bg-white border border-slate-300 text-slate-700 hover:bg-slate-100 font-semibold transition"
      >
        ${outAirline} 공식 ↗
      </a>
    </div>
    <div class="text-xs font-bold text-emerald-700 bg-white px-3 py-1.5 rounded-xl border border-emerald-200">
      👑 가장 저렴한 귀국일: ${best ? `${best.returnDate}(${best.returnDayOfWeekKo}) [${best.stayLabel}] · 합산 ${formatKrw(best.combinedAdultPriceKrw)}` : '-'}
    </div>
  `;

  if (data.returnOptions.length === 0) {
    gridEl.innerHTML = `
      <div class="col-span-full text-center py-8 px-4 text-slate-500 text-sm border border-dashed border-slate-200 rounded-2xl">
        1박~10박 귀국일 가운데 오는 편 최근 검색가가 있는 날이 없습니다. 다른 출발일을 골라 보세요.
      </div>
    `;
    return;
  }
  const maxPrice = Math.max(...data.returnOptions.map((o) => o.combinedAdultPriceKrw));
  const minPrice = Math.min(...data.returnOptions.map((o) => o.combinedAdultPriceKrw));

  gridEl.innerHTML = data.returnOptions
    .map((opt) => {
      const isSelected = opt.returnDate === currentReturnInput;
      const isCheapest = opt.isCheapestReturn;
      const barRatio =
        maxPrice > minPrice
          ? 35 + Math.round(((opt.combinedAdultPriceKrw - minPrice) / (maxPrice - minPrice)) * 65)
          : 60;

      let badgeHtml = '';
      if (isCheapest) {
        badgeHtml = `<span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-emerald-600 text-white">👑 최저가 귀국일</span>`;
      } else if (opt.priceGrade === 'GREAT_DEAL' || opt.priceGrade === 'HISTORIC_LOW') {
        badgeHtml = `<span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-sky-100 text-sky-800">추천 특가</span>`;
      } else if (opt.discountVs2YAvgPercent > 0) {
        badgeHtml = `<span class="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">2년평균 -${opt.discountVs2YAvgPercent}%</span>`;
      } else if (Number.isFinite(opt.discountVs2YAvgPercent)) {
        // 실제 검색가(2년 기준 없음)에는 붙이지 않는다
        badgeHtml = `<span class="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">주말/성수기</span>`;
      }

      // 전국 통합 실제 운임은 귀국일마다 한국 공항(가는 편)이 다를 수 있어, 맨 위와 다르면 그 칸에 가는 편을 따로 보여 준다
      const optOut = opt.outboundLeg;
      const outLineHtml =
        optOut && opt.origin !== data.origin
          ? `<div class="text-[11px] text-sky-700 mt-0.5 truncate">가는편: ${escapeHtml(opt.originCity)}(${escapeHtml(opt.origin)}) 출발 <b>${escapeHtml(optOut.airline)}</b> (${formatKrw(optOut.oneWayPriceKrw)})</div>`
          : '';
      const links = opt.bookingLinks || {};
      const inNaverUrl = links.inboundNaverUrl || opt.inboundLeg?.naverOneWayUrl || '#';
      const inOfficialUrl = links.inboundAirlineOfficialUrl || opt.inboundLeg?.officialBookingUrl || '#';
      const inAirline = escapeHtml(opt.inboundLeg.airline);

      return `
        <div
          onclick="selectReturnDateFromMatrix('${opt.returnDate}', ${opt.combinedAdultPriceKrw})"
          class="cursor-pointer rounded-2xl p-3.5 transition border flex flex-col justify-between ${
            isCheapest
              ? 'border-emerald-500 bg-emerald-50/40 ring-2 ring-emerald-500/20'
              : isSelected
              ? 'border-sky-500 bg-sky-50/30 ring-2 ring-sky-500/20'
              : 'border-slate-200 hover:border-slate-400 bg-white'
          }"
        >
          <div>
            <div class="flex items-center justify-between gap-1 mb-1.5">
              <span class="text-xs font-extrabold text-slate-900">${opt.stayLabel}</span>
              ${badgeHtml}
            </div>

            <div class="text-xs font-bold text-slate-700">
              🛬 ${opt.returnDate} (${opt.returnDayOfWeekKo}) 귀국
            </div>
            ${outLineHtml}
            <div class="text-[11px] text-slate-500 mt-0.5 truncate">
              오는편: <b>${inAirline}</b> (${formatKrw(opt.inboundLeg.oneWayPriceKrw)})
            </div>
            <div class="flex flex-wrap items-center gap-1.5 mt-1 text-[10px]" onclick="event.stopPropagation()">
              <a href="${inNaverUrl}" target="_blank" rel="noopener noreferrer" class="text-indigo-600 hover:underline font-bold">오는편 편도예약 ↗</a>
              <span class="text-slate-300">·</span>
              <a href="${inOfficialUrl}" target="_blank" rel="noopener noreferrer" class="text-slate-600 hover:underline font-semibold">${inAirline} 공식 ↗</a>
              ${fareSourceLinkHtml(opt.inboundLeg, '출처 ↗')}
            </div>

            <div class="mt-2 w-full bg-slate-100 h-1.5 rounded-full overflow-hidden">
              <div
                class="h-full rounded-full ${isCheapest ? 'bg-emerald-500' : 'bg-sky-500'}"
                style="width: ${barRatio}%"
              ></div>
            </div>

            <div class="mt-2 pt-2 border-t border-slate-100">
              <div class="text-[10px] text-slate-400">가는편+오는편 성인 1인 합산${fareChipHtml(data.fareSource)}</div>
              <div class="text-base font-extrabold ${isCheapest ? 'text-emerald-700' : 'text-slate-900'}">
                ${formatKrw(opt.combinedAdultPriceKrw)}
              </div>
              <div class="text-[11px] text-slate-500 font-medium">
                총 인원 합계: <b class="text-slate-700">${formatKrw(opt.totalPassengersPriceKrw)}</b>
              </div>
            </div>
          </div>

          <div class="mt-2.5 pt-2 border-t border-slate-100 space-y-1.5" onclick="event.stopPropagation()">
            ${bookingNoteHtml(data.fareSource)}
            <div class="grid grid-cols-2 gap-1">
              <a
                href="${links.naverUrl || '#'}"
                target="_blank"
                rel="noopener noreferrer"
                class="text-center text-[11px] py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold transition"
              >
                🟢 네이버 예약 ↗
              </a>
              <a
                href="${links.skyscannerUrl || '#'}"
                target="_blank"
                rel="noopener noreferrer"
                class="text-center text-[11px] py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-bold transition"
              >
                🔵 스카이스캐너 ↗
              </a>
            </div>
            <div class="flex items-center gap-1">
              <button
                onclick="selectReturnDateFromMatrix('${opt.returnDate}', ${opt.combinedAdultPriceKrw})"
                class="flex-1 text-[11px] py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold transition"
              >
                일정 선택
              </button>
              <button
                onclick="quickAddDealToWatchlist('${opt.origin || data.origin}', '${data.destination}', '${data.departureDate}', '${opt.returnDate}', ${opt.combinedAdultPriceKrw})"
                class="flex-1 text-[11px] py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white font-bold transition"
              >
                + 알림 등록
              </button>
            </div>
          </div>
        </div>
      `;
    })
    .join('');
}

function selectReturnDateFromMatrix(returnDate, suggestedTargetKrw) {
  document.getElementById('inputRetDate').value = returnDate;
  document.getElementById('inputTargetPrice').value = suggestedTargetKrw;
  updatePassengerTotalPreview();
  renderReturnDateMatrix();
  syncPriceChartToForm();
  showToast(`귀국일이 ${returnDate}로 선택되었습니다! (편도합산 최저가: ${formatKrw(suggestedTargetKrw)})`, '🗓️');
}

/**
 * 선택 도시 향후 60일 내 가장 저렴한 추천 일정 Top 6
 */
async function loadScheduleRecommendations() {
  const origin = document.getElementById('inputOrigin')?.value || 'ALL_KOREA';
  const destination = document.getElementById('inputDestination')?.value || 'NRT';
  const stayRange = (document.getElementById('selectRecommendStay')?.value || '3-5').split('-');
  const minNights = Number(stayRange[0]) || 3;
  const maxNights = Number(stayRange[1]) || 5;
  const directOnly = document.getElementById('inputDirectOnly')?.checked ?? true;
  const { adults, children, infants } = getFormPassengers();

  const params = new URLSearchParams({
    origin,
    destination,
    minNights: String(minNights),
    maxNights: String(maxNights),
    adults: String(adults),
    children: String(children),
    infants: String(infants),
    directOnly: String(directOnly)
  });

  const seq = ++scheduleRecommendRequestSeq;
  const data = await loadFareFeature('schedule-recommendations', params, () =>
    apiFetch(`/api/schedule-recommendations?${params.toString()}`)
  );
  if (seq !== scheduleRecommendRequestSeq) return;
  state.scheduleRecommendData = data;
  renderScheduleRecommendations();
}

function renderScheduleRecommendations() {
  const data = state.scheduleRecommendData;
  const container = document.getElementById('recommendedSchedulesGrid');
  if (!data || !data.recommendations) return;
  setFareSourceLine('recommendFareSourceLine', data);

  if (data.recommendations.length === 0) {
    container.innerHTML = `
      <div class="col-span-full text-center py-8 px-4 text-slate-500 text-sm border border-dashed border-slate-200 rounded-2xl">
        향후 60일 안에 가는 편·오는 편 ${data.realFare ? '최근 검색가가 모두 있는' : '가격이 모두 있는'} 일정을 찾지 못했습니다. 체류 기간을 바꾸거나 '직항만'을 해제해 보세요.
      </div>
    `;
    return;
  }

  container.innerHTML = data.recommendations
    .map((rec, idx) => {
      const rankBadge =
        idx === 0
          ? `<span class="text-xs font-extrabold px-2.5 py-0.5 rounded-full bg-emerald-600 text-white">🥇 향후 60일 최저가 1위</span>`
          : `<span class="text-xs font-bold px-2 py-0.5 rounded-full bg-slate-200 text-slate-700">추천 #${idx + 1}</span>`;

      const links = rec.bookingLinks || {};
      const outNaverUrl = links.outboundNaverUrl || rec.outboundLeg?.naverOneWayUrl || '#';
      const inNaverUrl = links.inboundNaverUrl || rec.inboundLeg?.naverOneWayUrl || '#';
      const outOfficialUrl = links.outboundAirlineOfficialUrl || rec.outboundLeg?.officialBookingUrl || '#';
      const inOfficialUrl = links.inboundAirlineOfficialUrl || rec.inboundLeg?.officialBookingUrl || '#';
      const outAirline = escapeHtml(rec.outboundLeg.airline);
      const inAirline = escapeHtml(rec.inboundLeg.airline);
      // 실제 검색가에는 2년 기준값이 없어 할인율 대신 출처를 보여 준다
      const discountBadgeHtml = Number.isFinite(rec.discountVs2YAvgPercent)
        ? `<span class="text-xs font-bold text-rose-600 bg-rose-50 px-2 py-0.5 rounded-md border border-rose-200">2년 평균 대비 -${rec.discountVs2YAvgPercent}%</span>`
        : '<span class="text-xs font-bold text-sky-700 bg-sky-50 px-2 py-0.5 rounded-md border border-sky-200">📡 최근 검색가</span>';

      return `
        <div class="rounded-2xl border ${
          idx === 0 ? 'border-emerald-500 bg-emerald-50/30' : 'border-slate-200 bg-white'
        } p-4 flex flex-col justify-between shadow-sm">
          <div class="space-y-2">
            <div class="flex items-center justify-between gap-1">
              <div class="flex items-center gap-1.5">
                ${rankBadge}
                <span class="text-[11px] font-extrabold px-2 py-0.5 rounded-md bg-indigo-50 text-indigo-700 border border-indigo-200">
                  🛫 ${rec.originCity || '인천'}(${rec.origin}) 출발
                </span>
              </div>
              ${discountBadgeHtml}
            </div>

            <div class="text-sm font-extrabold text-slate-900">
              📅 ${rec.departureDate}(${rec.departureDayOfWeekKo}) ~ ${rec.returnDate}(${rec.returnDayOfWeekKo}) · ${rec.stayLabel}
            </div>

            <div class="bg-slate-50 rounded-xl p-2.5 border border-slate-200/70 space-y-1.5 text-xs">
              <div>
                <div class="flex items-center justify-between">
                  <span class="text-slate-500">🛫 가는편 편도 (${rec.origin}→${rec.destination})</span>
                  <span class="font-bold text-slate-800">${outAirline} (${escapeHtml(rec.outboundLeg.flightNumber)}) · ${formatKrw(rec.outboundLeg.oneWayPriceKrw)}</span>
                </div>
                <div class="flex items-center justify-end gap-2 mt-0.5 text-[11px]">
                  <a href="${outNaverUrl}" target="_blank" rel="noopener noreferrer" class="text-sky-600 hover:underline font-bold">네이버 편도예약 ↗</a>
                  <span class="text-slate-300">·</span>
                  <a href="${outOfficialUrl}" target="_blank" rel="noopener noreferrer" class="text-slate-600 hover:underline font-semibold">${outAirline} 공식 ↗</a>
                  ${fareSourceLinkHtml(rec.outboundLeg, '출처 ↗')}
                </div>
              </div>
              <div class="border-t border-slate-200/60 pt-1">
                <div class="flex items-center justify-between">
                  <span class="text-slate-500">🛬 오는편 편도 (${rec.destination}→${rec.origin})</span>
                  <span class="font-bold text-slate-800">${inAirline} (${escapeHtml(rec.inboundLeg.flightNumber)}) · ${formatKrw(rec.inboundLeg.oneWayPriceKrw)}</span>
                </div>
                <div class="flex items-center justify-end gap-2 mt-0.5 text-[11px]">
                  <a href="${inNaverUrl}" target="_blank" rel="noopener noreferrer" class="text-indigo-600 hover:underline font-bold">네이버 편도예약 ↗</a>
                  <span class="text-slate-300">·</span>
                  <a href="${inOfficialUrl}" target="_blank" rel="noopener noreferrer" class="text-slate-600 hover:underline font-semibold">${inAirline} 공식 ↗</a>
                  ${fareSourceLinkHtml(rec.inboundLeg, '출처 ↗')}
                </div>
              </div>
            </div>

            <div class="pt-1 flex items-baseline justify-between">
              <div>
                <div class="text-[11px] text-slate-400">성인 1인 편도합산${fareChipHtml(data.fareSource)}</div>
                <div class="text-lg font-extrabold text-slate-900">${formatKrw(rec.combinedAdultPriceKrw)}</div>
              </div>
              <div class="text-right">
                <div class="text-[11px] text-slate-400">${rec.passengerSummaryText} 총액</div>
                <div class="text-sm font-extrabold text-sky-700">${formatKrw(rec.totalPassengersPriceKrw)}</div>
              </div>
            </div>
          </div>

          <div class="mt-3 pt-2.5 border-t border-slate-100 space-y-1.5">
            ${bookingNoteHtml(data.fareSource)}
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
              <a
                href="${links.naverUrl || '#'}"
                target="_blank"
                rel="noopener noreferrer"
                class="text-center text-[11px] py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold transition"
              >
                🟢 네이버 예약 ↗
              </a>
              <a
                href="${links.skyscannerUrl || '#'}"
                target="_blank"
                rel="noopener noreferrer"
                class="text-center text-[11px] py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-bold transition"
              >
                🔵 스카이스캐너 ↗
              </a>
              <a
                href="${links.googleFlightsUrl || '#'}"
                target="_blank"
                rel="noopener noreferrer"
                class="text-center text-[11px] py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold transition"
              >
                🌐 구글플라이트 ↗
              </a>
              <a
                href="${links.tripComUrl || '#'}"
                target="_blank"
                rel="noopener noreferrer"
                class="text-center text-[11px] py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold transition"
              >
                ✈️ 트립닷컴 ↗
              </a>
            </div>
            <div class="grid grid-cols-2 gap-2">
              <button
                onclick="applyRecommendedScheduleToForm('${rec.departureDate}', '${rec.returnDate}', ${rec.combinedAdultPriceKrw})"
                class="text-xs py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold transition"
              >
                폼에 일정 적용
              </button>
              <button
                onclick="quickAddDealToWatchlist('${rec.origin}', '${rec.destination}', '${rec.departureDate}', '${rec.returnDate}', ${rec.combinedAdultPriceKrw})"
                class="text-xs py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold transition"
              >
                + 즉시 알림 등록
              </button>
            </div>
          </div>
        </div>
      `;
    })
    .join('');
}

function applyRecommendedScheduleToForm(depDate, retDate, priceKrw) {
  document.getElementById('inputDepDate').value = depDate;
  document.getElementById('inputRetDate').value = retDate;
  document.getElementById('inputTargetPrice').value = priceKrw;
  updatePassengerTotalPreview();
  loadReturnDateMatrix();
  syncPriceChartToForm();
  showToast(`추천 일정(${depDate} ~ ${retDate})이 입력 폼에 적용되었습니다!`, '✨');
}

/**
 * 대시보드 로드 및 렌더링
 */
async function loadDashboard() {
  const res = await apiFetch('/api/dashboard');
  const data = await res.json();

  state.watchRules = data.watchRules || [];
  state.historiesByRule = data.historiesByRule || {};
  state.notificationLogs = data.notificationLogs || [];
  state.notificationLogsTotal = Number.isFinite(data.notificationLogsTotal)
    ? data.notificationLogsTotal
    : state.notificationLogs.length;
  state.apiQuotaStats = data.apiQuotaStats || {};
  state.statusSummary = data.statusSummary || {};

  // [버그 수정] 이전에는 선택된 규칙이 없으면 첫 번째 규칙(도쿄 나리타)을 자동 선택하여
  // 가격 차트가 항상 나리타만 표시되었음 → 이제 차트는 기본적으로 '현재 선택 노선(폼)'을 따름
  if (state.selectedRuleId && !state.watchRules.some((r) => r.id === state.selectedRuleId)) {
    state.selectedRuleId = null;
  }
  const chartModeIsRule = state.chartRouteMode && state.chartRouteMode !== 'FORM';
  // 차트가 보여 주던 알림 규칙이 삭제됐으면 '현재 선택 노선'으로 돌아가 그 노선을 다시 불러와야 한다
  const chartRuleRemoved = chartModeIsRule && !state.watchRules.some((r) => r.id === state.chartRouteMode);
  if (chartRuleRemoved) {
    state.chartRouteMode = 'FORM';
  }

  if (state.selectedPreviewNoti && !state.notificationLogs.some((n) => n.id === state.selectedPreviewNoti.id)) {
    state.selectedPreviewNoti = null;
  }
  if (state.notificationLogs.length > 0 && !state.selectedPreviewNoti) {
    state.selectedPreviewNoti = state.notificationLogs[0];
  }

  renderStatusAndKpis();
  renderWatchRules();
  renderChartRouteSelectOptions();
  if (state.chartRouteMode !== 'FORM' || chartRuleRemoved) {
    loadRoutePriceTrend();
  } else {
    renderPriceChart();
  }
  renderKakaoPreviewAndLogs();
}

function renderStatusAndKpis() {
  const s = state.statusSummary;
  const q = state.apiQuotaStats;

  // 실제 운임 출처로 가격을 받은 규칙이 있을 때만 실제 운임이라고 표시한다
  // (실시간 = 구글 플라이트·Amadeus, 최근 검색가 = Travelpayouts · PIN 모드에서 등록·재조회한 규칙)
  const liveRuleCount = state.watchRules.filter((r) => describeFareSource(r.sourceApi) === 'LIVE').length;
  const cachedRuleCount = state.watchRules.filter((r) => describeFareSource(r.sourceApi) === 'CACHED').length;
  const realRuleParts = [
    liveRuleCount > 0 ? `실시간 ${liveRuleCount}개` : '',
    cachedRuleCount > 0 ? `최근 검색가 ${cachedRuleCount}개` : ''
  ].filter(Boolean);
  const modeLabel = realFareState.enabled ? '실제 운임 모드 ON' : '';
  const ruleLabel = realRuleParts.length ? `알림 규칙 ${realRuleParts.join(' · ')} · 그 밖은 모의 가격` : '';
  const providerLabel =
    [modeLabel, ruleLabel].filter(Boolean).join(' · ') || '모의 가격 엔진 (실제 운임 아님)';

  document.getElementById('apiStatusText').textContent = `${providerLabel} · ${
    s.hasKakaoToken ? '실제 카카오톡 발송 ON' : '카카오톡 미리보기 모드'
  }`;

  document.getElementById('kpiActiveCount').textContent = `${q.activeRulesCount || 0}개`;
  document.getElementById('kpiDedupeInfo').textContent = `고유 쿼리 ${q.uniqueWatchKeysCount || 0}개 · 중복 절약 ${
    q.deduplicatedSavedCalls || 0
  }회`;

  const targetHits = state.watchRules.filter((r) => r.isTargetReached).length;
  document.getElementById('kpiTargetHitCount').textContent = `${targetHits}개`;

  const headerBadgeKpi = document.getElementById('headerBadgeKpi');
  if (headerBadgeKpi) {
    headerBadgeKpi.textContent = `활성 ${q.activeRulesCount || 0}개 · 달성 ${targetHits}개`;
  }

  const headerBadgeWatchlist = document.getElementById('headerBadgeWatchlist');
  if (headerBadgeWatchlist) {
    headerBadgeWatchlist.textContent = `${state.watchRules.length}건 등록`;
  }

  if (state.watchRules.length > 0) {
    const sorted = [...state.watchRules].sort(
      (a, b) => (a.currentLowestPrice || 99999999) - (b.currentLowestPrice || 99999999)
    );
    const cheapest = sorted[0];
    document.getElementById('kpiLowestPrice').textContent = formatKrw(cheapest.currentLowestPrice);
    document.getElementById('kpiLowestRoute').textContent = `${cheapest.originMeta?.city} ↔ ${cheapest.destMeta?.city} (${cheapest.latestAirline})`;
  } else {
    document.getElementById('kpiLowestPrice').textContent = '-';
    document.getElementById('kpiLowestRoute').textContent = '노선을 등록해 주세요';
  }

  // 대시보드는 최근 30건만 내려주므로 전체 건수(notificationLogsTotal)를 표시
  document.getElementById('kpiNotiCount').textContent = state.notificationLogsTotal ?? state.notificationLogs.length;
  const kakaoBadge = document.getElementById('kpiKakaoBadge');
  if (s.hasKakaoToken) {
    kakaoBadge.textContent = '카톡 연동 ON';
    kakaoBadge.className = 'text-[10px] px-1.5 py-0.5 rounded font-bold bg-emerald-100 text-emerald-800 shrink-0';
  } else {
    kakaoBadge.textContent = '미리보기';
    kakaoBadge.className = 'text-[10px] px-1.5 py-0.5 rounded font-semibold kakao-yellow shrink-0';
  }
}

/**
 * 내 알림 목록 렌더링 (개별 알림 카드 상세 접기/펼치기 지원)
 */
function renderWatchRules() {
  const container = document.getElementById('watchRulesContainer');
  if (state.watchRules.length === 0) {
    container.innerHTML = `
      <div class="text-center py-10 text-slate-400 text-sm border border-dashed border-slate-200 rounded-2xl">
        등록된 항공권 알림이 없습니다. 상단 일정 탐색기에서 원하는 노선을 추가해 보세요!
      </div>
    `;
    return;
  }

  container.innerHTML = state.watchRules
    .map((rule) => {
      const isSelected = rule.id === state.selectedRuleId;
      const isReached = rule.isTargetReached;
      const isRuleDetailCollapsed = Boolean(state.collapsedRuleIds[rule.id]);
      const diffAbs = Math.abs(rule.diffFromTarget || 0);
      const pax = rule.passengerPricing || {
        passengerSummaryText: `성인 ${rule.adults || 1}명`,
        totalPassengersPriceKrw: rule.currentLowestPrice
      };
      const b2y = rule.benchmark2Y || {};

      const statusBadge = isReached
        ? `<span class="inline-flex items-center gap-1 text-xs font-bold px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-300">
             🎯 목표가 달성! (-${formatKrw(diffAbs)} 절약)
           </span>`
        : `<span class="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
             ⏳ 목표가까지 +${formatKrw(diffAbs)}
           </span>`;

      const mixMatchBadge =
        rule.mixMatchSavingsKrw > 0
          ? `<span class="text-[11px] font-bold text-indigo-700 bg-indigo-50 border border-indigo-200 px-2 py-0.5 rounded-md">
               편도 분리조합 -${formatKrw(rule.mixMatchSavingsKrw)} 절약
             </span>`
          : '';

      const outLeg = rule.outboundLeg;
      const inLeg = rule.inboundLeg;
      const fareKind = describeFareSource(rule.sourceApi);
      // 모의 2년 기준과 실제 운임을 견주면 뜻이 없으므로, 실제 운임 규칙은 조회 시각·출처를 보여 준다
      const benchmarkInfoHtml =
        fareKind === 'SIMULATED'
          ? `📊 2년 최저 <b>${formatKrw(b2y.lowest2YKrw)}</b> / 평균 <b>${formatKrw(b2y.avg2YKrw)}</b> (<b>-${rule.discountRateVsMarket}%</b>)`
          : fareKind === 'LIVE'
          ? `🕒 <b>${escapeHtml(formatDateTime(rule.fareFetchedAt || rule.lastCheckedAt))}</b> 실시간 조회 (구글 플라이트)`
          : `📡 최근 검색가 (Travelpayouts${rule.fareFetchedAt ? ` · ${escapeHtml(formatDateTime(rule.fareFetchedAt))} 수집` : ''})`;

      return `
        <div
          onclick="selectRuleForChart('${rule.id}')"
          class="cursor-pointer rounded-2xl p-3.5 sm:p-4 transition border ${
            isSelected
              ? 'border-sky-500 bg-sky-50/30 ring-2 ring-sky-500/20'
              : 'border-slate-200 hover:border-slate-300 bg-white'
          }"
        >
          <div class="flex flex-col sm:flex-row sm:items-start justify-between gap-2">
            <div class="space-y-1.5">
              <div class="flex flex-wrap items-center gap-1.5 sm:gap-2">
                <span class="text-sm sm:text-base font-extrabold text-slate-900">
                  ${escapeHtml(rule.originMeta?.city)}(${escapeHtml(rule.origin)}) ↔ ${escapeHtml(rule.destMeta?.city)}(${escapeHtml(rule.destination)})
                </span>
                <span class="text-[11px] sm:text-xs px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 font-semibold">
                  ${rule.directOnly ? '직항' : '경유포함'} · 👨‍👩‍👧‍👦 ${pax.passengerSummaryText}
                </span>
                ${statusBadge}
                ${mixMatchBadge}
              </div>

              <div class="text-xs text-slate-500 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>📅 <b>${rule.departureDate} ~ ${rule.returnDate}</b></span>
                <span>${benchmarkInfoHtml}</span>
              </div>
            </div>

            <div class="flex sm:flex-col items-baseline sm:items-end justify-between border-t sm:border-t-0 pt-2 sm:pt-0 border-slate-100 shrink-0">
              <div>
                <div class="text-[10px] sm:text-[11px] text-slate-400">성인 1인 합산 / 목표가${fareChipHtml(rule.sourceApi, rule.fareFetchedAt)}</div>
                <div class="flex sm:justify-end items-baseline gap-1.5">
                  <span class="text-lg sm:text-xl font-extrabold ${isReached ? 'text-emerald-600' : 'text-slate-900'}">
                    ${formatKrw(rule.currentLowestPrice)}
                  </span>
                  <span class="text-xs text-slate-400 font-medium">/ ${formatKrw(rule.targetPrice)}</span>
                </div>
                <div class="text-[11px] sm:text-xs font-bold text-sky-700 mt-0.5">
                  총액(${pax.passengerSummaryText}): ${formatKrw(pax.totalPassengersPriceKrw)}
                </div>
              </div>

              <button
                type="button"
                onclick="event.stopPropagation(); toggleRuleDetailCollapse('${rule.id}')"
                class="mt-1 text-[11px] px-2.5 py-1 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 text-slate-700 font-bold"
              >
                ${isRuleDetailCollapsed ? '상세·예약 펼치기 ▼' : '상세·예약 접기 ▲'}
              </button>
            </div>
          </div>

          <div class="${isRuleDetailCollapsed ? 'hidden' : ''}">
            ${
              outLeg && inLeg
                ? `
              <div class="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2.5 bg-slate-50/90 rounded-xl p-2.5 sm:p-3 border border-slate-200/80 text-xs">
                <div class="flex items-center justify-between bg-white p-2.5 rounded-lg border border-slate-200/70">
                  <div>
                    <div class="text-[11px] font-bold text-sky-700">🛫 가는편 편도 (${rule.departureDate})</div>
                    <div class="font-extrabold text-slate-900 mt-0.5">${escapeHtml(outLeg.airline)} (${escapeHtml(outLeg.flightNumber)})</div>
                    <div class="text-[11px] text-slate-500">${escapeHtml(outLeg.scheduleTime)} · ${escapeHtml(outLeg.baggageInfo)}</div>
                  </div>
                  <div class="text-right space-y-0.5">
                    <div class="text-sm font-extrabold text-slate-900">${formatKrw(outLeg.oneWayPriceKrw)}</div>
                    <div class="flex items-center justify-end gap-1.5">
                      <a href="${rule.bookingLinks?.outboundNaverUrl || outLeg.naverOneWayUrl || '#'}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" class="text-[11px] text-sky-600 hover:underline font-bold">
                        네이버 편도 ↗
                      </a>
                      <span class="text-slate-300">·</span>
                      <a href="${rule.bookingLinks?.outboundAirlineOfficialUrl || outLeg.officialBookingUrl || '#'}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" class="text-[11px] text-slate-600 hover:underline font-semibold">
                        공식 ↗
                      </a>
                    </div>
                  </div>
                </div>

                <div class="flex items-center justify-between bg-white p-2.5 rounded-lg border border-slate-200/70">
                  <div>
                    <div class="text-[11px] font-bold text-indigo-700">🛬 오는편 편도 (${rule.returnDate})</div>
                    <div class="font-extrabold text-slate-900 mt-0.5">${escapeHtml(inLeg.airline)} (${escapeHtml(inLeg.flightNumber)})</div>
                    <div class="text-[11px] text-slate-500">${escapeHtml(inLeg.scheduleTime)} · ${escapeHtml(inLeg.baggageInfo)}</div>
                  </div>
                  <div class="text-right space-y-0.5">
                    <div class="text-sm font-extrabold text-slate-900">${formatKrw(inLeg.oneWayPriceKrw)}</div>
                    <div class="flex items-center justify-end gap-1.5">
                      <a href="${rule.bookingLinks?.inboundNaverUrl || inLeg.naverOneWayUrl || '#'}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" class="text-[11px] text-indigo-600 hover:underline font-bold">
                        네이버 편도 ↗
                      </a>
                      <span class="text-slate-300">·</span>
                      <a href="${rule.bookingLinks?.inboundAirlineOfficialUrl || inLeg.officialBookingUrl || '#'}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" class="text-[11px] text-slate-600 hover:underline font-semibold">
                        공식 ↗
                      </a>
                    </div>
                  </div>
                </div>
              </div>
            `
                : ''
            }

            <div class="mt-3">${bookingNoteHtml(rule.sourceApi, rule.fareFetchedAt)}</div>
            <div class="mt-3 pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2" onclick="event.stopPropagation()">
              <div class="flex flex-wrap items-center gap-1.5">
                <button
                  onclick="handleCheckRule('${rule.id}', false)"
                  class="text-xs px-2.5 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold transition"
                >
                  🔍 재조회
                </button>
                <button
                  onclick="handleCheckRule('${rule.id}', true)"
                  class="text-xs px-2.5 py-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 font-bold transition"
                >
                  ⚡ 급락 시뮬레이션
                </button>
                <button
                  onclick="handleManualNotify('${rule.id}')"
                  class="text-xs px-2.5 py-1.5 rounded-lg kakao-yellow hover:brightness-95 font-bold transition"
                >
                  💬 카톡 발송
                </button>
              </div>

              <div class="flex flex-wrap items-center gap-1.5">
                <a
                  href="${rule.bookingLinks?.naverUrl || '#'}"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-xs px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold transition"
                >
                  🟢 네이버 예약 ↗
                </a>
                <a
                  href="${rule.bookingLinks?.skyscannerUrl || '#'}"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-xs px-2.5 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-semibold transition"
                >
                  🔵 스카이스캐너 ↗
                </a>
                <a
                  href="${rule.bookingLinks?.googleFlightsUrl || '#'}"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-xs px-2.5 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold transition"
                >
                  🌐 구글플라이트 ↗
                </a>
                <a
                  href="${rule.bookingLinks?.tripComUrl || '#'}"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-xs px-2.5 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold transition"
                >
                  ✈️ 트립닷컴 ↗
                </a>
                <button
                  onclick="handleDeleteRule('${rule.id}', event)"
                  class="text-xs px-2 py-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition"
                  title="알림 삭제"
                >
                  🗑️
                </button>
              </div>
            </div>
          </div>
        </div>
      `;
    })
    .join('');
}

// 강조된 알림 카드 = 가격 추이 차트에 보이는 노선이 되도록 둘을 함께 맞춘다
// (다음 loadDashboard() 또는 loadRoutePriceTrend() 가 그 규칙의 추이를 불러옴)
function focusRuleInChart(ruleId) {
  state.selectedRuleId = ruleId;
  state.chartRouteMode = ruleId;
}

function selectRuleForChart(ruleId) {
  focusRuleInChart(ruleId);
  renderWatchRules();
  renderChartRouteSelectOptions();
  loadRoutePriceTrend();
}

/**
 * 가격 추이 차트 대상 노선 선택 드롭다운 (현재 선택 노선 + 등록된 알림 노선들)
 */
function renderChartRouteSelectOptions() {
  const selectEl = document.getElementById('chartRouteSelect');
  if (!selectEl) return;
  const formLabel = getFormRouteLabel();
  const ruleOptions = state.watchRules
    .map((r) => {
      const label = `📋 알림: ${r.originMeta?.city || r.origin}(${r.origin}) ↔ ${r.destMeta?.city || r.destination}(${r.destination}) · ${r.departureDate}~${r.returnDate}`;
      return `<option value="${escapeHtml(r.id)}" ${state.chartRouteMode === r.id ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    })
    .join('');
  selectEl.innerHTML =
    `<option value="FORM" ${state.chartRouteMode === 'FORM' ? 'selected' : ''}>🔔 현재 선택 노선: ${escapeHtml(formLabel)}</option>` +
    ruleOptions;
}

function getFormRouteLabel() {
  const originCode = document.getElementById('inputOrigin')?.value || 'ALL_KOREA';
  const destCode = document.getElementById('inputDestination')?.value || 'NRT';
  const origin = state.origins.find((o) => o.code === originCode);
  const dest = state.destinations.find((d) => d.code === destCode);
  const originName = originCode === 'ALL_KOREA' ? '전국통합' : `${origin?.city || originCode}(${originCode})`;
  return `${originName} ↔ ${dest?.city || destCode}(${destCode})`;
}

function handleChartRouteSelectChange() {
  const val = document.getElementById('chartRouteSelect')?.value || 'FORM';
  state.chartRouteMode = val;
  state.selectedRuleId = val === 'FORM' ? null : val;
  renderWatchRules();
  loadRoutePriceTrend();
}

/**
 * 현재 차트 대상(폼 노선 또는 알림 노선)의 조회 파라미터
 */
function getChartRouteQuery() {
  const rule = state.chartRouteMode !== 'FORM' ? state.watchRules.find((r) => r.id === state.chartRouteMode) : null;
  if (rule) {
    return {
      rule,
      origin: rule.requestedOrigin || rule.origin,
      destination: rule.destination,
      departureDate: rule.departureDate,
      returnDate: rule.returnDate,
      adults: rule.adults || 1,
      children: rule.children || 0,
      infants: rule.infants || 0,
      directOnly: rule.directOnly !== false,
      targetPrice: rule.targetPrice
    };
  }
  const { adults, children, infants } = getFormPassengers();
  return {
    rule: null,
    origin: document.getElementById('inputOrigin')?.value || 'ALL_KOREA',
    destination: document.getElementById('inputDestination')?.value || 'NRT',
    departureDate: document.getElementById('inputDepDate')?.value || '',
    returnDate: document.getElementById('inputRetDate')?.value || '',
    adults,
    children,
    infants,
    directOnly: document.getElementById('inputDirectOnly')?.checked ?? true,
    targetPrice: Number(document.getElementById('inputTargetPrice')?.value || 0)
  };
}

async function loadRoutePriceTrend() {
  const q = getChartRouteQuery();
  const params = new URLSearchParams({
    origin: q.origin,
    destination: q.destination,
    departureDate: q.departureDate,
    returnDate: q.returnDate,
    adults: String(q.adults),
    children: String(q.children),
    infants: String(q.infants),
    directOnly: String(q.directOnly)
  });
  const seq = ++routeTrendRequestSeq;
  try {
    // 실제 운임 모드면 프록시(Travelpayouts 최근 검색가), 아니면 또는 실패하면 모의 가격 엔진 (realFares.js)
    const data = await loadFareFeature('route-price-trend', params, () => apiFetch(`/api/route-price-trend?${params.toString()}`));
    if (seq !== routeTrendRequestSeq) return; // 더 최신 요청이 있으면 무시 (빠른 연속 변경 시 경합 방지)
    if (data.error) throw new Error(data.error);
    // 응답을 기다리는 동안 목표가를 고쳤을 수 있으니 폼 노선이면 지금 입력된 목표가를 쓴다
    const query = q.rule ? q : { ...q, targetPrice: Number(document.getElementById('inputTargetPrice')?.value || 0) };
    state.routeTrendData = { ...data, query };
    state.routeTrendError = null;
  } catch (err) {
    if (seq !== routeTrendRequestSeq) return;
    console.error('가격 추이 조회 실패:', err);
    state.routeTrendData = null;
    state.routeTrendError = err.message || '가격 추이 조회 실패';
  }
  renderChartRouteSelectOptions();
  renderPriceChart();
}

function renderPriceChart({ animate = true } = {}) {
  const canvas = document.getElementById('priceHistoryChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  if (priceChartInstance) {
    priceChartInstance.destroy();
    priceChartInstance = null;
  }

  const data = state.routeTrendData;
  const subtitleEl = document.getElementById('chartSubtitle');
  const adviceEl = document.getElementById('chartAiAdvice');
  const headerBadge = document.getElementById('headerBadgePriceChart');

  if (!data || !Array.isArray(data.points) || data.points.length === 0) {
    if (state.routeTrendError) {
      subtitleEl.textContent = `선택한 노선의 가격 추이를 불러오지 못했습니다 (${state.routeTrendError}).`;
      adviceEl.textContent = '조회 실패';
    } else if (data?.realFare) {
      subtitleEl.textContent = '선택한 출발일 앞뒤 1주일에는 가는 편·오는 편 최근 검색가가 모두 있는 날이 없습니다. 다른 날짜나 노선을 골라 보세요.';
      adviceEl.textContent = '최근 검색가 없음';
    } else {
      subtitleEl.textContent = '선택한 노선의 가격 추이를 불러오는 중입니다...';
      adviceEl.textContent = '분석 중...';
    }
    return;
  }

  const q = data.query || getChartRouteQuery();
  const rule = q.rule ? state.watchRules.find((r) => r.id === q.rule.id) : null;

  // 2년 기준선: 2년 시세 기준표·TOP 30 카드와 같은 도착 도시 기준값 (출발 공항 계수 없음)
  const originMeta = state.origins.find((o) => o.code === q.origin) || {};
  const round1000 = (v) => Math.round((Number(v) || 0) / 1000) * 1000;
  const avg2Y = round1000(data.benchmark2Y?.avg2YKrw);
  const lowest2Y = round1000(data.benchmark2Y?.lowest2YKrw);
  const targetPrice = Number(q.targetPrice) || 0;

  const points = data.points;
  const labels = points.map((p) => `${p.departureDate.slice(5)}(${p.departureDayOfWeekKo})`);
  const selectedIdx = points.findIndex((p) => p.isSelectedDate);
  const selected = selectedIdx >= 0 ? points[selectedIdx] : null;
  const cheapest = data.cheapestPoint;

  const originName = q.origin === 'ALL_KOREA' ? `전국통합(최저가 공항 자동)` : `${originMeta.city || q.origin}(${q.origin})`;
  const routeText = `${originName} ↔ ${data.destinationCity}(${data.destination})`;
  if (headerBadge) {
    headerBadge.textContent = `${rule ? '알림' : '선택'} · ${data.destinationCity}`;
  }
  const historyCount = rule ? (state.historiesByRule[rule.id] || []).length : 0;
  subtitleEl.innerHTML = `
    <b>${escapeHtml(routeText)}</b> · ${data.stayNights}박 ${data.stayNights + 1}일 기준 출발일별 편도합산 가격${fareChipHtml(data.fareSource)}
    ${rule ? `<span class="text-slate-400">(등록 알림 · 조회 기록 ${historyCount}건 · 현재 ${formatKrw(rule.currentLowestPrice)})</span>` : '<span class="text-slate-400">(노선·인원 설정 기준)</span>'}
    ${data.realFare ? '<span class="text-slate-400">· 최근 검색가가 있는 출발일만 표시</span>' : ''}
    ${data.realFareFallback ? `<span class="text-amber-700 font-semibold">· 실제 운임 조회 실패(${escapeHtml(data.realFareFallback)}) → 모의 가격</span>` : ''}
  `;

  const refPrice = selected ? selected.combinedAdultPriceKrw : cheapest?.combinedAdultPriceKrw || 0;
  if (targetPrice > 0 && refPrice <= targetPrice) {
    adviceEl.className = 'text-xs font-bold px-3 py-1.5 rounded-xl bg-emerald-100 text-emerald-800 border border-emerald-300 shrink-0';
    adviceEl.textContent = `✅ 매수 적기! 선택일 ${formatKrw(refPrice)} ≤ 목표가 ${formatKrw(targetPrice)}`;
  } else if (cheapest) {
    adviceEl.className = 'text-xs font-semibold px-3 py-1.5 rounded-xl bg-amber-50 text-amber-800 border border-amber-200 shrink-0';
    adviceEl.textContent = `💡 최저 출발일 ${cheapest.departureDate.slice(5)}(${cheapest.departureDayOfWeekKo}) ${formatKrw(cheapest.combinedAdultPriceKrw)}`;
  }

  const pointRadii = points.map((_, i) => (i === selectedIdx ? 6 : 3));

  // Chart.js(CDN)를 못 불러와도 위의 노선 제목·매수 조언은 보이도록 그래프만 건너뜀
  if (typeof Chart === 'undefined') {
    hideEmptyChartBox(canvas);
    return;
  }

  priceChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: '편도합산 최저가 (성인 1인)',
          data: points.map((p) => p.combinedAdultPriceKrw),
          borderColor: '#1e293b',
          backgroundColor: 'rgba(30, 41, 59, 0.07)',
          borderWidth: 2.5,
          pointRadius: pointRadii,
          pointBackgroundColor: points.map((_, i) => (i === selectedIdx ? '#f59e0b' : '#1e293b')),
          fill: true,
          tension: 0.3
        },
        {
          // 가는 편/오는 편 색은 2년 월별·요일별 차트와 같은 파랑/주황 (밝은 면용 단계)
          label: '🛫 가는편 편도',
          data: points.map((p) => p.outboundPriceKrw),
          borderColor: '#2a78d6',
          borderWidth: 2,
          pointRadius: 2,
          fill: false,
          tension: 0.3
        },
        {
          label: '🛬 오는편 편도',
          data: points.map((p) => p.inboundPriceKrw),
          borderColor: '#eb6834',
          borderWidth: 2,
          pointRadius: 2,
          fill: false,
          tension: 0.3
        },
        {
          label: '내 희망 목표가',
          data: points.map(() => targetPrice || null),
          borderColor: '#10b981',
          borderWidth: 2,
          borderDash: [6, 6],
          pointRadius: 0,
          fill: false
        },
        // 2년 기준선은 모의 시세에만 있다 (실제 검색가 응답은 benchmark2Y 가 null → 0원 선을 그리지 않음)
        ...(data.benchmark2Y
          ? [
              {
                label: '2년 평균 (왕복)',
                data: points.map(() => avg2Y),
                borderColor: '#94a3b8',
                borderWidth: 1.5,
                borderDash: [3, 3],
                pointRadius: 0,
                fill: false
              },
              {
                label: '2년 최저가',
                data: points.map(() => lowest2Y),
                borderColor: '#f43f5e',
                borderWidth: 1.5,
                borderDash: [2, 4],
                pointRadius: 0,
                fill: false
              }
            ]
          : [])
      ]
    },
    options: {
      // 목표가를 입력하는 동안 다시 그릴 때는 애니메이션 없이 바로 표시
      animation: animate ? undefined : false,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'top',
          labels: { boxWidth: 12, font: { family: 'Pretendard', size: 10 } }
        },
        tooltip: {
          callbacks: {
            title: (items) => {
              const p = points[items[0].dataIndex];
              return `출발 ${p.departureDate}(${p.departureDayOfWeekKo}) → 귀국 ${p.returnDate}(${p.returnDayOfWeekKo}) · ${p.origin} 출발`;
            },
            label: (context) => `${context.dataset.label}: ${formatKrw(context.parsed.y)}`,
            afterBody: (items) => {
              const p = points[items[0].dataIndex];
              return [`가는편 ${p.outboundAirline} / 오는편 ${p.inboundAirline}`];
            }
          }
        }
      },
      scales: {
        y: {
          ticks: {
            callback: (val) => `${Math.round(val / 10000)}만 원`
          }
        }
      }
    }
  });
}

function renderKakaoPreviewAndLogs() {
  const previewContainer = document.getElementById('kakaoPreviewCard');
  const logsContainer = document.getElementById('notificationLogsContainer');

  const noti = state.selectedPreviewNoti || state.notificationLogs[0];

  if (!noti) {
    previewContainer.innerHTML = `
      <div class="p-6 text-center text-xs text-slate-400">
        아직 발송된 알림이 없습니다. 노선 카드에서 <b>[💬 카톡 알림 보내기]</b> 버튼을 눌러보세요!
      </div>
    `;
  } else {
    const savedBadge =
      noti.savedAmount > 0
        ? `<span class="text-emerald-600 font-extrabold">목표가 대비 -${formatKrw(noti.savedAmount)} 절약!</span>`
        : `<span class="text-sky-600 font-bold">편도조합 최저가 리포트</span>`;
    // 가격 출처: 모의 / 최근 검색가(Travelpayouts) / 실시간(구글 플라이트)
    // fareKind 가 없는 옛 이력은 isSimulatedPrice 로 판단한다 (그 전 이력은 실제 운임 연결이 없던 때라 모의 가격)
    const fareKind = ['SIMULATED', 'CACHED', 'LIVE'].includes(noti.fareKind)
      ? noti.fareKind
      : noti.isSimulatedPrice === false
      ? 'LIVE'
      : 'SIMULATED';
    const notiWording = {
      SIMULATED: { tag: ' · 모의 가격', headline: '모의 최저가', chip: SIMULATED_FARE_CHIP_HTML },
      CACHED: { tag: ' · 최근 검색가', headline: '최근 검색 최저가', chip: CACHED_FARE_CHIP_HTML },
      LIVE: { tag: '', headline: '최저가 발견', chip: '' }
    }[fareKind];

    const totalPaxPrice = noti.totalPassengersPriceKrw || noti.notifiedPrice;
    const paxLabel = noti.passengerSummaryText || '성인 1명';

    previewContainer.innerHTML = `
      <div class="relative">
        <div class="h-28 bg-gradient-to-r from-sky-600 to-indigo-700 p-3.5 flex flex-col justify-between text-white">
          <div class="flex items-center justify-between">
            <span class="text-[11px] font-bold bg-black/25 px-2 py-0.5 rounded-full">SkyBell KR · 편도조합 알림${notiWording.tag}</span>
            <span class="text-[11px] opacity-80">${formatDateTime(noti.sentAt)}</span>
          </div>
          <div>
            <div class="text-xs opacity-90">✈️ 출국·귀국 편도합산 ${notiWording.headline}</div>
            <div class="text-sm font-extrabold truncate">${escapeHtml(noti.routeSummary)}</div>
          </div>
        </div>

        <div class="p-3.5 space-y-2.5 text-xs">
          <div class="space-y-1.5 border-b border-slate-100 pb-2.5">
            <div class="flex justify-between gap-2">
              <span class="text-slate-400 shrink-0">일정 · 인원</span>
              <span class="font-semibold text-slate-700 text-right">${escapeHtml(noti.scheduleSummary)}</span>
            </div>
            <div class="flex justify-between gap-2">
              <span class="text-slate-400 shrink-0">편도 조합</span>
              <span class="font-semibold text-slate-800 text-right">${escapeHtml(noti.airline)}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-slate-400">성인 1인 합산${notiWording.chip}</span>
              <span class="text-sm font-extrabold text-rose-600">${formatKrw(noti.notifiedPrice)}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-slate-400">총액 (${paxLabel})</span>
              <span class="font-extrabold text-sky-700">${formatKrw(totalPaxPrice)}</span>
            </div>
          </div>

          <div class="text-center py-1 bg-slate-50 rounded-lg">
            ${savedBadge}
          </div>

          <div class="space-y-1.5 pt-1">
            <a
              href="${noti.bookingUrl || noti.outboundBookingUrl || '#'}"
              target="_blank"
              rel="noopener noreferrer"
              class="block text-center py-2 rounded-lg kakao-yellow hover:brightness-95 font-extrabold transition text-[11px]"
            >
              🟢 네이버 왕복·통합 바로 예약 ↗
            </a>
            <div class="grid grid-cols-2 gap-1.5">
              <a
                href="${noti.outboundBookingUrl || noti.bookingUrl || '#'}"
                target="_blank"
                rel="noopener noreferrer"
                class="block text-center py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold transition text-[11px]"
              >
                🛫 가는편 편도 예약 ↗
              </a>
              <a
                href="${noti.inboundBookingUrl || noti.bookingUrl || '#'}"
                target="_blank"
                rel="noopener noreferrer"
                class="block text-center py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold transition text-[11px]"
              >
                🛬 오는편 편도 예약 ↗
              </a>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  const totalLogs = state.notificationLogsTotal ?? state.notificationLogs.length;
  const headerBadgeKakao = document.getElementById('headerBadgeKakao');
  if (headerBadgeKakao) {
    headerBadgeKakao.textContent = `${totalLogs}건`;
  }
  const clearAllBtn = document.getElementById('btnClearAllNotifications');
  if (clearAllBtn) {
    clearAllBtn.disabled = totalLogs === 0;
    clearAllBtn.classList.toggle('opacity-40', totalLogs === 0);
  }

  if (state.notificationLogs.length === 0) {
    logsContainer.innerHTML = `<div class="text-xs text-slate-400 text-center py-4">발송 이력이 없습니다.</div>`;
    return;
  }

  logsContainer.innerHTML = state.notificationLogs
    .map((item) => {
      const isActualKakao = item.status === 'KAKAO_SENT';
      return `
        <div
          onclick="selectPreviewNotification('${item.id}')"
          class="cursor-pointer p-2.5 rounded-xl border transition text-xs ${
            noti && noti.id === item.id
              ? 'border-amber-400 bg-amber-50/40'
              : 'border-slate-200 hover:bg-slate-50'
          }"
        >
          <div class="flex items-center justify-between gap-1.5">
            <span class="font-bold text-slate-800 truncate">${escapeHtml(item.routeSummary)}</span>
            <div class="flex items-center gap-1 shrink-0">
              <span class="text-[10px] px-1.5 py-0.5 rounded font-semibold ${
                isActualKakao ? 'bg-emerald-100 text-emerald-700' : 'kakao-yellow'
              }">
                ${isActualKakao ? '실제 카톡 전송됨' : '카드 프리뷰'}
              </span>
              <button
                type="button"
                onclick="event.stopPropagation(); handleDeleteNotificationLog('${item.id}', event)"
                class="text-[11px] leading-none px-1.5 py-1 rounded-md text-rose-600 hover:bg-rose-50 border border-transparent hover:border-rose-200 transition"
                title="이 알림 이력 삭제"
                aria-label="이 알림 이력 삭제"
              >
                🗑️
              </button>
            </div>
          </div>
          <div class="flex items-center justify-between text-slate-500 mt-1">
            <span>1인 합산 <b class="text-slate-800">${formatKrw(item.notifiedPrice)}</b></span>
            <span>${formatDateTime(item.sentAt)}</span>
          </div>
        </div>
      `;
    })
    .join('');
}

function selectPreviewNotification(notiId) {
  const found = state.notificationLogs.find((n) => n.id === notiId);
  if (found) {
    state.selectedPreviewNoti = found;
    renderKakaoPreviewAndLogs();
  }
}

/**
 * 더블클릭의 두 번째 클릭인지 확인한다. 첫 클릭으로 목록이 다시 그려지면 두 번째 클릭은 그 자리로 올라온
 * 다음 줄의 🗑️ 를 누르게 되므로 삭제 버튼은 이를 무시한다. 키보드(Enter·Space)로 누르면 detail 이 0 이라 영향 없음.
 */
function isRepeatClick(clickEvent) {
  return Boolean(clickEvent) && clickEvent.detail > 1;
}

/**
 * 카카오톡 특가 알림 이력 삭제 (한 건 / 전체)
 */
const pendingNotificationDeletes = new Set();

async function handleDeleteNotificationLog(notiId, clickEvent) {
  if (isRepeatClick(clickEvent)) return;
  // 같은 이력의 🗑️ 을 빠르게 두 번 눌러도 삭제 요청은 한 번만 보낸다
  if (pendingNotificationDeletes.has(notiId)) return;
  pendingNotificationDeletes.add(notiId);
  try {
    const res = await apiFetch(`/api/notifications/${encodeURIComponent(notiId)}`, { method: 'DELETE' });
    const data = await res.json();
    // 다른 탭 등에서 이미 지워진 이력(404)이면 목록이 낡은 것이므로 다시 불러오기만 한다
    const alreadyGone = res.status === 404;
    if (!res.ok && !alreadyGone) throw new Error(data.error || '알림 이력 삭제 실패');
    if (state.selectedPreviewNoti && state.selectedPreviewNoti.id === notiId) {
      state.selectedPreviewNoti = null;
    }
    if (alreadyGone) {
      showToast('이미 삭제된 알림 이력입니다. 목록을 새로 고쳤습니다.', 'ℹ️');
    } else {
      showToast('카카오톡 알림 이력 1건을 삭제했습니다.', '🗑️');
    }
    await loadDashboard();
  } catch (err) {
    showToast(err.message, '⚠️');
  } finally {
    pendingNotificationDeletes.delete(notiId);
  }
}

async function handleClearAllNotificationLogs() {
  const total = state.notificationLogsTotal ?? state.notificationLogs.length;
  if (total === 0) {
    showToast('삭제할 카카오톡 알림 이력이 없습니다.', 'ℹ️');
    return;
  }
  if (!window.confirm(`카카오톡 특가 알림 이력 ${total}건을 모두 삭제할까요?`)) return;
  try {
    const res = await apiFetch('/api/notifications', { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '알림 이력 전체 삭제 실패');
    state.selectedPreviewNoti = null;
    showToast(`카카오톡 알림 이력 ${data.deletedCount}건을 모두 삭제했습니다.`, '🗑️');
    await loadDashboard();
  } catch (err) {
    showToast(err.message, '⚠️');
  }
}

// 서버가 실제 운임 후보를 쓸 수 없다고 답한(422) 이유
const REAL_FARE_REJECT_REASONS = {
  NO_REAL_FARES: '가는 편·오는 편이 같은 공항으로 모두 있는 실제 운임이 없음',
  BAD_FARE_SOURCE: '알 수 없는 운임 출처'
};

/**
 * 알림 등록 요청: 실제 운임 후보를 서버가 쓸 수 없다고 하면(422) 모의 가격으로 다시 등록하고 그 이유를 돌려준다
 * 반환: { res, data, fallbackReason }
 */
async function postRuleWithRealFare(ruleBody, realFare) {
  const post = async (externalCandidates) => {
    const res = await apiFetch('/api/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...ruleBody, externalCandidates })
    });
    return { res, data: await res.json() };
  };
  const first = await post(realFare.externalCandidates);
  if (first.res.status === 422 && realFare.externalCandidates) {
    const retry = await post(null);
    const reason = REAL_FARE_REJECT_REASONS[first.data?.code] || first.data?.error || '실제 운임 후보를 쓸 수 없음';
    return { ...retry, fallbackReason: reason };
  }
  return { ...first, fallbackReason: realFare.fallbackReason };
}

async function handleCreateRule(e) {
  e.preventDefault();
  const { adults, children, infants } = getFormPassengers();

  const payload = {
    origin: document.getElementById('inputOrigin').value,
    destination: document.getElementById('inputDestination').value,
    departureDate: document.getElementById('inputDepDate').value,
    returnDate: document.getElementById('inputRetDate').value,
    targetPrice: Number(document.getElementById('inputTargetPrice').value),
    directOnly: document.getElementById('inputDirectOnly').checked,
    adults,
    children,
    infants
  };

  try {
    // 실제 운임 모드면 구글 플라이트 실시간 가격으로 등록한다 (못 받으면 모의 가격으로 등록하고 이유를 알림)
    if (realFareState.enabled && realFareState.providers.serpapi) {
      showToast('구글 플라이트에서 가는 편·오는 편 실시간 가격을 조회 중입니다 (검색 2회 사용)...', '📡');
    }
    const realFare = await prepareRuleExternalCandidates(payload);
    const { res, data, fallbackReason } = await postRuleWithRealFare(payload, realFare);
    if (!res.ok) throw new Error(data.error || '알림 등록 실패');

    focusRuleInChart(data.rule.id);
    if (data.notificationResult) state.selectedPreviewNoti = data.notificationResult;
    // 실제 운임을 못 받아 모의 가격으로 등록했으면 즉시 알림이 나가도 그 이유를 함께 보여 준다
    if (fallbackReason) {
      showToast(
        `실제 운임 조회 실패(${fallbackReason}) → 모의 가격으로 알림을 등록했습니다${
          data.notificationResult ? ' (모의 가격이 목표가 이하라 카카오톡 알림도 보냈습니다)' : ''
        }.`,
        '⚠️'
      );
    } else if (data.notificationError) {
      showToast(`알림을 등록했지만 ${data.notificationError}`, '⚠️');
    } else if (data.notificationResult) {
      showToast(
        data.notificationResult.isSimulatedPrice === false
          ? '등록 즉시 목표가 이하 편도조합 특가가 발견되어 카카오톡 알림이 발송되었습니다!'
          : '등록 즉시 모의 가격이 목표가 이하라 카카오톡 알림이 발송되었습니다 (실제 운임은 예약 사이트에서 확인하세요)',
        '🎉'
      );
    } else {
      showToast('편도조합 최저가 알림이 등록되었습니다!', '🔔');
    }
    await loadDashboard();
  } catch (err) {
    showToast(err.message, '⚠️');
  }
}

async function quickAddDealToWatchlist(origin, destination, departureDate, returnDate, targetPrice) {
  const { adults, children, infants } = getFormPassengers();
  const route = {
    origin,
    destination,
    departureDate,
    returnDate,
    // 카드 가격을 계산한 조건(폼의 '직항만' 체크)과 같은 조건으로 등록해야 알림 가격이 카드와 같다
    directOnly: document.getElementById('inputDirectOnly')?.checked ?? true
  };
  try {
    // 최근 검색가 카드에서 누른 것이면 그 카드의 편도 두 장을 그대로 쓴다 (구글 플라이트 검색 횟수를 쓰지 않음)
    const realFare = await prepareRuleExternalCandidates(route, { preferCachedDeal: true });
    const { res, data, fallbackReason } = await postRuleWithRealFare({ ...route, targetPrice, adults, children, infants }, realFare);
    if (!res.ok) throw new Error(data.error || '알림 등록 실패');

    focusRuleInChart(data.rule.id);
    if (data.notificationResult) {
      state.selectedPreviewNoti = data.notificationResult;
    }
    const added = `${origin} ↔ ${destination} (${departureDate}~${returnDate}) 편도조합 노선이 알림 목록에 추가되었습니다!`;
    showToast(
      fallbackReason
        ? `실제 운임 조회 실패(${fallbackReason}) → ${origin} ↔ ${destination} 노선을 모의 가격으로 등록했습니다.`
        : data.notificationError
        ? `${added} (${data.notificationError})`
        : added,
      fallbackReason || data.notificationError ? '⚠️' : '✈️'
    );
    await loadDashboard();
  } catch (err) {
    showToast(err.message, '⚠️');
  }
}

// 실제 운임 모드의 재조회: 구글 플라이트 실시간 가격 (못 받으면 기존 가격을 모의 값으로 덮어쓰지 않도록 멈춘다)
async function fetchRecheckCandidates(rule) {
  if (!realFareState.providers.serpapi) {
    throw new Error('구글 플라이트(SerpApi) 키가 프록시에 아직 없어 실시간 재조회를 할 수 없습니다. 기존 가격을 그대로 둡니다.');
  }
  try {
    return await fetchLiveExternalCandidates({
      origin: rule.origin,
      destination: rule.destination,
      departureDate: rule.departureDate,
      returnDate: rule.returnDate,
      directOnly: rule.directOnly !== false
    });
  } catch (err) {
    const wrapped = new Error(`실시간 재조회 실패(${describeRealFareFailure(err)}) — 기존 가격을 그대로 둡니다.`);
    wrapped.code = err?.code;
    throw wrapped;
  }
}

function promptPinForRealFareRule() {
  showToast('실제 운임으로 받아 온 알림이라 PIN 을 넣어야 다시 조회합니다 (모의 가격으로 덮어쓰지 않음).', '🔑');
  openRealFarePinModal();
}

async function handleCheckRule(ruleId, forceTargetHit = false) {
  try {
    const rule = state.watchRules.find((r) => r.id === ruleId);
    // 실제 운임 규칙을 PIN 없이 다시 조회하면 모의 가격이 되므로 조회하지 않고 PIN 을 묻는다 (급락 시뮬레이션은 모의 동작이라 그대로)
    if (!forceTargetHit && rule && isRealFareWatchRule(rule) && !realFareState.enabled) {
      promptPinForRealFareRule();
      return;
    }
    const useLiveFare = !forceTargetHit && Boolean(rule) && realFareState.enabled;
    showToast(
      forceTargetHit
        ? '⚡ 출국·귀국 편도 급락 특가를 시뮬레이션하고 카카오톡 알림을 발송합니다...'
        : useLiveFare
        ? '🔍 구글 플라이트에서 가는 편·오는 편 실시간 가격을 조회 중입니다 (검색 2회 사용)...'
        : '🔍 출국 편도와 귀국 편도 최저가를 각각 조회하여 합산 중입니다...',
      '✈️'
    );
    const externalCandidates = useLiveFare ? await fetchRecheckCandidates(rule) : null;
    const res = await apiFetch(`/api/rules/${ruleId}/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ forceTargetHit, forceNotify: forceTargetHit, externalCandidates })
    });
    const data = await res.json();
    if (!res.ok) {
      if (data.code === 'REAL_FARE_NEEDS_PIN') {
        promptPinForRealFareRule();
        return;
      }
      throw new Error(data.error || '조회 실패');
    }

    focusRuleInChart(ruleId);
    if (data.notificationResult) {
      state.selectedPreviewNoti = data.notificationResult;
      showToast(
        `🎯 목표가 도달! 편도합산 ${formatKrw(data.offer.priceKrw)} 카카오톡 알림 발송 완료!`,
        '💬'
      );
    } else if (data.notificationError) {
      showToast(`조회 완료: 편도합산 최저가 ${formatKrw(data.offer.priceKrw)} (가격은 저장했지만 ${data.notificationError})`, '⚠️');
    } else {
      showToast(`조회 완료: 편도합산 최저가 ${formatKrw(data.offer.priceKrw)} (${data.offer.airline})`, '✅');
    }
    await loadDashboard();
  } catch (err) {
    showToast(err.message, '⚠️');
  }
}

async function handleManualNotify(ruleId) {
  try {
    const res = await apiFetch(`/api/rules/${ruleId}/notify`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '카톡 발송 실패');

    state.selectedPreviewNoti = data.notificationResult;
    const isReal = data.notificationResult.status === 'KAKAO_SENT';
    showToast(
      isReal
        ? '실제 카카오톡(나에게 보내기)으로 편도조합 특가 카드가 전송되었습니다!'
        : '우측 카카오톡 미리보기 카드에 편도조합 특가 메시지가 생성되었습니다!',
      '💬'
    );
    await loadDashboard();
  } catch (err) {
    showToast(err.message, '⚠️');
  }
}

async function handleDeleteRule(ruleId, clickEvent) {
  if (isRepeatClick(clickEvent)) return;
  try {
    const res = await apiFetch(`/api/rules/${encodeURIComponent(ruleId)}`, { method: 'DELETE' });
    const data = await res.json();
    // 다른 탭 등에서 이미 지워진 규칙(404)이면 목록만 다시 불러온다
    const alreadyGone = res.status === 404;
    if (!res.ok && !alreadyGone) throw new Error(data.error || '알림 규칙 삭제 실패');
    if (state.selectedRuleId === ruleId) {
      state.selectedRuleId = null;
    }
    if (alreadyGone) {
      showToast('이미 삭제된 알림 규칙입니다. 목록을 새로 고쳤습니다.', 'ℹ️');
    } else {
      showToast('알림 규칙이 삭제되었습니다.', '🗑️');
    }
    await loadDashboard();
  } catch (err) {
    showToast(err.message, '⚠️');
  }
}

async function handleDeleteAllRules() {
  const total = state.watchRules.length;
  if (total === 0) {
    showToast('삭제할 알림 규칙이 없습니다.', 'ℹ️');
    return;
  }
  if (!window.confirm(`등록된 알림 규칙 ${total}건과 가격 조회 기록을 모두 삭제할까요?`)) return;
  try {
    const res = await apiFetch('/api/rules', { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '알림 규칙 전체 삭제 실패');
    state.selectedRuleId = null;
    state.chartRouteMode = 'FORM';
    showToast(`알림 규칙 ${data.deletedCount}건을 모두 삭제했습니다.`, '🗑️');
    await loadDashboard();
    loadRoutePriceTrend();
  } catch (err) {
    showToast(err.message, '⚠️');
  }
}

// 한도 초과·PIN 문제는 남은 규칙도 똑같이 실패하므로 일괄 조회를 멈춘다
const LIVE_BATCH_STOP_CODES = ['SERPAPI_LIMIT', 'PIN_INVALID', 'PIN_LOCKED', 'PROVIDER_NOT_CONFIGURED'];

/**
 * 실제 운임 모드의 일괄 조회: 활성 규칙마다 구글 플라이트 실시간 편도 두 번 → 그 규칙 재조회
 * (같은 조건은 프록시가 20분 동안 다시 검색하지 않으므로 검색 횟수는 고유 노선 × 2 이하)
 */
async function runLiveBatchCheck() {
  if (!realFareState.providers.serpapi) {
    throw new Error('구글 플라이트(SerpApi) 키가 프록시에 아직 없어 실시간 일괄 조회를 할 수 없습니다.');
  }
  const rules = state.watchRules.filter((r) => r.isActive);
  if (rules.length === 0) {
    showToast('조회할 활성 알림이 없습니다.', 'ℹ️');
    return;
  }
  const routeKey = (r) => [r.origin, r.destination, r.departureDate, r.returnDate, r.directOnly !== false].join('|');
  const uniqueCount = new Set(rules.map(routeKey)).size;
  const searchesLeft = await fetchSerpapiSearchesLeft();
  const leftText = searchesLeft === null ? '' : `\n이번 달 남은 검색: ${searchesLeft}회`;
  const confirmed = window.confirm(
    `구글 플라이트 실시간으로 알림 ${rules.length}건(고유 노선 ${uniqueCount}개)을 다시 조회합니다.\n` +
      `SerpApi 검색을 최대 ${uniqueCount * 2}회 씁니다 (무료 월 250회).${leftText}\n진행할까요?`
  );
  if (!confirmed) return;

  let checked = 0;
  let notifyFailures = 0;
  const failures = [];
  for (const rule of rules) {
    showToast(`실시간 일괄 조회 중… (${checked + failures.length + 1}/${rules.length})`, '🔄');
    try {
      const externalCandidates = await fetchRecheckCandidates(rule);
      // 일괄 조회는 정기 조회와 같이 알림 간격(cooldownHours)을 지킨다 — 두 번 눌러도 같은 알림을 또 보내지 않게
      const res = await apiFetch(`/api/rules/${rule.id}/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ externalCandidates, respectCooldown: true })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '조회 실패');
      checked += 1;
      if (data.notificationResult) state.selectedPreviewNoti = data.notificationResult;
      if (data.notificationError) notifyFailures += 1;
    } catch (err) {
      failures.push(err);
      if (LIVE_BATCH_STOP_CODES.includes(err.code)) break;
    }
  }
  const notifyText = notifyFailures ? ` · 카카오톡 알림 ${notifyFailures}건 전송 실패(가격은 저장)` : '';
  showToast(
    failures.length
      ? `실시간 일괄 조회: ${checked}건 완료 · ${failures.length}건 실패 (${failures[0].message})${notifyText}`
      : `실시간 일괄 조회 완료! (${checked}건 · 구글 플라이트)${notifyText}`,
    failures.length || notifyFailures ? '⚠️' : '✅'
  );
  await loadDashboard();
}

async function handleBatchCheck() {
  const btn = document.getElementById('btnBatchCheck');
  btn.disabled = true;
  try {
    if (realFareState.enabled) {
      await runLiveBatchCheck();
      return;
    }
    showToast('활성 노선 전체 편도조합 일괄 조회를 실행 중입니다...', '🔄');
    const res = await apiFetch('/api/batch-check', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '일괄 조회 실패');

    if (data.notificationsSent && data.notificationsSent.length > 0) {
      state.selectedPreviewNoti = data.notificationsSent[0];
    }
    // 실제 운임으로 받아 온 알림은 PIN 없이 다시 조회하지 않는다 (모의 가격으로 덮어쓰지 않음)
    const skippedText = data.skippedRealFareRules
      ? `실제 운임 알림 ${data.skippedRealFareRules}건은 PIN 을 넣어야 조회`
      : '';
    if (!data.checkedGroups) {
      // 다시 조회한 모의 알림이 없으면 '0개 노선 조회 · 절약' 대신 건너뛴 알림만 알린다
      showToast(skippedText ? `다시 조회할 모의 가격 알림이 없습니다 · ${skippedText}` : '조회할 활성 알림이 없습니다.', 'ℹ️');
    } else {
      showToast(
        `일괄 조회 완료! (${data.checkedGroups}개 고유 노선 조회 · 중복 호출 ${data.savedApiCalls}회 절약${skippedText ? ` · ${skippedText}` : ''})`,
        '✅'
      );
    }
    await loadDashboard();
  } catch (err) {
    showToast(err.message, '⚠️');
  } finally {
    btn.disabled = false;
  }
}

async function openSettingsModal() {
  const modal = document.getElementById('settingsModal');
  modal.classList.remove('hidden');

  const res = await apiFetch('/api/settings');
  const s = await res.json();

  document.getElementById('settingPreferredSource').value = s.preferredDataSource || 'AUTO';
  document.getElementById('settingAmadeusId').value = s.amadeusClientId || '';
  document.getElementById('settingAmadeusSecret').value = s.amadeusClientSecret || '';
  document.getElementById('settingTravelpayoutsToken').value = s.travelpayoutsToken || '';
  document.getElementById('settingKakaoRestKey').value = s.kakaoRestApiKey || '';
  document.getElementById('settingKakaoRedirectUri').value =
    s.kakaoRedirectUri || 'http://localhost:3000/api/kakao/callback';
  document.getElementById('settingKakaoAccessToken').value = '';

  const statusEl = document.getElementById('modalKakaoStatus');
  if (s.hasKakaoAccessToken) {
    statusEl.textContent = `✅ 실제 카톡 토큰 연결됨 (${s.kakaoAccessTokenPreview})`;
    statusEl.className = 'text-xs font-bold text-emerald-700';
  } else {
    statusEl.textContent = '미연동 (웹 내 카카오톡 카드 미리보기 모드)';
    statusEl.className = 'text-xs font-semibold text-slate-600';
  }
}

function closeSettingsModal() {
  document.getElementById('settingsModal').classList.add('hidden');
}

async function handleSaveSettings() {
  const payload = {
    preferredDataSource: document.getElementById('settingPreferredSource').value,
    amadeusClientId: document.getElementById('settingAmadeusId').value,
    amadeusClientSecret: document.getElementById('settingAmadeusSecret').value,
    travelpayoutsToken: document.getElementById('settingTravelpayoutsToken').value,
    kakaoRestApiKey: document.getElementById('settingKakaoRestKey').value,
    kakaoRedirectUri: document.getElementById('settingKakaoRedirectUri').value,
    kakaoAccessToken: document.getElementById('settingKakaoAccessToken').value
  };

  const res = await apiFetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (res.ok) {
    showToast('API 및 카카오톡 알림 설정이 저장되었습니다.', '⚙️');
    closeSettingsModal();
    await loadDashboard();
  }
}

async function saveSettingsAndStartKakaoLogin() {
  const restKey = document.getElementById('settingKakaoRestKey').value.trim();
  if (!restKey) {
    showToast('먼저 카카오 디벨로퍼스의 REST API 키를 입력해 주세요.', '⚠️');
    return;
  }
  await handleSaveSettings();
  window.location.href = '/api/kakao/login';
}

async function handleClearKakaoToken() {
  await apiFetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clearKakaoToken: true })
  });
  showToast('카카오 토큰이 초기화되어 미리보기 모드로 전환되었습니다.', 'ℹ️');
  await openSettingsModal();
  await loadDashboard();
}

window.addEventListener('DOMContentLoaded', initApp);
