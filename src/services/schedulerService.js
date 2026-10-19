/**
 * 주기적 최저가 탐색 및 중복 노선 병합(Deduplication) 스케줄러 엔진 v2.0
 */

const { readDb, writeDb, generateId, buildWatchKey } = require('../storage/db');
const { fetchLowestRoundTripPrice, isSimulatedFareSource } = require('./flightApiService');
const { sendKakaoAlertMessage } = require('./kakaoService');

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

// 카카오톡 알림을 보내고 이력에 남긴다 (실패하면 오류를 그대로 던진다 — 부르는 쪽이 가격 저장과 따로 처리)
async function sendRuleNotification(db, rule, offer, nowIso) {
  const sent = await sendKakaoAlertMessage(
    rule,
    offer,
    db.settings,
    (refreshed) => {
      db.settings.kakaoAccessToken = refreshed.accessToken;
      db.settings.kakaoRefreshToken = refreshed.refreshToken;
      db.settings.kakaoTokenExpiresAt = refreshed.expiresAt;
    },
    db.customDestinations
  );
  rule.lastNotifiedAt = nowIso;
  const logItem = createNotificationLogEntry(rule.id, sent, nowIso);
  db.notificationLogs.unshift(logItem);
  return logItem;
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
  if (db.notificationLogs.length > 100) {
    db.notificationLogs = db.notificationLogs.slice(0, 100);
  }

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
 * 활성 규칙 일괄 조회 (3시간 주기 정기 조회·PIN 없는 일괄 조회 버튼)
 * 실제 운임으로 받아 온 규칙은 이 서버가 다시 받을 수 없어(PIN·키는 브라우저와 프록시에만) 건너뛴다 — 모의 가격으로 덮어쓰지 않는다
 */
async function runBatchPriceCheck() {
  const db = readDb();
  const activeRules = db.watchRules.filter((r) => r.isActive);
  const skippedRealFareRules = activeRules.filter(isRealFareRule).length;
  const simulatedRules = activeRules.filter((r) => !isRealFareRule(r));
  if (simulatedRules.length === 0) {
    return { checkedGroups: 0, totalActiveRules: activeRules.length, savedApiCalls: 0, notificationsSent: [], skippedRealFareRules };
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

  for (const [watchKey, groupRules] of groupedByWatchKey.entries()) {
    const representativeRule = groupRules[0];
    if (groupRules.length > 1) {
      const saved = (groupRules.length - 1) * 2;
      savedApiCalls += saved;
      db.apiQuotaStats.deduplicatedSavedCalls += saved;
    }

    const { offer, usedProvider } = await fetchLowestRoundTripPrice(representativeRule, db.settings, {
      customDestinations: db.customDestinations
    });
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

  db.apiQuotaStats.lastBatchRunAt = nowIso;
  writeDb(db);

  return {
    checkedGroups: groupedByWatchKey.size,
    totalActiveRules: activeRules.length,
    savedApiCalls,
    notificationsSent,
    skippedRealFareRules
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
  notificationErrorText
};
