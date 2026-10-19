/**
 * 메뉴별 조회 · 전체 조회 (app.js · realFares.js 와 같은 전역 범위에서 돈다)
 * - 메뉴 머리글의 '🔍 조회' 는 그 메뉴 값만 다시 불러온다 (머리글을 눌러 접고 펴는 것과 따로)
 * - 접혀 있으면 펼쳐서 결과를 보여 준다. 노선·인원 설정은 결과가 다른 메뉴(시세표·탐색기·가격 추이)에 나오므로 그대로 둔다
 * - 알림 목록의 조회 = 알림 일괄 조회 (실제 운임 모드면 구글 플라이트 검색 횟수를 확인 창으로 먼저 묻는다)
 * - 머리글 '전체 조회' = 알림 일괄 조회 + 모든 메뉴 값 (메뉴는 펼치지 않는다)
 * - 로더는 실패해도 스스로 삼키고(오류 칸·모의 가격 대체) 끝나므로, 끝난 뒤 그 흔적을 찾아 ✅ 대신 ⚠️ 로 알린다
 */

function fallbackProblem(name, data) {
  return data?.realFareFallback ? `${name}: ${data.realFareFallback} → 모의 가격` : '';
}

// 로더가 삼킨 실패·모의 가격 대체의 흔적 (없으면 '')
const MENU_PROBLEM_CHECKS = {
  benchmark: () => (isRealFareActive('travelpayouts') && realBenchmark.error ? `시세표: ${realBenchmark.error} → 모의 시세` : ''),
  top30: () => fallbackProblem('TOP 30', state.anywhereTop10Data),
  matrix: () => fallbackProblem('귀국일 가격표', state.returnMatrixData),
  recommend: () => fallbackProblem('추천 일정', state.scheduleRecommendData),
  trend: () => (state.routeTrendError ? `가격 추이: ${state.routeTrendError}` : fallbackProblem('가격 추이', state.routeTrendData)),
  flex: () => (state.flexDealsData?.error ? `±3일 최저가: ${state.flexDealsData.error}` : fallbackProblem('±3일 최저가', state.flexDealsData))
};
const ROUTE_MENU_CHECKS = ['benchmark', 'top30', 'matrix', 'recommend', 'trend', 'flex'];

// run 은 화살표로 감싸 누를 때의 함수를 부른다 (다른 파일·시험이 함수를 바꿔 끼워도 따라가게)
const SECTION_REFRESHERS = {
  sectionKpi: { label: '모니터링 요약 지표', run: () => loadDashboard() },
  sectionSearchForm: {
    label: '선택 노선(±3일 최저가·시세표·탐색기·가격 추이)',
    run: () => refreshFormRouteMenus(),
    keepCollapsed: true,
    checks: ROUTE_MENU_CHECKS
  },
  sectionBenchmark2Y: { label: '시세 기준표', run: () => refreshBenchmarkPanel(), checks: ['benchmark'] },
  sectionExplorer: {
    label: '일정 탐색기(TOP 30·귀국일 가격표·추천 일정)',
    run: () => refreshExplorerTabs(),
    checks: ['top30', 'matrix', 'recommend']
  },
  // 알림 일괄 조회는 진행·결과를 스스로 알린다
  sectionWatchlist: { label: '알림 목록', run: () => handleBatchCheck(), announcesItself: true },
  sectionPriceChart: { label: '가격 추이 차트', run: () => loadRoutePriceTrend(), checks: ['trend'] },
  sectionKakaoPreview: { label: '카카오톡 알림 이력', run: () => loadDashboard() }
};

const SECTION_REFRESH_IDLE_TEXT = '🔍 조회';
const SECTION_REFRESH_BUSY_TEXT = '⏳ 조회 중';
const sectionRefreshBusy = {};
let refreshAllRunning = false;

function collectMenuProblems(checkNames = []) {
  return checkNames.map((name) => MENU_PROBLEM_CHECKS[name]()).filter(Boolean);
}

function problemsText(problems) {
  return problems.length > 1 ? `${problems[0]} 외 ${problems.length - 1}건` : problems[0];
}

// 실패하면 그 오류를, 성공하면 null 을 돌려준다
function settle(promise) {
  return promise.then(
    () => null,
    (err) => err
  );
}

// 여러 조회를 함께 돌리고 (하나가 실패해도 나머지는 끝까지) 실패가 있으면 첫 이유로 알린다
async function runLoadersSettled(loaders) {
  const results = await Promise.allSettled(loaders.map((load) => Promise.resolve().then(() => load())));
  const failures = results.filter((r) => r.status === 'rejected').map((r) => r.reason);
  failures.forEach((reason) => console.error('메뉴 조회 실패:', reason));
  if (failures.length > 0) throw new Error(failures[0]?.message || '조회 실패');
}

// 시세표: 실제 운임 모드면 저장해 둔 결과를 버리고 지금 노선을 다시 받아 온다 (접혀 있으면 펼칠 때 받아 온다)
function refreshBenchmarkPanel() {
  if (isRealFareActive('travelpayouts')) resetRealBenchmark();
  return renderBenchmark2YPanel();
}

function refreshExplorerTabs() {
  return runLoadersSettled([loadAnywhereTop10, loadReturnDateMatrix, loadScheduleRecommendations]);
}

// 노선·인원 설정의 조회: 지금 고른 출발·도착·날짜·인원으로 노선별 메뉴를 모두 다시 불러온다
// (±3일 최저가 목록은 떠 있을 때만 그때 찾은 조건으로 다시 찾는다 — 새 조건은 폼의 '±3일 최저가 찾기')
function refreshFormRouteMenus() {
  syncAnywhereOriginToForm();
  updatePassengerTotalPreview();
  return runLoadersSettled([
    refreshBenchmarkPanel,
    loadAnywhereTop10,
    loadReturnDateMatrix,
    loadScheduleRecommendations,
    syncPriceChartToForm,
    refreshFlexDealsIfShown
  ]);
}

// 버튼은 아이콘(휴대폰 폭에서는 숨김)과 글자를 따로 바꾼다 — 두 칸이 없으면 글자 전체를 바꾼다
function setSectionRefreshButtonBusy(sectionId, busy) {
  const btn = document.getElementById(`btnRefresh_${sectionId}`);
  if (!btn) return;
  btn.disabled = busy;
  btn.setAttribute('aria-busy', busy ? 'true' : 'false');
  const icon = btn.querySelector('[data-refresh-icon]');
  const label = btn.querySelector('[data-refresh-label]');
  if (icon && label) {
    icon.textContent = busy ? '⏳' : '🔍';
    label.textContent = busy ? '조회 중' : '조회';
    return;
  }
  btn.textContent = busy ? SECTION_REFRESH_BUSY_TEXT : SECTION_REFRESH_IDLE_TEXT;
}

async function refreshSection(sectionId) {
  const refresher = SECTION_REFRESHERS[sectionId];
  if (!refresher || sectionRefreshBusy[sectionId]) return;
  sectionRefreshBusy[sectionId] = true;
  setSectionRefreshButtonBusy(sectionId, true);
  const fareModeBefore = realFareState.enabled;
  try {
    if (!refresher.keepCollapsed && state.collapsedSections[sectionId]) {
      toggleSectionCollapse(sectionId, true);
    }
    await refresher.run();
    // 조회 중 PIN 이 바뀌어 모의 가격으로 돌아갔으면 그 안내를 덮지 않는다
    if (refresher.announcesItself || realFareState.enabled !== fareModeBefore) return;
    const problems = collectMenuProblems(refresher.checks);
    if (problems.length > 0) {
      showToast(`${refresher.label} 조회 문제 · ${problemsText(problems)}`, '⚠️');
    } else {
      showToast(`${refresher.label} 조회 완료`, '✅');
    }
  } catch (err) {
    showToast(`${refresher.label} 조회 실패: ${err?.message || err}`, '⚠️');
  } finally {
    sectionRefreshBusy[sectionId] = false;
    setSectionRefreshButtonBusy(sectionId, false);
  }
}

/**
 * 머리글 '전체 조회': 메뉴 값을 다시 불러오기 시작한 채로 알림 일괄 조회를 돌린다
 * (실제 운임 모드의 확인 창이 메뉴 조회를 기다리지 않고 바로 뜨게) → 끝나면 결과를 한 번에 알린다
 */
async function refreshAllSections() {
  if (refreshAllRunning) return;
  refreshAllRunning = true;
  const btn = document.getElementById('btnBatchCheck');
  if (btn) btn.disabled = true;
  const fareModeBefore = realFareState.enabled;
  try {
    const menus = settle(
      runLoadersSettled([
        refreshBenchmarkPanel,
        loadAnywhereTop10,
        loadReturnDateMatrix,
        loadScheduleRecommendations,
        loadRoutePriceTrend,
        refreshFlexDealsIfShown
      ])
    );
    // 이미 돌고 있던 일괄 조회면 그 결과를 함께 기다린다 (app.js handleBatchCheck)
    const batch = await handleBatchCheck();
    // 일괄 조회가 요약 지표·알림 이력을 이미 다시 불러왔으면 또 부르지 않는다 (취소·실패면 여기서 한 번)
    const dashboardError = batch?.dashboardReloaded ? null : await settle(runLoadersSettled([loadDashboard]));
    const loaderError = (await menus) || dashboardError;
    if (realFareState.enabled !== fareModeBefore) return; // PIN 이 바뀌어 모의 가격으로 돌아간 안내를 덮지 않는다
    const problems = loaderError ? [loaderError.message] : collectMenuProblems(ROUTE_MENU_CHECKS);
    const parts = ['전체 조회 완료', problems.length > 0 ? `메뉴 문제 · ${problemsText(problems)}` : '모든 메뉴 다시 불러옴'];
    if (batch?.message) parts.push(batch.message);
    showToast(parts.join(' · '), problems.length > 0 ? '⚠️' : batch?.icon || '✅');
  } finally {
    refreshAllRunning = false;
    if (btn) btn.disabled = false;
  }
}
