/**
 * 주기적 최저가 탐색 및 중복 노선 병합(Deduplication) 스케줄러 엔진 v2.0
 */

const { readDb, writeDb, generateId, buildWatchKey } = require('../storage/db');
const { fetchLowestRoundTripPrice } = require('./flightApiService');
const { sendKakaoAlertMessage } = require('./kakaoService');

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
  rule.bookingLinks = offer.bookingLinks;
  rule.lastCheckedAt = nowIso;
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

async function checkSingleRule(ruleId, options = {}) {
  const { forceTargetHit = false, forceNotify = false } = options;
  const db = readDb();
  const rule = db.watchRules.find((r) => r.id === ruleId);
  if (!rule) {
    throw new Error('해당 알림 규칙을 찾을 수 없습니다.');
  }

  // 사용자가 추가한 도시(customDestinations)를 넘겨야 등록·귀국일표·차트와 같은 기준가로 계산된다
  const { offer, usedProvider } = await fetchLowestRoundTripPrice(rule, db.settings, {
    forceTargetHit,
    customDestinations: db.customDestinations
  });
  const nowIso = new Date().toISOString();

  if (usedProvider === 'AMADEUS') db.apiQuotaStats.amadeusCallsThisMonth += 2; // 편도 2회 호출
  else if (usedProvider === 'TRAVELPAYOUTS') db.apiQuotaStats.travelpayoutsCallsThisMonth += 1;
  else db.apiQuotaStats.simulationCallsThisMonth += 2;

  const watchKey = rule.watchKey || buildWatchKey(rule);
  const matchingRules = db.watchRules.filter((r) => (r.watchKey || buildWatchKey(r)) === watchKey);
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
  const isTargetReached = offer.priceKrw <= rule.targetPrice;

  if (forceNotify || (isTargetReached && db.settings.autoNotifyOnTarget)) {
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
    notificationResult = logItem;
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
    notificationResult
  };
}

async function runBatchPriceCheck() {
  const db = readDb();
  const activeRules = db.watchRules.filter((r) => r.isActive);
  if (activeRules.length === 0) {
    return { checkedGroups: 0, totalActiveRules: 0, savedApiCalls: 0, notificationsSent: [] };
  }

  const groupedByWatchKey = new Map();
  for (const rule of activeRules) {
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
    if (usedProvider === 'AMADEUS') db.apiQuotaStats.amadeusCallsThisMonth += 2;
    else if (usedProvider === 'TRAVELPAYOUTS') db.apiQuotaStats.travelpayoutsCallsThisMonth += 1;
    else db.apiQuotaStats.simulationCallsThisMonth += 2;

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
      const cooldownMs = (db.settings.cooldownHours || 12) * 3600000;
      const recentlyNotified =
        rule.lastNotifiedAt && Date.now() - new Date(rule.lastNotifiedAt).getTime() < cooldownMs;

      if (isTargetReached && db.settings.autoNotifyOnTarget && !recentlyNotified) {
        try {
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
          notificationsSent.push(logItem);
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
  repriceMigratedRules
};
