/**
 * SkyBell KR v2.1 - 프론트엔드 통합 로직
 * - 70개+ 전 세계 도시 검색/선택 + 사용자 원하는 도시/공항 코드 직접 입력(Custom) 추가
 * - 도시 미지정 시 향후 6개월(180일) 이내 저렴한 항공편 Top 10 자동 선정
 * - 출국 편도 + 귀국 편도 개별 탐색 합산
 * - 지난 2년간 최저가 · 평균가 · 상위 10% 특가 기준선 벤치마크
 * - 단일 출발일 지정 시 돌아오는 일정별(1박~10박) 가격 한눈에 보기 (Return Date Matrix)
 * - 성인 / 소아 / 유아(만 24개월 미만) 인원 설정 및 총액 계산
 */

let state = {
  origins: [],
  destinations: [],
  curatedDeals: [],
  watchRules: [],
  historiesByRule: {},
  notificationLogs: [],
  apiQuotaStats: {},
  statusSummary: {},
  selectedRuleId: null,
  selectedPreviewNoti: null,
  activeExplorerTab: 'ANYWHERE_TOP10', // 'ANYWHERE_TOP10' | 'RETURN_MATRIX' | 'CHEAP_RECOMMEND'
  activeAnywhereTier: 'ALL_3_TIERS', // 'ALL_3_TIERS' | 'TOP10' | 'TOP20' | 'TOP30'
  anywhereCumulativeMode: false, // true일 때 TOP20은 1~20위, TOP30은 1~30위 누적 표시
  anywhereTop10Data: null,
  returnMatrixData: null,
  scheduleRecommendData: null
};

let priceChartInstance = null;

function formatKrw(amount) {
  if (amount === null || amount === undefined || Number.isNaN(Number(amount))) return '-';
  return `${Math.round(Number(amount)).toLocaleString('ko-KR')}원`;
}

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
async function apiFetch(url, options = {}) {
  if (!state.useStandaloneMode) {
    try {
      const res = await fetch(url, options);
      const contentType = res.headers.get('content-type') || '';
      if (res.ok && contentType.includes('application/json')) {
        return res;
      }
      if (res.status === 404 || res.status === 405 || !contentType.includes('application/json')) {
        state.useStandaloneMode = true;
      } else {
        return res;
      }
    } catch (_err) {
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
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('kakao_connected') === '1') {
      showToast('카카오톡 메시지 API(A안) 연동 완료! 이제 실제 카톡으로 편도조합 특가 알림이 전송됩니다.', '🎉');
      window.history.replaceState({}, document.title, window.location.pathname);
    } else if (urlParams.get('kakao_error')) {
      showToast(`카카오 연동 오류: ${urlParams.get('kakao_error')}`, '⚠️');
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    const metaRes = await apiFetch('/api/meta');
    const meta = await metaRes.json();
    state.origins = meta.origins || [];
    state.destinations = meta.destinations || [];
    state.curatedDeals = meta.curatedDeals || [];

    setDefaultFormDates();
    populateAirportSelects();

    await Promise.all([
      loadDashboard(),
      loadAnywhereTop10(),
      loadReturnDateMatrix(),
      loadScheduleRecommendations()
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
        `<optgroup label="── ${region} (${items.length}곳) ──">` +
        items
          .map((d) => {
            const avg2Y = d.benchmark2Y?.avg2YKrw || d.basePriceKrw;
            const low2Y = d.benchmark2Y?.lowest2YKrw || d.dealThresholdKrw;
            const isSel = d.code === prevCode ? 'selected' : '';
            return `<option value="${d.code}" ${isSel}>${d.city} (${d.code}) · 2년 최저 ${Math.round(low2Y / 10000)}만 / 평균 ${Math.round(avg2Y / 10000)}만</option>`;
          })
          .join('') +
        `</optgroup>`
    )
    .join('');

  // 검색어와 일치하는 도시가 없는 경우 직접 입력 안내 옵션 제공
  if (filteredList.length === 0 && kw.length >= 2) {
    const cleanUpper = kw.toUpperCase().slice(0, 3);
    html = `<option value="${cleanUpper}" selected>✍️ '${kw}' (${cleanUpper}) 직접 입력 도시로 바로 조회</option>`;
  }

  destSelect.innerHTML = html;

  const activeCode = destSelect.value;
  const dest = state.destinations.find((d) => d.code === activeCode);
  if (dest) {
    document.getElementById('inputTargetPrice').value = dest.benchmark2Y?.top10Deal2YKrw || dest.dealThresholdKrw;
  }
  renderBenchmark2YPanel();
  updatePassengerTotalPreview();
}

function filterDestinationSelect() {
  const kw = document.getElementById('destQuickFilter')?.value || '';
  renderDestinationOptions(null, kw);
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
    document.getElementById('customCityBox').classList.add('hidden');
    showToast(`${city}(${code}) 도시가 목록에 추가되고 선택되었습니다!`, '✈️');

    await Promise.all([
      loadAnywhereTop10(),
      loadReturnDateMatrix(),
      loadScheduleRecommendations()
    ]);
  } catch (err) {
    showToast(err.message, '⚠️');
  }
}

function handleDestinationChange() {
  const destCode = document.getElementById('inputDestination').value;
  const dest = state.destinations.find((d) => d.code === destCode);
  if (dest) {
    document.getElementById('inputTargetPrice').value = dest.benchmark2Y?.top10Deal2YKrw || dest.dealThresholdKrw;
  }
  renderBenchmark2YPanel();
  updatePassengerTotalPreview();
  loadReturnDateMatrix();
  loadScheduleRecommendations();
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
}

function handlePassengerCountChange() {
  getFormPassengers();
  updatePassengerTotalPreview();
  loadAnywhereTop10();
  loadReturnDateMatrix();
  loadScheduleRecommendations();
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
 * 선택된 노선의 지난 2년간(24개월) 최저가 · 평균가 · 특가 기준선 벤치마크 패널 렌더링
 */
function renderBenchmark2YPanel() {
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

  const b2y = dest.benchmark2Y || {};
  const factor = origin.originFactor || 1.0;
  const lowest2Y = Math.round(((b2y.lowest2YKrw || 150000) * factor) / 1000) * 1000;
  const top10Deal2Y = Math.round(((b2y.top10Deal2YKrw || dest.dealThresholdKrw) * factor) / 1000) * 1000;
  const avg2Y = Math.round(((b2y.avg2YKrw || dest.basePriceKrw) * factor) / 1000) * 1000;
  const peakHigh2Y = Math.round(((b2y.peakHigh2YKrw || dest.basePriceKrw * 1.7) * factor) / 1000) * 1000;
  const outAvgOneWay = Math.round(((b2y.outboundAvgOneWayKrw || avg2Y * 0.49) * factor) / 1000) * 1000;
  const inAvgOneWay = Math.round(((b2y.inboundAvgOneWayKrw || avg2Y * 0.51) * factor) / 1000) * 1000;

  const panel = document.getElementById('benchmark2YPanel');
  panel.innerHTML = `
    <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
      <div class="space-y-1">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-xs font-extrabold px-2.5 py-0.5 rounded-full bg-amber-400 text-slate-950">
            📊 지난 2년간(24개월) 실거래 시세 기준표
          </span>
          <span class="text-sm sm:text-base font-extrabold text-white">
            ${origin.city}(${originCode}) ↔ ${dest.city}(${destCode})
          </span>
          <span class="text-xs text-slate-300">
            (비행시간 ${dest.flightDuration} · 편도 평균: 출국 ${formatKrw(outAvgOneWay)} + 귀국 ${formatKrw(inAvgOneWay)})
          </span>
        </div>
        <p class="text-xs text-slate-300">
          💡 <b>편도 조합 공략 팁:</b> ${b2y.priceTip || '가는 편과 오는 편을 서로 다른 항공사 편도로 조합하면 왕복 묶음 대비 평균 12~18% 저렴합니다.'}
        </p>
        <div class="flex flex-wrap items-center gap-3 text-[11px] text-slate-300 pt-0.5">
          <span>🟢 <b>최근 2년 최저가 발생 비수기 월:</b> ${(b2y.cheapestMonths || []).join(', ')}</span>
          <span>🔴 <b>성수기 할증 구간:</b> ${(b2y.peakMonths || []).join(', ')}</span>
        </div>
      </div>

      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5 shrink-0">
        <div
          onclick="applyTargetPriceFromBenchmark(${lowest2Y})"
          class="cursor-pointer bg-rose-500/20 hover:bg-rose-500/30 border border-rose-400/40 rounded-xl p-2.5 text-center transition"
        >
          <div class="text-[11px] text-rose-200 font-semibold">🔥 2년 역대 최저가</div>
          <div class="text-sm sm:text-base font-extrabold text-white mt-0.5">${formatKrw(lowest2Y)}</div>
          <div class="text-[10px] text-rose-300 mt-0.5">[클릭 시 목표가 적용]</div>
        </div>

        <div
          onclick="applyTargetPriceFromBenchmark(${top10Deal2Y})"
          class="cursor-pointer bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-400/40 rounded-xl p-2.5 text-center transition"
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
}

function applyTargetPriceFromBenchmark(price) {
  document.getElementById('inputTargetPrice').value = price;
  updatePassengerTotalPreview();
  showToast(`희망 목표가가 ${formatKrw(price)}으로 설정되었습니다!`, '🎯');
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
    if (t.name === tabName) {
      btnEl.className = 'text-xs px-3.5 py-2 rounded-lg font-bold bg-slate-900 text-white shadow-sm transition';
      panelEl.classList.remove('hidden');
    } else {
      btnEl.className = 'text-xs px-3.5 py-2 rounded-lg font-semibold text-slate-600 hover:text-slate-900 transition';
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

  const res = await apiFetch(`/api/anywhere-top10?${params.toString()}`);
  const data = await res.json();
  state.anywhereTop10Data = data;
  renderAnywhereTop10();
}

function switchAnywhereTierView(tierKey) {
  state.activeAnywhereTier = tierKey;
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

  const originCityShort = (deal.originCity || '인천').replace('서울/', '').replace('부산/', '');

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
          <span class="text-[11px] font-extrabold text-rose-600 bg-rose-50 border border-rose-200 px-2 py-0.5 rounded-md">
            2년평균 -${deal.discountVs2YAvgPercent}%
          </span>
        </div>

        <!-- 한국 출발 공항 배지 + 도착 도시명 및 국가 -->
        <div class="flex items-center justify-between gap-1 mb-1">
          <span class="text-[10px] font-extrabold px-2 py-0.5 rounded-md bg-indigo-50 text-indigo-700 border border-indigo-200">
            🛫 ${originCityShort}(${deal.origin}) 출발
          </span>
          <span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 font-semibold shrink-0">
            ${deal.country}
          </span>
        </div>
        <div class="text-sm font-extrabold text-slate-900 truncate">
          ${originCityShort} ↔ ${deal.destinationCity} (${deal.destination})
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
              <span class="font-bold text-slate-800">${deal.outboundLeg.airline} ${formatKrw(deal.outboundLeg.oneWayPriceKrw)}</span>
            </div>
            <div class="flex items-center justify-end gap-1.5 mt-0.5 text-[10px]">
              <a href="${outNaverUrl}" target="_blank" rel="noopener noreferrer" class="text-sky-600 hover:underline font-bold">네이버 편도예약 ↗</a>
              <span class="text-slate-300">·</span>
              <a href="${outOfficialUrl}" target="_blank" rel="noopener noreferrer" class="text-slate-600 hover:underline font-semibold">${deal.outboundLeg.airline} 공식 ↗</a>
            </div>
          </div>

          <div class="border-t border-slate-200/60 pt-1">
            <div class="flex justify-between items-center">
              <span class="text-slate-500">🛬 귀국편도 (${deal.destination}→${deal.origin})</span>
              <span class="font-bold text-slate-800">${deal.inboundLeg.airline} ${formatKrw(deal.inboundLeg.oneWayPriceKrw)}</span>
            </div>
            <div class="flex items-center justify-end gap-1.5 mt-0.5 text-[10px]">
              <a href="${inNaverUrl}" target="_blank" rel="noopener noreferrer" class="text-indigo-600 hover:underline font-bold">네이버 편도예약 ↗</a>
              <span class="text-slate-300">·</span>
              <a href="${inOfficialUrl}" target="_blank" rel="noopener noreferrer" class="text-slate-600 hover:underline font-semibold">${deal.inboundLeg.airline} 공식 ↗</a>
            </div>
          </div>
        </div>

        <!-- 2년 최저/평균 대비 현재 가격 -->
        <div class="mt-2.5 pt-2 border-t border-slate-100">
          <div class="flex items-center justify-between text-[10px] text-slate-400">
            <span>2년평균 ${formatKrw(deal.avg2YKrw)}</span>
            <span>2년최저 ${formatKrw(deal.lowest2YKrw)}</span>
          </div>
          <div class="flex items-baseline justify-between mt-1">
            <span class="text-[11px] font-semibold text-slate-500">1인 편도합산</span>
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
        <div class="grid grid-cols-2 gap-1">
          <a
            href="${naverRoundUrl}"
            target="_blank"
            rel="noopener noreferrer"
            class="text-center text-[11px] py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold transition"
          >
            🟢 네이버 예약 ↗
          </a>
          <a
            href="${skyscannerUrl}"
            target="_blank"
            rel="noopener noreferrer"
            class="text-center text-[11px] py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-bold transition"
          >
            🔵 스카이스캐너 ↗
          </a>
        </div>
        <div class="grid grid-cols-2 gap-1">
          <a
            href="${googleFlightsUrl}"
            target="_blank"
            rel="noopener noreferrer"
            class="text-center text-[10px] py-1 rounded-md bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold transition"
          >
            🌐 구글 플라이트 ↗
          </a>
          <a
            href="${tripComUrl}"
            target="_blank"
            rel="noopener noreferrer"
            class="text-center text-[10px] py-1 rounded-md bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold transition"
          >
            ✈️ 트립닷컴 예약 ↗
          </a>
        </div>

        <!-- 폼 적용 및 알림 등록 -->
        <div class="grid grid-cols-2 gap-1.5 pt-0.5">
          <button
            onclick="applyAnywhereDealToForm('${deal.origin}', '${deal.destination}', '${deal.departureDate}', '${deal.returnDate}', ${deal.combinedAdultPriceKrw})"
            class="text-[11px] py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold transition"
          >
            노선·일정 선택
          </button>
          <button
            onclick="quickAddDealToWatchlist('${deal.origin}', '${deal.destination}', '${deal.departureDate}', '${deal.returnDate}', ${deal.combinedAdultPriceKrw})"
            class="text-[11px] py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white font-bold transition"
          >
            + 알림 등록
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderAnywhereTop10() {
  const data = state.anywhereTop10Data;
  const summaryBarEl = document.getElementById('anywhereTierSummaryBar');
  const gridEl = document.getElementById('anywhereTop10Grid');
  if (!data || !data.tiers) return;

  const { top10, top20, top30 } = data.tiers;
  const activeTier = state.activeAnywhereTier || 'ALL_3_TIERS';

  document.getElementById('anywhereScannedSummary').textContent = `${data.originCity}(${data.origin}) 출발 · ${
    data.region === 'ALL' ? '전 세계' : data.region
  } ${data.scannedCitiesCount}개 도시 스캔 · 총 30개 최저가 노선 (TOP 10 · TOP 20 · TOP 30 구분)`;

  // 상단 3단계 구분 요약 및 탭 버튼 바 렌더링
  if (summaryBarEl) {
    summaryBarEl.innerHTML = `
      <button
        onclick="switchAnywhereTierView('ALL_3_TIERS')"
        class="text-left rounded-2xl p-3.5 border transition ${
          activeTier === 'ALL_3_TIERS'
            ? 'border-slate-900 bg-slate-900 text-white shadow-md'
            : 'border-slate-200 bg-slate-50 hover:bg-white text-slate-800'
        }"
      >
        <div class="flex items-center justify-between">
          <span class="text-xs font-extrabold">📊 전체 3단 구분 한눈에 보기</span>
          <span class="text-[10px] px-2 py-0.5 rounded-full ${
            activeTier === 'ALL_3_TIERS' ? 'bg-sky-500 text-white font-bold' : 'bg-slate-200 text-slate-700 font-semibold'
          }">총 30개 노선</span>
        </div>
        <div class="text-[11px] mt-1.5 ${activeTier === 'ALL_3_TIERS' ? 'text-slate-300' : 'text-slate-500'}">
          <b>TOP 10 · TOP 20 · TOP 30</b> 세 가지 그룹을 한 화면에서 구분 비교
        </div>
      </button>

      <button
        onclick="switchAnywhereTierView('TOP10')"
        class="text-left rounded-2xl p-3.5 border transition ${
          activeTier === 'TOP10'
            ? 'border-sky-600 bg-sky-600 text-white shadow-md'
            : 'border-sky-200 bg-sky-50/50 hover:bg-sky-50 text-slate-800'
        }"
      >
        <div class="flex items-center justify-between">
          <span class="text-xs font-extrabold">🥇 TOP 10 (1위 ~ 10위)</span>
          <span class="text-[10px] px-2 py-0.5 rounded-full ${
            activeTier === 'TOP10' ? 'bg-white text-sky-700 font-extrabold' : 'bg-sky-100 text-sky-800 font-bold'
          }">초저가 최상위</span>
        </div>
        <div class="text-xs font-extrabold mt-1 ${activeTier === 'TOP10' ? 'text-white' : 'text-sky-900'}">
          ${formatKrw(top10.minPriceKrw)} ~ ${formatKrw(top10.maxPriceKrw)}
        </div>
        <div class="text-[10px] mt-0.5 ${activeTier === 'TOP10' ? 'text-sky-100' : 'text-slate-500'}">
          그룹 평균가: <b>${formatKrw(top10.avgPriceKrw)}</b>
        </div>
      </button>

      <button
        onclick="switchAnywhereTierView('TOP20')"
        class="text-left rounded-2xl p-3.5 border transition ${
          activeTier === 'TOP20'
            ? 'border-indigo-600 bg-indigo-600 text-white shadow-md'
            : 'border-indigo-200 bg-indigo-50/50 hover:bg-indigo-50 text-slate-800'
        }"
      >
        <div class="flex items-center justify-between">
          <span class="text-xs font-extrabold">🥈 TOP 20 (11위 ~ 20위)</span>
          <span class="text-[10px] px-2 py-0.5 rounded-full ${
            activeTier === 'TOP20' ? 'bg-white text-indigo-700 font-extrabold' : 'bg-indigo-100 text-indigo-800 font-bold'
          }">가성비 인기</span>
        </div>
        <div class="text-xs font-extrabold mt-1 ${activeTier === 'TOP20' ? 'text-white' : 'text-indigo-900'}">
          ${formatKrw(top20.minPriceKrw)} ~ ${formatKrw(top20.maxPriceKrw)}
        </div>
        <div class="text-[10px] mt-0.5 ${activeTier === 'TOP20' ? 'text-indigo-100' : 'text-slate-500'}">
          그룹 평균가: <b>${formatKrw(top20.avgPriceKrw)}</b> (1~20위 누적 가능)
        </div>
      </button>

      <button
        onclick="switchAnywhereTierView('TOP30')"
        class="text-left rounded-2xl p-3.5 border transition ${
          activeTier === 'TOP30'
            ? 'border-emerald-600 bg-emerald-600 text-white shadow-md'
            : 'border-emerald-200 bg-emerald-50/50 hover:bg-emerald-50 text-slate-800'
        }"
      >
        <div class="flex items-center justify-between">
          <span class="text-xs font-extrabold">🥉 TOP 30 (21위 ~ 30위)</span>
          <span class="text-[10px] px-2 py-0.5 rounded-full ${
            activeTier === 'TOP30' ? 'bg-white text-emerald-700 font-extrabold' : 'bg-emerald-100 text-emerald-800 font-bold'
          }">실속 특가</span>
        </div>
        <div class="text-xs font-extrabold mt-1 ${activeTier === 'TOP30' ? 'text-white' : 'text-emerald-900'}">
          ${formatKrw(top30.minPriceKrw)} ~ ${formatKrw(top30.maxPriceKrw)}
        </div>
        <div class="text-[10px] mt-0.5 ${activeTier === 'TOP30' ? 'text-emerald-100' : 'text-slate-500'}">
          그룹 평균가: <b>${formatKrw(top30.avgPriceKrw)}</b> (1~30위 누적 가능)
        </div>
      </button>
    `;
  }

  // 개별 섹션 HTML 빌더
  const buildTierSectionHtml = (tierObj, theme, showCumulativeToggle = false) => {
    const itemsToRender =
      showCumulativeToggle && state.anywhereCumulativeMode && tierObj.cumulativeItems
        ? tierObj.cumulativeItems
        : tierObj.items;

    const rangeText =
      showCumulativeToggle && state.anywhereCumulativeMode
        ? `1위 ~ ${tierObj.rankEnd}위 누적 전체 (${itemsToRender.length}개)`
        : `${tierObj.rankStart}위 ~ ${tierObj.rankEnd}위 구분 (${itemsToRender.length}개)`;

    return `
      <div class="rounded-2xl border ${theme.border} ${theme.bg} p-4 space-y-3.5">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b ${theme.divider} pb-3">
          <div>
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-xs font-extrabold px-2.5 py-1 rounded-lg ${theme.badge}">
                ${tierObj.label}
              </span>
              <span class="text-xs font-bold text-slate-700">
                표시 범위: ${rangeText}
              </span>
            </div>
            <p class="text-[11px] text-slate-600 mt-1">
              ${tierObj.description}
            </p>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            ${
              showCumulativeToggle
                ? `
              <button
                onclick="toggleAnywhereCumulativeMode()"
                class="text-[11px] px-3 py-1.5 rounded-xl font-bold border transition ${
                  state.anywhereCumulativeMode
                    ? 'bg-slate-900 text-white border-slate-900'
                    : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
                }"
              >
                ${
                  state.anywhereCumulativeMode
                    ? `✓ 1위~${tierObj.rankEnd}위 누적 보기 중 (${tierObj.rankStart}~${tierObj.rankEnd}위만 보기로 전환)`
                    : `1위~${tierObj.rankEnd}위 누적 전체 보기로 전환`
                }
              </button>
            `
                : ''
            }
            <div class="bg-white px-3 py-1.5 rounded-xl border ${theme.border} text-xs">
              <span class="text-slate-500">가격대:</span>
              <b class="${theme.priceText}">${formatKrw(tierObj.minPriceKrw)} ~ ${formatKrw(tierObj.maxPriceKrw)}</b>
              <span class="text-slate-300 mx-1">|</span>
              <span class="text-slate-500">평균:</span>
              <b class="text-slate-800">${formatKrw(tierObj.avgPriceKrw)}</b>
            </div>
          </div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3.5">
          ${itemsToRender.map((deal) => renderAnywhereDealCardHtml(deal, theme.cardBadge)).join('')}
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
    gridEl.innerHTML = buildTierSectionHtml(top10, themes.TOP10, false);
  } else if (activeTier === 'TOP20') {
    gridEl.innerHTML = buildTierSectionHtml(top20, themes.TOP20, true);
  } else if (activeTier === 'TOP30') {
    gridEl.innerHTML = buildTierSectionHtml(top30, themes.TOP30, true);
  } else {
    // 기본: TOP 10 (1~10위) / TOP 20 (11~20위) / TOP 30 (21~30위) 세 가지로 명확히 구분하여 모두 표시
    gridEl.innerHTML = [
      buildTierSectionHtml(top10, themes.TOP10, false),
      buildTierSectionHtml(top20, themes.TOP20, false),
      buildTierSectionHtml(top30, themes.TOP30, false)
    ].join('');
  }
}

function applyAnywhereDealToForm(originCode, destCode, depDate, retDate, priceKrw) {
  document.getElementById('destQuickFilter').value = '';
  renderDestinationOptions(destCode);
  document.getElementById('inputDepDate').value = depDate;
  document.getElementById('inputRetDate').value = retDate;
  document.getElementById('inputTargetPrice').value = priceKrw;
  updatePassengerTotalPreview();
  loadReturnDateMatrix();
  loadScheduleRecommendations();
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

  const res = await apiFetch(`/api/return-date-matrix?${params.toString()}`);
  const data = await res.json();
  state.returnMatrixData = data;
  renderReturnDateMatrix();
}

function renderReturnDateMatrix() {
  const data = state.returnMatrixData;
  if (!data || !data.outboundLeg) return;

  const currentReturnInput = document.getElementById('inputRetDate')?.value;
  const out = data.outboundLeg;
  const best = data.cheapestOption;

  const headerEl = document.getElementById('outboundFixedHeader');
  headerEl.innerHTML = `
    <div class="flex flex-wrap items-center gap-2 text-xs sm:text-sm">
      <span class="px-2.5 py-1 rounded-lg bg-sky-600 text-white font-bold text-xs">
        🛫 지정된 가는 날 (${data.departureDate} ${data.departureDayOfWeekKo}요일)
      </span>
      <span class="font-extrabold text-slate-900">
        ${data.originCity}(${data.origin}) → ${data.destinationCity}(${data.destination})
      </span>
      <span class="text-slate-600">
        최저가 가는편: <b class="text-sky-700">${out.airline} (${out.flightNumber})</b> · ${out.scheduleTime} · <b>편도 ${formatKrw(out.oneWayPriceKrw)}</b>
      </span>
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
        ${out.airline} 공식 ↗
      </a>
    </div>
    <div class="text-xs font-bold text-emerald-700 bg-white px-3 py-1.5 rounded-xl border border-emerald-200">
      👑 가장 저렴한 귀국일: ${best ? `${best.returnDate}(${best.returnDayOfWeekKo}) [${best.stayLabel}] · 합산 ${formatKrw(best.combinedAdultPriceKrw)}` : '-'}
    </div>
  `;

  const gridEl = document.getElementById('returnMatrixGrid');
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
      } else {
        badgeHtml = `<span class="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">주말/성수기</span>`;
      }

      const links = opt.bookingLinks || {};
      const inNaverUrl = links.inboundNaverUrl || opt.inboundLeg?.naverOneWayUrl || '#';
      const inOfficialUrl = links.inboundAirlineOfficialUrl || opt.inboundLeg?.officialBookingUrl || '#';

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
            <div class="text-[11px] text-slate-500 mt-0.5 truncate">
              오는편: <b>${opt.inboundLeg.airline}</b> (${formatKrw(opt.inboundLeg.oneWayPriceKrw)})
            </div>
            <div class="flex items-center gap-1.5 mt-1 text-[10px]" onclick="event.stopPropagation()">
              <a href="${inNaverUrl}" target="_blank" rel="noopener noreferrer" class="text-indigo-600 hover:underline font-bold">오는편 편도예약 ↗</a>
              <span class="text-slate-300">·</span>
              <a href="${inOfficialUrl}" target="_blank" rel="noopener noreferrer" class="text-slate-600 hover:underline font-semibold">${opt.inboundLeg.airline} 공식 ↗</a>
            </div>

            <div class="mt-2 w-full bg-slate-100 h-1.5 rounded-full overflow-hidden">
              <div
                class="h-full rounded-full ${isCheapest ? 'bg-emerald-500' : 'bg-sky-500'}"
                style="width: ${barRatio}%"
              ></div>
            </div>

            <div class="mt-2 pt-2 border-t border-slate-100">
              <div class="text-[10px] text-slate-400">가는편+오는편 성인 1인 합산</div>
              <div class="text-base font-extrabold ${isCheapest ? 'text-emerald-700' : 'text-slate-900'}">
                ${formatKrw(opt.combinedAdultPriceKrw)}
              </div>
              <div class="text-[11px] text-slate-500 font-medium">
                총 인원 합계: <b class="text-slate-700">${formatKrw(opt.totalPassengersPriceKrw)}</b>
              </div>
            </div>
          </div>

          <div class="mt-2.5 pt-2 border-t border-slate-100 space-y-1.5" onclick="event.stopPropagation()">
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
                onclick="quickAddDealToWatchlist('${data.origin}', '${data.destination}', '${data.departureDate}', '${opt.returnDate}', ${opt.combinedAdultPriceKrw})"
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

  const res = await apiFetch(`/api/schedule-recommendations?${params.toString()}`);
  const data = await res.json();
  state.scheduleRecommendData = data;
  renderScheduleRecommendations();
}

function renderScheduleRecommendations() {
  const data = state.scheduleRecommendData;
  const container = document.getElementById('recommendedSchedulesGrid');
  if (!data || !data.recommendations) return;

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
              <span class="text-xs font-bold text-rose-600 bg-rose-50 px-2 py-0.5 rounded-md border border-rose-200">
                2년 평균 대비 -${rec.discountVs2YAvgPercent}%
              </span>
            </div>

            <div class="text-sm font-extrabold text-slate-900">
              📅 ${rec.departureDate}(${rec.departureDayOfWeekKo}) ~ ${rec.returnDate}(${rec.returnDayOfWeekKo}) · ${rec.stayLabel}
            </div>

            <div class="bg-slate-50 rounded-xl p-2.5 border border-slate-200/70 space-y-1.5 text-xs">
              <div>
                <div class="flex items-center justify-between">
                  <span class="text-slate-500">🛫 가는편 편도 (${rec.origin}→${rec.destination})</span>
                  <span class="font-bold text-slate-800">${rec.outboundLeg.airline} (${rec.outboundLeg.flightNumber}) · ${formatKrw(rec.outboundLeg.oneWayPriceKrw)}</span>
                </div>
                <div class="flex items-center justify-end gap-2 mt-0.5 text-[11px]">
                  <a href="${outNaverUrl}" target="_blank" rel="noopener noreferrer" class="text-sky-600 hover:underline font-bold">네이버 편도예약 ↗</a>
                  <span class="text-slate-300">·</span>
                  <a href="${outOfficialUrl}" target="_blank" rel="noopener noreferrer" class="text-slate-600 hover:underline font-semibold">${rec.outboundLeg.airline} 공식 ↗</a>
                </div>
              </div>
              <div class="border-t border-slate-200/60 pt-1">
                <div class="flex items-center justify-between">
                  <span class="text-slate-500">🛬 오는편 편도 (${rec.destination}→${rec.origin})</span>
                  <span class="font-bold text-slate-800">${rec.inboundLeg.airline} (${rec.inboundLeg.flightNumber}) · ${formatKrw(rec.inboundLeg.oneWayPriceKrw)}</span>
                </div>
                <div class="flex items-center justify-end gap-2 mt-0.5 text-[11px]">
                  <a href="${inNaverUrl}" target="_blank" rel="noopener noreferrer" class="text-indigo-600 hover:underline font-bold">네이버 편도예약 ↗</a>
                  <span class="text-slate-300">·</span>
                  <a href="${inOfficialUrl}" target="_blank" rel="noopener noreferrer" class="text-slate-600 hover:underline font-semibold">${rec.inboundLeg.airline} 공식 ↗</a>
                </div>
              </div>
            </div>

            <div class="pt-1 flex items-baseline justify-between">
              <div>
                <div class="text-[11px] text-slate-400">성인 1인 편도합산</div>
                <div class="text-lg font-extrabold text-slate-900">${formatKrw(rec.combinedAdultPriceKrw)}</div>
              </div>
              <div class="text-right">
                <div class="text-[11px] text-slate-400">${rec.passengerSummaryText} 총액</div>
                <div class="text-sm font-extrabold text-sky-700">${formatKrw(rec.totalPassengersPriceKrw)}</div>
              </div>
            </div>
          </div>

          <div class="mt-3 pt-2.5 border-t border-slate-100 space-y-1.5">
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
  state.apiQuotaStats = data.apiQuotaStats || {};
  state.statusSummary = data.statusSummary || {};

  if (!state.selectedRuleId && state.watchRules.length > 0) {
    state.selectedRuleId = state.watchRules[0].id;
  }
  if (state.notificationLogs.length > 0 && !state.selectedPreviewNoti) {
    state.selectedPreviewNoti = state.notificationLogs[0];
  }

  renderStatusAndKpis();
  renderWatchRules();
  renderPriceChart();
  renderKakaoPreviewAndLogs();
}

function renderStatusAndKpis() {
  const s = state.statusSummary;
  const q = state.apiQuotaStats;

  let providerLabel = '한국발 편도조합 엔진';
  if (s.hasAmadeusKey) providerLabel = 'Amadeus 편도합산 공식 API 연동됨';
  else if (s.hasTravelpayoutsToken) providerLabel = 'Travelpayouts 무료 API 연동됨';

  document.getElementById('apiStatusText').textContent = `${providerLabel} · ${
    s.hasKakaoToken ? '실제 카카오톡 발송 ON' : '카카오톡 미리보기 모드'
  }`;

  document.getElementById('kpiActiveCount').textContent = `${q.activeRulesCount || 0}개`;
  document.getElementById('kpiDedupeInfo').textContent = `고유 쿼리 ${q.uniqueWatchKeysCount || 0}개 · 중복 절약 ${
    q.deduplicatedSavedCalls || 0
  }회`;

  const targetHits = state.watchRules.filter((r) => r.isTargetReached).length;
  document.getElementById('kpiTargetHitCount').textContent = `${targetHits}개`;

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

  document.getElementById('kpiNotiCount').textContent = state.notificationLogs.length;
  const kakaoBadge = document.getElementById('kpiKakaoBadge');
  if (s.hasKakaoToken) {
    kakaoBadge.textContent = '실제 카톡 연동 ON';
    kakaoBadge.className = 'px-2 py-0.5 rounded-md font-bold bg-emerald-100 text-emerald-800';
  } else {
    kakaoBadge.textContent = '미리보기 시뮬레이터';
    kakaoBadge.className = 'px-2 py-0.5 rounded-md font-semibold kakao-yellow';
  }
}

/**
 * 내 알림 목록 렌더링
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
      const diffAbs = Math.abs(rule.diffFromTarget || 0);
      const pax = rule.passengerPricing || {
        passengerSummaryText: `성인 ${rule.adults || 1}명`,
        totalPassengersPriceKrw: rule.currentLowestPrice
      };
      const b2y = rule.benchmark2Y || {};

      const statusBadge = isReached
        ? `<span class="inline-flex items-center gap-1 text-xs font-bold px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-300">
             🎯 목표가 달성! (-${formatKrw(diffAbs)} 절약)
           </span>`
        : `<span class="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
             ⏳ 목표가까지 +${formatKrw(diffAbs)}
           </span>`;

      const mixMatchBadge =
        rule.mixMatchSavingsKrw > 0
          ? `<span class="text-[11px] font-bold text-indigo-700 bg-indigo-50 border border-indigo-200 px-2 py-0.5 rounded-md">
               편도 분리조합으로 왕복묶음 대비 -${formatKrw(rule.mixMatchSavingsKrw)} 추가 절약
             </span>`
          : '';

      const outLeg = rule.outboundLeg;
      const inLeg = rule.inboundLeg;

      return `
        <div
          onclick="selectRuleForChart('${rule.id}')"
          class="cursor-pointer rounded-2xl p-4 transition border ${
            isSelected
              ? 'border-sky-500 bg-sky-50/30 ring-2 ring-sky-500/20'
              : 'border-slate-200 hover:border-slate-300 bg-white'
          }"
        >
          <div class="flex flex-col sm:flex-row sm:items-start justify-between gap-2">
            <div class="space-y-1.5">
              <div class="flex flex-wrap items-center gap-2">
                <span class="text-sm sm:text-base font-extrabold text-slate-900">
                  ${rule.originMeta?.city}(${rule.origin}) ↔ ${rule.destMeta?.city}(${rule.destination})
                </span>
                <span class="text-xs px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 font-semibold">
                  ${rule.directOnly ? '직항' : '경유포함'} · 👨‍👩‍👧‍👦 ${pax.passengerSummaryText}
                </span>
                ${statusBadge}
                ${mixMatchBadge}
              </div>

              <div class="text-xs text-slate-500 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>📅 <b>${rule.departureDate} ~ ${rule.returnDate}</b></span>
                <span>📊 2년 최저가 <b>${formatKrw(b2y.lowest2YKrw)}</b> / 2년 평균가 <b>${formatKrw(b2y.avg2YKrw)}</b> (현재 평균 대비 <b>-${rule.discountRateVsMarket}%</b>)</span>
              </div>
            </div>

            <div class="text-left sm:text-right shrink-0">
              <div class="text-[11px] text-slate-400">성인 1인 편도합산 최저가 / 목표가</div>
              <div class="flex sm:justify-end items-baseline gap-1.5">
                <span class="text-xl font-extrabold ${isReached ? 'text-emerald-600' : 'text-slate-900'}">
                  ${formatKrw(rule.currentLowestPrice)}
                </span>
                <span class="text-xs text-slate-400 font-medium">/ ${formatKrw(rule.targetPrice)}</span>
              </div>
              <div class="text-xs font-bold text-sky-700 mt-0.5">
                총 인원(${pax.passengerSummaryText}) 합계: ${formatKrw(pax.totalPassengersPriceKrw)}
              </div>
            </div>
          </div>

          ${
            outLeg && inLeg
              ? `
            <div class="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2.5 bg-slate-50/90 rounded-xl p-3 border border-slate-200/80 text-xs">
              <div class="flex items-center justify-between bg-white p-2.5 rounded-lg border border-slate-200/70">
                <div>
                  <div class="text-[11px] font-bold text-sky-700">🛫 가는편 편도 최저가 (${rule.departureDate})</div>
                  <div class="font-extrabold text-slate-900 mt-0.5">${outLeg.airline} (${outLeg.flightNumber})</div>
                  <div class="text-[11px] text-slate-500">${outLeg.scheduleTime} · ${outLeg.baggageInfo}</div>
                </div>
                <div class="text-right space-y-0.5">
                  <div class="text-sm font-extrabold text-slate-900">${formatKrw(outLeg.oneWayPriceKrw)}</div>
                  <div class="flex items-center justify-end gap-1.5">
                    <a href="${rule.bookingLinks?.outboundNaverUrl || outLeg.naverOneWayUrl || '#'}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" class="text-[11px] text-sky-600 hover:underline font-bold">
                      네이버 편도 ↗
                    </a>
                    <span class="text-slate-300">·</span>
                    <a href="${rule.bookingLinks?.outboundAirlineOfficialUrl || outLeg.officialBookingUrl || '#'}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" class="text-[11px] text-slate-600 hover:underline font-semibold">
                      공식 홈페이지 ↗
                    </a>
                  </div>
                </div>
              </div>

              <div class="flex items-center justify-between bg-white p-2.5 rounded-lg border border-slate-200/70">
                <div>
                  <div class="text-[11px] font-bold text-indigo-700">🛬 오는편 편도 최저가 (${rule.returnDate})</div>
                  <div class="font-extrabold text-slate-900 mt-0.5">${inLeg.airline} (${inLeg.flightNumber})</div>
                  <div class="text-[11px] text-slate-500">${inLeg.scheduleTime} · ${inLeg.baggageInfo}</div>
                </div>
                <div class="text-right space-y-0.5">
                  <div class="text-sm font-extrabold text-slate-900">${formatKrw(inLeg.oneWayPriceKrw)}</div>
                  <div class="flex items-center justify-end gap-1.5">
                    <a href="${rule.bookingLinks?.inboundNaverUrl || inLeg.naverOneWayUrl || '#'}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" class="text-[11px] text-indigo-600 hover:underline font-bold">
                      네이버 편도 ↗
                    </a>
                    <span class="text-slate-300">·</span>
                    <a href="${rule.bookingLinks?.inboundAirlineOfficialUrl || inLeg.officialBookingUrl || '#'}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" class="text-[11px] text-slate-600 hover:underline font-semibold">
                      공식 홈페이지 ↗
                    </a>
                  </div>
                </div>
              </div>
            </div>
          `
              : ''
          }

          <div class="mt-3 pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2" onclick="event.stopPropagation()">
            <div class="flex flex-wrap items-center gap-1.5">
              <button
                onclick="handleCheckRule('${rule.id}', false)"
                class="text-xs px-2.5 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold transition"
              >
                🔍 편도조합 재조회
              </button>
              <button
                onclick="handleCheckRule('${rule.id}', true)"
                class="text-xs px-2.5 py-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 font-bold transition"
              >
                ⚡ 특가 급락 시뮬레이션 & 카톡 발송
              </button>
              <button
                onclick="handleManualNotify('${rule.id}')"
                class="text-xs px-2.5 py-1.5 rounded-lg kakao-yellow hover:brightness-95 font-bold transition"
              >
                💬 카톡 알림 보내기
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
                onclick="handleDeleteRule('${rule.id}')"
                class="text-xs px-2 py-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition"
                title="알림 삭제"
              >
                🗑️
              </button>
            </div>
          </div>
        </div>
      `;
    })
    .join('');
}

function selectRuleForChart(ruleId) {
  state.selectedRuleId = ruleId;
  renderWatchRules();
  renderPriceChart();
}

function renderPriceChart() {
  const rule = state.watchRules.find((r) => r.id === state.selectedRuleId) || state.watchRules[0];
  const ctx = document.getElementById('priceHistoryChart').getContext('2d');

  if (priceChartInstance) {
    priceChartInstance.destroy();
  }

  if (!rule) {
    document.getElementById('chartSubtitle').textContent = '등록된 노선이 없습니다.';
    document.getElementById('chartAiAdvice').textContent = '데이터 없음';
    return;
  }

  const histories = state.historiesByRule[rule.id] || [];
  const labels = histories.map((h) => formatDateTime(h.recordedAt));
  const prices = histories.map((h) => h.priceKrw);
  const targetLine = histories.map(() => rule.targetPrice);
  const avg2Y = rule.benchmark2Y?.avg2YKrw || rule.destMeta?.basePriceKrw || 280000;
  const avg2YLine = histories.map(() => avg2Y);

  document.getElementById('chartSubtitle').innerHTML = `<b>${rule.originMeta?.city}(${rule.origin}) ↔ ${rule.destMeta?.city}(${rule.destination})</b> (${rule.departureDate} ~ ${rule.returnDate}) 편도합산 가격 추이`;

  const adviceEl = document.getElementById('chartAiAdvice');
  if (rule.isTargetReached) {
    adviceEl.className = 'text-xs font-bold px-3 py-1.5 rounded-xl bg-emerald-100 text-emerald-800 border border-emerald-300';
    adviceEl.textContent = `✅ 매수 적기! 2년 평균(${formatKrw(avg2Y)}) 대비 -${rule.discountRateVsMarket}% 저렴합니다.`;
  } else {
    adviceEl.className = 'text-xs font-semibold px-3 py-1.5 rounded-xl bg-amber-50 text-amber-800 border border-amber-200';
    adviceEl.textContent = `⏳ 관망 추천: 목표가(${formatKrw(rule.targetPrice)}) 이하 도달 시 카톡 발송`;
  }

  priceChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: '편도합산 최저가 (성인 1인)',
          data: prices,
          borderColor: '#0284c7',
          backgroundColor: 'rgba(2, 132, 199, 0.12)',
          borderWidth: 2.5,
          pointRadius: 4,
          pointBackgroundColor: '#0284c7',
          fill: true,
          tension: 0.3
        },
        {
          label: '내 희망 목표가',
          data: targetLine,
          borderColor: '#10b981',
          borderWidth: 2,
          borderDash: [6, 6],
          pointRadius: 0,
          fill: false
        },
        {
          label: '지난 2년 평균 왕복가',
          data: avg2YLine,
          borderColor: '#94a3b8',
          borderWidth: 1.5,
          borderDash: [3, 3],
          pointRadius: 0,
          fill: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'top',
          labels: { font: { family: 'Pretendard', size: 11 } }
        },
        tooltip: {
          callbacks: {
            label: (context) => `${context.dataset.label}: ${formatKrw(context.parsed.y)}`
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
        : `<span class="text-sky-600 font-bold">편도조합 실시간 최저가 리포트</span>`;

    const totalPaxPrice = noti.totalPassengersPriceKrw || noti.notifiedPrice;
    const paxLabel = noti.passengerSummaryText || '성인 1명';

    previewContainer.innerHTML = `
      <div class="relative">
        <div class="h-28 bg-gradient-to-r from-sky-600 to-indigo-700 p-3.5 flex flex-col justify-between text-white">
          <div class="flex items-center justify-between">
            <span class="text-[11px] font-bold bg-black/25 px-2 py-0.5 rounded-full">SkyBell KR · 편도조합 알림</span>
            <span class="text-[11px] opacity-80">${formatDateTime(noti.sentAt)}</span>
          </div>
          <div>
            <div class="text-xs opacity-90">✈️ 출국·귀국 편도합산 최저가 발견</div>
            <div class="text-sm font-extrabold truncate">${noti.routeSummary}</div>
          </div>
        </div>

        <div class="p-3.5 space-y-2.5 text-xs">
          <div class="space-y-1.5 border-b border-slate-100 pb-2.5">
            <div class="flex justify-between gap-2">
              <span class="text-slate-400 shrink-0">일정 · 인원</span>
              <span class="font-semibold text-slate-700 text-right">${noti.scheduleSummary}</span>
            </div>
            <div class="flex justify-between gap-2">
              <span class="text-slate-400 shrink-0">편도 조합</span>
              <span class="font-semibold text-slate-800 text-right">${noti.airline}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-slate-400">성인 1인 합산</span>
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
          <div class="flex items-center justify-between">
            <span class="font-bold text-slate-800 truncate">${item.routeSummary}</span>
            <span class="text-[10px] px-1.5 py-0.5 rounded font-semibold ${
              isActualKakao ? 'bg-emerald-100 text-emerald-700' : 'kakao-yellow'
            }">
              ${isActualKakao ? '실제 카톡 전송됨' : '카드 프리뷰'}
            </span>
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
    const res = await apiFetch('/api/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '알림 등록 실패');

    state.selectedRuleId = data.rule.id;
    if (data.notificationResult) {
      state.selectedPreviewNoti = data.notificationResult;
      showToast('등록 즉시 목표가 이하 편도조합 특가가 발견되어 카카오톡 알림이 발송되었습니다!', '🎉');
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
  try {
    const res = await apiFetch('/api/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origin,
        destination,
        departureDate,
        returnDate,
        targetPrice,
        directOnly: true,
        adults,
        children,
        infants
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '알림 등록 실패');

    state.selectedRuleId = data.rule.id;
    if (data.notificationResult) {
      state.selectedPreviewNoti = data.notificationResult;
    }
    showToast(
      `${origin} ↔ ${destination} (${departureDate}~${returnDate}) 편도조합 노선이 알림 목록에 추가되었습니다!`,
      '✈️'
    );
    await loadDashboard();
  } catch (err) {
    showToast(err.message, '⚠️');
  }
}

async function handleCheckRule(ruleId, forceTargetHit = false) {
  try {
    showToast(
      forceTargetHit
        ? '⚡ 출국·귀국 편도 급락 특가를 시뮬레이션하고 카카오톡 알림을 발송합니다...'
        : '🔍 출국 편도와 귀국 편도 최저가를 각각 조회하여 합산 중입니다...',
      '✈️'
    );
    const res = await apiFetch(`/api/rules/${ruleId}/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ forceTargetHit, forceNotify: forceTargetHit })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '조회 실패');

    state.selectedRuleId = ruleId;
    if (data.notificationResult) {
      state.selectedPreviewNoti = data.notificationResult;
      showToast(
        `🎯 목표가 도달! 편도합산 ${formatKrw(data.offer.priceKrw)} 카카오톡 알림 발송 완료!`,
        '💬'
      );
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

async function handleDeleteRule(ruleId) {
  try {
    await apiFetch(`/api/rules/${ruleId}`, { method: 'DELETE' });
    if (state.selectedRuleId === ruleId) {
      state.selectedRuleId = null;
    }
    showToast('알림 규칙이 삭제되었습니다.', '🗑️');
    await loadDashboard();
  } catch (err) {
    showToast(err.message, '⚠️');
  }
}

async function handleBatchCheck() {
  const btn = document.getElementById('btnBatchCheck');
  btn.disabled = true;
  try {
    showToast('활성 노선 전체 편도조합 일괄 조회를 실행 중입니다...', '🔄');
    const res = await apiFetch('/api/batch-check', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '일괄 조회 실패');

    if (data.notificationsSent && data.notificationsSent.length > 0) {
      state.selectedPreviewNoti = data.notificationsSent[0];
    }
    showToast(
      `일괄 조회 완료! (${data.checkedGroups}개 고유 노선 조회 · 중복 호출 ${data.savedApiCalls}회 절약)`,
      '✅'
    );
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
