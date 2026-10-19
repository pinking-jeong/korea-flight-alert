/**
 * 주기적 최저가 탐색 및 중복 노선 병합(Deduplication) 스케줄러 엔진 v2.0
 */

const { readDb, writeDb, generateId, buildWatchKey } = require('../storage/db');
const { fetchLowestRoundTripPrice, isSimulatedFareSource } = require('./flightApiService');
const { sendKakaoAlertMessage, sendKakaoTargetAlertMessage } = require('./kakaoService');
const {
  runTargetScan,
  applyTargetScan,
  shouldNotifyTargetAlert,
  markTargetAlertNotified,
  targetAlertLogEntry,
  isRealFareTargetAlert
} = require('./targetAlerts');

const MAX_NOTIFICATION_LOGS = 100;
const FAILURE_REASON_MAX_CHARS = 120; // 일괄 조회 결과에 싣는 첫 실패 이유 (외부 API 응답 본문이 길게 붙어도 토스트가 넘치지 않게)

// 실제 운임(구글 플라이트 실시간·최근 검색가)으로 받아 온 규칙 — PIN 이 있는 브라우저만 다시 조회할 수 있다
function isRealFareRule(rule) {
  return !isSimulatedFareSource(rule?.sourceApi);
}

function realFareNeedsPinError() {
  const err = new Error('실제 운임으로 받아 온 알림이라 모의 가격으로 덮어쓰지 않았습니다. PIN 을 넣으면 실제 운임으로 다시 조회합니다.');
  err.code = 'REAL_FARE_NEEDS_PIN';
  return err;
}

function isRecentlyNotified(rule, settings, nowMs = Date.now()) {
  const cooldownMs = (settings.cooldownHours || 12) * 3600000;
  return Boolean(rule.lastNotifiedAt) && nowMs - new Date(rule.lastNotifiedAt).getTime() < cooldownMs;
}

// 카카오 토큰이 발송 중에 갱신되면 저장소 설정에 남긴다
function saveRefreshedKakaoToken(db) {
  return (refreshed) => {
    db.settings.kakaoAccessToken = refreshed.accessToken;
    db.settings.kakaoRefreshToken = refreshed.refreshToken;
    db.settings.kakaoTokenExpiresAt = refreshed.expiresAt;
  };
}

// 카카오톡 알림을 보내고 이력에 남긴다 (실패하면 오류를 그대로 던진다 — 부르는 쪽이 가격 저장과 따로 처리)
async function sendRuleNotification(db, rule, offer, nowIso) {
  const sent = await sendKakaoAlertMessage(rule, offer, db.settings, saveRefreshedKakaoToken(db), db.customDestinations);
  rule.lastNotifiedAt = nowIso;
  const logItem = createNotificationLogEntry(rule.id, sent, nowIso);
  db.notificationLogs.unshift(logItem);
  return logItem;
}

function trimNotificationLogs(db) {
  if (db.notificationLogs.length > MAX_NOTIFICATION_LOGS) {
    db.notificationLogs = db.notificationLogs.slice(0, MAX_NOTIFICATION_LOGS);
  }
}

// 저장소의 목표가 알림을 새 값으로 바꾼다 (없던 알림이면 맨 앞에 넣는다)
function storeTargetAlert(db, alert) {
  const idx = db.targetAlerts.findIndex((a) => a.id === alert.id);
  if (idx >= 0) db.targetAlerts[idx] = alert;
  else db.targetAlerts.unshift(alert);
}

/**
 * 목표가 알림 카카오톡을 보내고 이력에 남긴다 (실패하면 오류를 그대로 던진다)
 * 반환: { alert: 알린 값이 기록된 새 알림, logItem }
 */
async function sendTargetAlertNotification(db, alert, nowIso) {
  const sent = await sendKakaoTargetAlertMessage(alert, db.settings, saveRefreshedKakaoToken(db), db.customDestinations);
  const logItem = targetAlertLogEntry(alert.id, sent, {
    id: generateId('noti'),
    sentAt: nowIso,
    channel: sent.channel,
    status: sent.status,
    detail: sent.detail
  });
  db.notificationLogs.unshift(logItem);
  trimNotificationLogs(db);
  return { alert: markTargetAlertNotified(alert, nowIso), logItem };
}

/**
 * 목표가 알림 한 건을 훑어 저장소의 그 알림을 바꾸고, 새로 알릴 것이 있으면 카카오톡을 보낸다 (db 를 직접 고치며 쓰기는 부르는 쪽)
 * - scanResult: 브라우저가 프록시(Travelpayouts 최근 검색가)에서 받아 온 결과. 없으면 모의 가격 엔진
 *   (실제 운임 알림을 결과 없이 부르면 REAL_FARE_NEEDS_PIN · 결과의 출처가 다르면 BAD_FARE_SOURCE 를 던지고 저장소는 그대로)
 * - 카카오톡이 실패해도 훑은 결과는 남긴다 (notificationError)
 */
async function refreshTargetAlert(db, alert, { scanResult = null, nowIso = new Date().toISOString() } = {}) {
  const scan = runTargetScan(alert, { scanResult, customDestinations: db.customDestinations });
  let updated = applyTargetScan(alert, scan, nowIso);
  let notificationResult = null;
  let notificationError = null;
  if (shouldNotifyTargetAlert(updated, { settings: db.settings, nowMs: Date.parse(nowIso) })) {
    try {
      const sent = await sendTargetAlertNotification(db, updated, nowIso);
      updated = sent.alert;
      notificationResult = sent.logItem;
    } catch (err) {
      notificationError = notificationErrorText(err);
      console.error('[TargetAlert] 카카오톡 알림 전송 오류:', err.message);
    }
  }
  storeTargetAlert(db, updated);
  return { alert: updated, scan, notificationResult, notificationError };
}

// 목표가 알림 카카오톡을 지금 보낸다 (알림 카드의 '💬 카톡 발송' — 마지막으로 훑은 결과로)
async function notifyTargetAlertNow(db, alert, nowIso = new Date().toISOString()) {
  const sent = await sendTargetAlertNotification(db, alert, nowIso);
  storeTargetAlert(db, sent.alert);
  return sent.logItem;
}

function notificationErrorText(err) {
  return `카카오톡 알림 전송 실패: ${err?.message || '알 수 없는 오류'}`;
}

function applyOfferToRule(rule, offer, nowIso) {
  rule.previousPrice = rule.currentLowestPrice || offer.priceKrw;
  rule.currentLowestPrice = offer.priceKrw;
  rule.sameAirlineBundledPriceKrw = offer.sameAirlineBundledPriceKrw;
  rule.mixMatchSavingsKrw = offer.mixMatchSavingsKrw;
  rule.isDifferentAirlineCombo = offer.isDifferentAirlineCombo;
  rule.outboundLeg = offer.outboundLeg;
  rule.inboundLeg = offer.inboundLeg;
  rule.latestAirline = offer.airline;
  rule.latestAirlineCode = offer.airlineCode;
  rule.flightNumber = offer.flightNumber;
  rule.baggageInfo = offer.baggageInfo;
  rule.departureTime = offer.departureTime;
  rule.returnTime = offer.returnTime;
  rule.sourceApi = offer.sourceApi;
  rule.fareFetchedAt = offer.fareFetchedAt || null;
  rule.bookingLinks = offer.bookingLinks;
  rule.lastCheckedAt = nowIso;
}

// 조회 횟수 통계: 실제 운임은 브라우저가 프록시에서 받아 온 것이라 이 서버의 API 호출은 아니지만 출처별로 센다
function countFareLookup(db, usedProvider) {
  const stats = db.apiQuotaStats;
  if (usedProvider === 'AMADEUS') stats.amadeusCallsThisMonth += 2; // 편도 2회 호출
  else if (usedProvider === 'TRAVELPAYOUTS') stats.travelpayoutsCallsThisMonth += 1;
  else if (usedProvider === 'SERPAPI') stats.serpapiSearchesThisMonth = (stats.serpapiSearchesThisMonth || 0) + 2;
  else stats.simulationCallsThisMonth += 2;
}

function createNotificationLogEntry(ruleId, sent, nowIso) {
  return {
    id: generateId('noti'),
    ruleId,
    routeSummary: sent.routeSummary,
    scheduleSummary: sent.scheduleSummary,
    airline: sent.airline,
    outboundLeg: sent.outboundLeg,
    inboundLeg: sent.inboundLeg,
    notifiedPrice: sent.notifiedPrice,
    totalPassengersPriceKrw: sent.totalPassengersPriceKrw,
    passengerSummaryText: sent.passengerSummaryText,
    isSimulatedPrice: sent.isSimulatedPrice !== false,
    fareKind: sent.fareKind || (sent.isSimulatedPrice === false ? 'LIVE' : 'SIMULATED'),
    targetPrice: sent.targetPrice,
    savedAmount: sent.savedAmount,
    mixMatchSavingsKrw: sent.mixMatchSavingsKrw,
    channel: sent.channel,
    status: sent.status,
    detail: sent.detail,
    bookingUrl: sent.bookingUrl,
    outboundBookingUrl: sent.outboundBookingUrl,
    inboundBookingUrl: sent.inboundBookingUrl,
    messagePreview: sent.messagePreview,
    templateObject: sent.templateObject,
    sentAt: nowIso
  };
}

/**
 * 규칙 하나를 다시 조회한다
 * - externalCandidates: 브라우저가 프록시에서 받아 온 실제 운임 후보 (없으면 모의 가격 엔진)
 * - respectCooldown: 일괄 조회에서 부를 때 — 정기 조회와 같이 알림 간격(cooldownHours)을 지킨다
 */
async function checkSingleRule(ruleId, options = {}) {
  const { forceTargetHit = false, forceNotify = false, externalCandidates = null, respectCooldown = false } = options;
  const db = readDb();
  const rule = db.watchRules.find((r) => r.id === ruleId);
  if (!rule) {
    throw new Error('해당 알림 규칙을 찾을 수 없습니다.');
  }
  // 실제 운임 규칙을 실제 운임 후보 없이 계산하면 모의 가격으로 덮어쓰게 된다 (급락 시뮬레이션은 사용자가 고른 모의 동작이라 예외)
  if (!externalCandidates && !forceTargetHit && isRealFareRule(rule)) {
    throw realFareNeedsPinError();
  }

  // 사용자가 추가한 도시(customDestinations)를 넘겨야 등록·귀국일표·차트와 같은 기준가로 계산된다
  // 실제 운임 후보도 규칙에 저장된 출발 공항(전국 통합 등록이면 그때 정해진 공항) 기준으로만 받는다
  const { offer, usedProvider } = await fetchLowestRoundTripPrice(rule, db.settings, {
    forceTargetHit,
    customDestinations: db.customDestinations,
    externalCandidates
  });
  const nowIso = new Date().toISOString();

  countFareLookup(db, usedProvider);

  // 같은 조건의 규칙에 결과를 함께 씌우되, 모의 가격은 다른 실제 운임 규칙에 씌우지 않는다
  const watchKey = rule.watchKey || buildWatchKey(rule);
  const offerIsSimulated = isSimulatedFareSource(offer.sourceApi);
  const matchingRules = db.watchRules.filter(
    (r) => (r.watchKey || buildWatchKey(r)) === watchKey && (r.id === rule.id || !offerIsSimulated || !isRealFareRule(r))
  );
  if (matchingRules.length > 1) {
    db.apiQuotaStats.deduplicatedSavedCalls += (matchingRules.length - 1) * 2;
  }

  for (const r of matchingRules) {
    applyOfferToRule(r, offer, nowIso);
    db.priceHistories.push({
      id: generateId('ph'),
      ruleId: r.id,
      watchKey,
      priceKrw: offer.priceKrw,
      airline: offer.airline,
      flightNumber: offer.flightNumber,
      sourceApi: offer.sourceApi,
      recordedAt: nowIso
    });
  }

  let notificationResult = null;
  let notificationError = null;
  const isTargetReached = offer.priceKrw <= rule.targetPrice;
  const cooledDown = !respectCooldown || !isRecentlyNotified(rule, db.settings);

  if (forceNotify || (isTargetReached && db.settings.autoNotifyOnTarget && cooledDown)) {
    try {
      notificationResult = await sendRuleNotification(db, rule, offer, nowIso);
    } catch (err) {
      // 알림이 실패해도 받아 온 가격은 저장한다 (실제 운임은 다시 받으려면 검색 횟수를 또 쓴다)
      notificationError = notificationErrorText(err);
      console.error('[Scheduler] 카카오톡 알림 전송 오류:', err.message);
    }
  }

  if (db.priceHistories.length > 300) {
    db.priceHistories = db.priceHistories.slice(-300);
  }
  trimNotificationLogs(db);

  writeDb(db);
  return {
    rule,
    offer,
    usedProvider,
    isTargetReached,
    notificationResult,
    notificationError
  };
}

/**
 * 활성 규칙·목표가 알림 일괄 조회 (3시간 주기 정기 조회·PIN 없는 일괄 조회 버튼)
 * 실제 운임으로 받아 온 규칙·목표가 알림은 이 서버가 다시 받을 수 없어(PIN·키는 브라우저와 프록시에만) 건너뛴다 — 모의 가격으로 덮어쓰지 않는다
 */
async function runBatchPriceCheck() {
  const db = readDb();
  const activeRules = db.watchRules.filter((r) => r.isActive);
  const skippedRealFareRules = activeRules.filter(isRealFareRule).length;
  const simulatedRules = activeRules.filter((r) => !isRealFareRule(r));
  const activeTargetAlerts = db.targetAlerts.filter((a) => a.isActive !== false);
  const simulatedTargetAlerts = activeTargetAlerts.filter((a) => !isRealFareTargetAlert(a));
  const summaryBase = {
    totalActiveRules: activeRules.length,
    skippedRealFareRules,
    skippedRealFareTargetAlerts: activeTargetAlerts.length - simulatedTargetAlerts.length
  };
  if (simulatedRules.length === 0 && simulatedTargetAlerts.length === 0) {
    return {
      ...summaryBase,
      checkedGroups: 0,
      failedGroups: 0,
      checkedTargetAlerts: 0,
      failedTargetAlerts: 0,
      failureReason: null,
      savedApiCalls: 0,
      notificationsSent: []
    };
  }

  const groupedByWatchKey = new Map();
  for (const rule of simulatedRules) {
    const key = rule.watchKey || buildWatchKey(rule);
    rule.watchKey = key;
    if (!groupedByWatchKey.has(key)) {
      groupedByWatchKey.set(key, []);
    }
    groupedByWatchKey.get(key).push(rule);
  }

  const nowIso = new Date().toISOString();
  let savedApiCalls = 0;
  const notificationsSent = [];
  // 실패는 건너뛰되 수와 첫 이유를 돌려준다 — 화면이 '완료' 대신 ⚠️ 로 알리게
  let checkedGroups = 0;
  let failedGroups = 0;
  let failureReason = null;
  const noteFailure = (err) => {
    failureReason = failureReason || String(err?.message || err).slice(0, FAILURE_REASON_MAX_CHARS);
  };

  for (const [watchKey, groupRules] of groupedByWatchKey.entries()) {
    const representativeRule = groupRules[0];
    // 한 노선의 조회가 실패해도(예: 외부 API 장애) 나머지 노선과 목표가 알림은 계속 훑는다
    let priced;
    try {
      priced = await fetchLowestRoundTripPrice(representativeRule, db.settings, {
        customDestinations: db.customDestinations
      });
    } catch (err) {
      console.error(`[Scheduler] ${watchKey} 조회 오류:`, err.message);
      failedGroups += 1;
      noteFailure(err);
      continue;
    }
    checkedGroups += 1;
    const { offer, usedProvider } = priced;
    if (groupRules.length > 1) {
      const saved = (groupRules.length - 1) * 2;
      savedApiCalls += saved;
      db.apiQuotaStats.deduplicatedSavedCalls += saved;
    }
    countFareLookup(db, usedProvider);

    for (const rule of groupRules) {
      applyOfferToRule(rule, offer, nowIso);

      db.priceHistories.push({
        id: generateId('ph'),
        ruleId: rule.id,
        watchKey,
        priceKrw: offer.priceKrw,
        airline: offer.airline,
        flightNumber: offer.flightNumber,
        sourceApi: offer.sourceApi,
        recordedAt: nowIso
      });

      const isTargetReached = offer.priceKrw <= rule.targetPrice;
      if (isTargetReached && db.settings.autoNotifyOnTarget && !isRecentlyNotified(rule, db.settings)) {
        try {
          notificationsSent.push(await sendRuleNotification(db, rule, offer, nowIso));
        } catch (err) {
          console.error('[Scheduler] 카카오톡 알림 전송 오류:', err.message);
        }
      }
    }
  }

  // 목표가 알림: 기간 안의 출발일을 하루씩 다시 훑는다 (한 건이 실패해도 나머지는 계속)
  let checkedTargetAlerts = 0;
  let failedTargetAlerts = 0;
  for (const alert of simulatedTargetAlerts) {
    try {
      const result = await refreshTargetAlert(db, alert, { nowIso });
      checkedTargetAlerts += 1;
      if (result.notificationResult) notificationsSent.push(result.notificationResult);
    } catch (err) {
      console.error(`[Scheduler] 목표가 알림 ${alert.id} 조회 오류:`, err.message);
      failedTargetAlerts += 1;
      noteFailure(err);
    }
  }

  db.apiQuotaStats.lastBatchRunAt = nowIso;
  trimNotificationLogs(db);
  writeDb(db);

  return {
    ...summaryBase,
    checkedGroups,
    failedGroups,
    checkedTargetAlerts,
    failedTargetAlerts,
    failureReason,
    savedApiCalls,
    notificationsSent
  };
}

/**
 * 스키마 v3 저장소에서 옮겨 온 규칙(needsReprice)은 이전 엔진의 무작위 변동이 섞인 가격을 갖고 있어
 * 차트·귀국일표 가격과 어긋나므로, 첫 조회 때 한 번 현재 엔진 가격으로 맞춘다.
 * 알림·가격 이력은 만들지 않고 이전 가격 기록(previousPrice)도 그대로 둔다. db를 직접 고치며 맞춘 규칙 수를 돌려준다.
 */
async function repriceMigratedRules(db) {
  const pending = db.watchRules.filter((r) => r.needsReprice);
  const nowIso = new Date().toISOString();
  for (const rule of pending) {
    try {
      const { offer } = await fetchLowestRoundTripPrice(rule, db.settings, { customDestinations: db.customDestinations });
      const { previousPrice } = rule;
      applyOfferToRule(rule, offer, nowIso);
      rule.previousPrice = previousPrice;
    } catch (err) {
      console.warn(`[Migration] ${rule.id} 가격 재계산 실패, 저장된 가격 유지:`, err.message);
    }
    delete rule.needsReprice;
  }
  return pending.length;
}

module.exports = {
  checkSingleRule,
  runBatchPriceCheck,
  createNotificationLogEntry,
  repriceMigratedRules,
  countFareLookup,
  sendRuleNotification,
  notificationErrorText,
  refreshTargetAlert,
  notifyTargetAlertNow
};
