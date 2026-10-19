require('dotenv').config();
const path = require('path');
const express = require('express');
const cron = require('node-cron');

const {
  KOREAN_ORIGIN_AIRPORTS,
  INTERNATIONAL_DESTINATIONS,
  makeDest,
  getDestinationByCode,
  buildBookingLinks
} = require('./config/airports');
const {
  readDb,
  writeDb,
  generateId,
  buildWatchKey,
  enrichRule
} = require('./storage/db');
const {
  fetchLowestRoundTripPrice,
  getReturnDatePriceMatrix,
  getRecommendedCheapSchedules,
  getAnywhereTop10Next6Months,
  getCuratedKoreanDeals,
  getRoutePriceTrend
} = require('./services/flightApiService');
const {
  getKakaoAuthorizeUrl,
  exchangeCodeForTokens,
  sendKakaoAlertMessage
} = require('./services/kakaoService');
const {
  checkSingleRule,
  runBatchPriceCheck,
  createNotificationLogEntry,
  repriceMigratedRules,
  countFareLookup,
  sendRuleNotification,
  notificationErrorText
} = require('./services/schedulerService');

const app = express();
const PORT = process.env.PORT || 3000;

// 브라우저가 보낸 실제 운임 후보가 쓸 수 없는 값이면 서버 오류(500)가 아니라 요청 문제(422)로 답한다
const REAL_FARE_INPUT_ERRORS = ['NO_REAL_FARES', 'BAD_FARE_SOURCE'];
// 실제 운임 규칙을 PIN(실제 운임 후보) 없이 다시 조회하려 함 → 모의 가격으로 덮어쓰지 않고 409
const REAL_FARE_CONFLICT_ERRORS = ['REAL_FARE_NEEDS_PIN'];

function errorStatusOf(err) {
  if (REAL_FARE_INPUT_ERRORS.includes(err?.code)) return 422;
  if (REAL_FARE_CONFLICT_ERRORS.includes(err?.code)) return 409;
  return 500;
}

// 화면이 경우를 나눠 처리하도록 위 오류는 코드도 함께 보낸다
function errorBodyOf(err) {
  const known = [...REAL_FARE_INPUT_ERRORS, ...REAL_FARE_CONFLICT_ERRORS].includes(err?.code);
  return known ? { error: err.message, code: err.code } : { error: err.message };
}

// 화면(public/)은 이 서버가 같은 출처로 제공하므로 CORS 허용 헤더를 두지 않는다.
// (모든 출처 허용이면 다른 사이트가 열린 탭에서 일괄 삭제·설정 변경 API를 부를 수 있음)
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

/**
 * 1. 공항 메타데이터(기본 60개+ 도시 & 사용자 직접 추가 도시 포함) 및 오늘의 한국발 특가 조회
 */
app.get('/api/meta', (req, res) => {
  const db = readDb();
  const customList = db.customDestinations || [];
  const mergedDestinations = [...INTERNATIONAL_DESTINATIONS, ...customList];

  res.json({
    origins: KOREAN_ORIGIN_AIRPORTS,
    destinations: mergedDestinations,
    customDestinations: customList,
    curatedDeals: getCuratedKoreanDeals()
  });
});

/**
 * 1-A. 사용자 직접 입력(Custom) 도시/공항 영구 추가 API
 */
app.post('/api/custom-destinations', (req, res) => {
  try {
    const {
      code,
      city,
      country = '해외',
      region = '기타',
      avg2YKrw = 420000
    } = req.body || {};

    const cleanCode = String(code || '').trim().toUpperCase();
    const cleanCity = String(city || '').trim();

    if (!cleanCode || cleanCode.length < 3 || !cleanCity) {
      return res.status(400).json({ error: '3자리 공항 코드(IATA, 예: HEL)와 도시명(예: 헬싱키)을 모두 입력해 주세요.' });
    }

    const db = readDb();
    if (!Array.isArray(db.customDestinations)) {
      db.customDestinations = [];
    }

    const existsInPreset = INTERNATIONAL_DESTINATIONS.find((d) => d.code === cleanCode);
    if (existsInPreset) {
      return res.json({ destination: existsInPreset, alreadyExisted: true });
    }

    const existingIdx = db.customDestinations.findIndex((d) => d.code === cleanCode);
    const createdDest = makeDest({
      code: cleanCode,
      city: cleanCity,
      country: String(country || '해외').trim(),
      region: String(region || '기타').trim(),
      avg2YKrw: Math.max(100000, Number(avg2YKrw) || 420000),
      flightDuration: '직접 등록 노선'
    });

    if (existingIdx >= 0) {
      db.customDestinations[existingIdx] = createdDest;
    } else {
      db.customDestinations.push(createdDest);
    }

    writeDb(db);
    res.status(201).json({
      destination: createdDest,
      customDestinations: db.customDestinations
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 1-B. [신규 핵심 기능] 도시를 지정하지 않고 향후 6개월(180일) 이내 저렴한 항공편 TOP 10 / TOP 20 / TOP 30 선정 API
 */
app.get('/api/anywhere-top10', (req, res) => {
  try {
    const {
      origin = 'ICN',
      region = 'ALL',
      sortBy = 'LOWEST_PRICE',
      adults = 1,
      children = 0,
      infants = 0,
      directOnly = 'true',
      limit = 30
    } = req.query;

    const db = readDb();
    const result = getAnywhereTop10Next6Months({
      origin,
      region,
      sortBy,
      adults: Math.max(1, Number(adults) || 1),
      children: Math.max(0, Number(children) || 0),
      infants: Math.max(0, Number(infants) || 0),
      directOnly: directOnly !== 'false',
      customDestinations: db.customDestinations || [],
      limit: Number(limit) || 30
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 1-C. 노선별 향후 60일 내 가장 저렴한 추천 일정(편도 조합 합산) & 지난 2년간 시세 통계 조회
 */
app.get('/api/schedule-recommendations', (req, res) => {
  try {
    const {
      origin = 'ICN',
      destination = 'NRT',
      customCityName = '',
      minNights = 2,
      maxNights = 5,
      adults = 1,
      children = 0,
      infants = 0,
      directOnly = 'true'
    } = req.query;

    const db = readDb();
    const result = getRecommendedCheapSchedules({
      origin,
      destination,
      customCityName,
      customDestinations: db.customDestinations || [],
      minNights: Math.max(1, Number(minNights) || 2),
      maxNights: Math.max(1, Number(maxNights) || 5),
      adults: Math.max(1, Number(adults) || 1),
      children: Math.max(0, Number(children) || 0),
      infants: Math.max(0, Number(infants) || 0),
      directOnly: directOnly !== 'false',
      limit: 6
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 1-D. 단일 출발일 지정 시 돌아오는 일정별(1박 2일 ~ 10박 11일) 귀국 편도 및 합산 가격 한눈에 보기
 */
app.get('/api/return-date-matrix', (req, res) => {
  try {
    const {
      origin = 'ICN',
      destination = 'NRT',
      customCityName = '',
      departureDate,
      adults = 1,
      children = 0,
      infants = 0,
      directOnly = 'true',
      maxStayDays = 10
    } = req.query;

    const safeDepDate =
      departureDate ||
      (() => {
        const d = new Date();
        d.setDate(d.getDate() + 21);
        return d.toISOString().slice(0, 10);
      })();

    const db = readDb();
    const matrix = getReturnDatePriceMatrix({
      origin,
      destination,
      customCityName,
      customDestinations: db.customDestinations || [],
      departureDate: safeDepDate,
      adults: Math.max(1, Number(adults) || 1),
      children: Math.max(0, Number(children) || 0),
      infants: Math.max(0, Number(infants) || 0),
      directOnly: directOnly !== 'false',
      maxStayDays: Math.min(14, Math.max(3, Number(maxStayDays) || 10))
    });

    res.json(matrix);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 1-E. [v2.4] 선택 노선(폼 기준) 출발일별 편도합산 가격 추이 (가는편·오는편·합산) — 가격 추이 차트용
 */
app.get('/api/route-price-trend', (req, res) => {
  try {
    const {
      origin = 'ALL_KOREA',
      destination = 'NRT',
      customCityName = '',
      departureDate,
      returnDate,
      adults = 1,
      children = 0,
      infants = 0,
      directOnly = 'true'
    } = req.query;

    const db = readDb();
    const trend = getRoutePriceTrend({
      origin,
      destination,
      customCityName,
      customDestinations: db.customDestinations || [],
      departureDate,
      returnDate,
      adults: Math.max(1, Number(adults) || 1),
      children: Math.max(0, Number(children) || 0),
      infants: Math.max(0, Number(infants) || 0),
      directOnly: directOnly !== 'false'
    });
    res.json(trend);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 2. 대시보드 통합 데이터 조회
 */
app.get('/api/dashboard', async (req, res) => {
  try {
    const db = readDb();
    // v3 저장소에서 옮겨 온 규칙의 옛 가격을 한 번만 현재 엔진 가격으로 맞춤 (알림 없음)
    if ((await repriceMigratedRules(db)) > 0) {
      writeDb(db);
    }
    const customList = db.customDestinations || [];
    const enrichedRules = db.watchRules.map((r) => enrichRule(r, customList));

    const historiesByRule = {};
    for (const h of db.priceHistories) {
      if (!historiesByRule[h.ruleId]) {
        historiesByRule[h.ruleId] = [];
      }
      historiesByRule[h.ruleId].push(h);
    }

    const activeRules = db.watchRules.filter((r) => r.isActive);
    const uniqueWatchKeys = new Set(activeRules.map((r) => r.watchKey || buildWatchKey(r))).size;

    res.json({
      watchRules: enrichedRules,
      historiesByRule,
      notificationLogs: db.notificationLogs.slice(0, 30),
      notificationLogsTotal: db.notificationLogs.length,
      apiQuotaStats: {
        ...db.apiQuotaStats,
        activeRulesCount: activeRules.length,
        uniqueWatchKeysCount: uniqueWatchKeys
      },
      statusSummary: {
        preferredDataSource: db.settings.preferredDataSource || 'AUTO',
        hasAmadeusKey: Boolean(db.settings.amadeusClientId && db.settings.amadeusClientSecret),
        hasTravelpayoutsToken: Boolean(db.settings.travelpayoutsToken),
        hasKakaoRestKey: Boolean(db.settings.kakaoRestApiKey),
        hasKakaoToken: Boolean(db.settings.kakaoAccessToken),
        checkIntervalMinutes: db.settings.checkIntervalMinutes || 180
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 3. 신규 편도조합 항공권 최저가 알림 규칙 등록 (성인 / 소아 / 유아 + 직접 입력 도시 지원)
 */
app.post('/api/rules', async (req, res) => {
  try {
    const {
      origin = 'ICN',
      destination = 'NRT',
      customDestinationCity = '',
      departureDate,
      returnDate,
      directOnly = true,
      adults = 1,
      children = 0,
      infants = 0,
      targetPrice
    } = req.body;

    const cleanOrigin = String(origin || 'ICN').trim().toUpperCase();
    const cleanDest = String(destination || '').trim().toUpperCase();

    if (!cleanOrigin || !cleanDest || !departureDate || !returnDate || !targetPrice) {
      return res.status(400).json({ error: '출발지, 도착지(또는 직접 입력 코드), 출국/귀국 일정, 목표 가격을 모두 입력해 주세요.' });
    }

    if (departureDate > returnDate) {
      return res.status(400).json({ error: '귀국일은 출발일 이후여야 합니다.' });
    }

    const safeAdults = Math.max(1, Number(adults) || 1);
    const safeChildren = Math.max(0, Number(children) || 0);
    const safeInfants = Math.max(0, Number(infants) || 0);

    if (safeInfants > safeAdults) {
      return res
        .status(400)
        .json({ error: '항공사 안전 규정상 유아(만 24개월 미만) 인원은 성인 인원수를 초과할 수 없습니다 (성인 1명당 유아 1명 동반 가능).' });
    }

    const db = readDb();
    if (!Array.isArray(db.customDestinations)) {
      db.customDestinations = [];
    }

    // 목록에 없는 공항 코드가 직접 입력된 경우 자동 저장.
    // 귀국일표·가격 추이 등이 이 코드에 쓰는 기본 기준가와 같은 값으로 만들어야 등록 전후의 가격이 같다
    const inPreset = INTERNATIONAL_DESTINATIONS.some((d) => d.code === cleanDest);
    const inCustom = db.customDestinations.some((d) => d.code === cleanDest);
    if (!inPreset && !inCustom) {
      const cityName = customDestinationCity ? String(customDestinationCity).trim() : '';
      db.customDestinations.push(getDestinationByCode(cleanDest, [], cityName));
    }

    const watchKey = buildWatchKey({
      origin: cleanOrigin,
      destination: cleanDest,
      departureDate,
      returnDate,
      directOnly: Boolean(directOnly)
    });
    const nowIso = new Date().toISOString();

    const newRule = {
      id: generateId('rule'),
      origin: cleanOrigin,
      destination: cleanDest,
      customDestinationCity: customDestinationCity ? String(customDestinationCity).trim() : '',
      departureDate,
      returnDate,
      directOnly: Boolean(directOnly),
      adults: safeAdults,
      children: safeChildren,
      infants: safeInfants,
      targetPrice: Number(targetPrice),
      currentLowestPrice: null,
      previousPrice: null,
      sameAirlineBundledPriceKrw: null,
      mixMatchSavingsKrw: 0,
      isDifferentAirlineCombo: false,
      outboundLeg: null,
      inboundLeg: null,
      latestAirline: '조회 중...',
      latestAirlineCode: '',
      flightNumber: '',
      baggageInfo: '',
      departureTime: '',
      returnTime: '',
      sourceApi: 'ONEWAY_COMBO_ENGINE',
      isActive: true,
      watchKey,
      bookingLinks: buildBookingLinks({
        origin: cleanOrigin,
        destination: cleanDest,
        departureDate,
        returnDate,
        adults: safeAdults,
        children: safeChildren,
        infants: safeInfants,
        directOnly
      }),
      createdAt: nowIso,
      lastCheckedAt: nowIso,
      lastNotifiedAt: null
    };

    // 실제 운임 모드에서는 브라우저가 프록시(구글 플라이트·Travelpayouts)에서 받은 편도 후보를 함께 보낸다
    const { offer, usedProvider } = await fetchLowestRoundTripPrice(newRule, db.settings, {
      customDestinations: db.customDestinations,
      externalCandidates: req.body.externalCandidates || null
    });
    if (offer.origin) {
      newRule.requestedOrigin = cleanOrigin;
      newRule.origin = offer.origin;
    }
    newRule.currentLowestPrice = offer.priceKrw;
    newRule.previousPrice = offer.priceKrw;
    newRule.sameAirlineBundledPriceKrw = offer.sameAirlineBundledPriceKrw;
    newRule.mixMatchSavingsKrw = offer.mixMatchSavingsKrw;
    newRule.isDifferentAirlineCombo = offer.isDifferentAirlineCombo;
    newRule.outboundLeg = offer.outboundLeg;
    newRule.inboundLeg = offer.inboundLeg;
    newRule.latestAirline = offer.airline;
    newRule.latestAirlineCode = offer.airlineCode;
    newRule.flightNumber = offer.flightNumber;
    newRule.baggageInfo = offer.baggageInfo;
    newRule.departureTime = offer.departureTime;
    newRule.returnTime = offer.returnTime;
    newRule.sourceApi = offer.sourceApi;
    newRule.fareFetchedAt = offer.fareFetchedAt || null;
    newRule.bookingLinks = offer.bookingLinks;

    countFareLookup(db, usedProvider);

    db.watchRules.unshift(newRule);
    db.priceHistories.push({
      id: generateId('ph'),
      ruleId: newRule.id,
      watchKey,
      priceKrw: offer.priceKrw,
      airline: offer.airline,
      flightNumber: offer.flightNumber,
      sourceApi: offer.sourceApi,
      recordedAt: nowIso
    });

    let notificationResult = null;
    let notificationError = null;
    if (offer.priceKrw <= newRule.targetPrice && db.settings.autoNotifyOnTarget) {
      try {
        notificationResult = await sendRuleNotification(db, newRule, offer, nowIso);
      } catch (notifyErr) {
        // 알림이 실패해도 규칙은 만든다 (실제 운임은 다시 받으려면 검색 횟수를 또 쓴다)
        notificationError = notificationErrorText(notifyErr);
        console.error('[Rules] 카카오톡 알림 전송 오류:', notifyErr.message);
      }
    }

    writeDb(db);
    res.status(201).json({
      rule: enrichRule(newRule, db.customDestinations),
      notificationResult,
      notificationError
    });
  } catch (err) {
    res.status(errorStatusOf(err)).json(errorBodyOf(err));
  }
});

/**
 * 4. 알림 규칙 수정
 */
app.patch('/api/rules/:id', (req, res) => {
  const db = readDb();
  const rule = db.watchRules.find((r) => r.id === req.params.id);
  if (!rule) {
    return res.status(404).json({ error: '알림 규칙을 찾을 수 없습니다.' });
  }

  if (typeof req.body.targetPrice === 'number' && req.body.targetPrice > 0) {
    rule.targetPrice = Math.round(req.body.targetPrice);
  }
  if (typeof req.body.isActive === 'boolean') {
    rule.isActive = req.body.isActive;
  }

  writeDb(db);
  res.json({ rule: enrichRule(rule, db.customDestinations) });
});

/**
 * 5. 알림 규칙 삭제 (단건 및 전체 삭제 지원)
 */
app.delete('/api/rules/:id', (req, res) => {
  const db = readDb();
  const idx = db.watchRules.findIndex((r) => r.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ error: '알림 규칙을 찾을 수 없습니다.' });
  }

  const removed = db.watchRules.splice(idx, 1)[0];
  db.priceHistories = db.priceHistories.filter((h) => h.ruleId !== removed.id);
  writeDb(db);
  res.json({ deletedId: removed.id });
});

app.delete('/api/rules', (req, res) => {
  const db = readDb();
  const count = db.watchRules.length;
  db.watchRules = [];
  db.priceHistories = [];
  writeDb(db);
  res.json({ deletedCount: count });
});

/**
 * 5-A. 카카오톡 특가 알림 목록(발송 이력) 삭제 (단건 및 전체 삭제 지원)
 */
app.delete('/api/notifications/:id', (req, res) => {
  const db = readDb();
  const idx = db.notificationLogs.findIndex((n) => n.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ error: '해당 카카오톡 알림 내역을 찾을 수 없습니다.' });
  }
  const removed = db.notificationLogs.splice(idx, 1)[0];
  writeDb(db);
  res.json({ deletedId: removed.id });
});

app.delete('/api/notifications', (req, res) => {
  const db = readDb();
  const count = db.notificationLogs.length;
  db.notificationLogs = [];
  writeDb(db);
  res.json({ deletedCount: count });
});

/**
 * 6. 단일 노선 즉시 가격 조회 또는 특가 급락 시뮬레이션 실행
 */
app.post('/api/rules/:id/check', async (req, res) => {
  try {
    const forceTargetHit = Boolean(req.body?.forceTargetHit);
    const forceNotify = Boolean(req.body?.forceNotify);
    const externalCandidates = req.body?.externalCandidates || null;
    const respectCooldown = Boolean(req.body?.respectCooldown);
    const result = await checkSingleRule(req.params.id, { forceTargetHit, forceNotify, externalCandidates, respectCooldown });
    const db = readDb();
    res.json({
      ...result,
      rule: enrichRule(result.rule, db.customDestinations)
    });
  } catch (err) {
    res.status(errorStatusOf(err)).json(errorBodyOf(err));
  }
});

/**
 * 7. 특정 노선 카카오톡 알림 즉시 테스트 발송
 */
app.post('/api/rules/:id/notify', async (req, res) => {
  try {
    const db = readDb();
    const rule = db.watchRules.find((r) => r.id === req.params.id);
    if (!rule) {
      return res.status(404).json({ error: '알림 규칙을 찾을 수 없습니다.' });
    }

    const sent = await sendKakaoAlertMessage(
      rule,
      null,
      db.settings,
      (refreshed) => {
        db.settings.kakaoAccessToken = refreshed.accessToken;
        db.settings.kakaoRefreshToken = refreshed.refreshToken;
        db.settings.kakaoTokenExpiresAt = refreshed.expiresAt;
      },
      db.customDestinations
    );

    const nowIso = new Date().toISOString();
    rule.lastNotifiedAt = nowIso;
    const logItem = createNotificationLogEntry(rule.id, sent, nowIso);
    db.notificationLogs.unshift(logItem);
    writeDb(db);

    res.json({ notificationResult: logItem });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 8. 전체 활성 노선 일괄 가격 조회
 */
app.post('/api/batch-check', async (req, res) => {
  try {
    const summary = await runBatchPriceCheck();
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 9. 설정 조회 및 저장
 */
app.get('/api/settings', (req, res) => {
  const db = readDb();
  res.json({
    preferredDataSource: db.settings.preferredDataSource || 'AUTO',
    amadeusClientId: db.settings.amadeusClientId || '',
    amadeusClientSecret: db.settings.amadeusClientSecret ? '••••••••' : '',
    hasAmadeusSecret: Boolean(db.settings.amadeusClientSecret),
    amadeusEnv: db.settings.amadeusEnv || 'test',
    travelpayoutsToken: db.settings.travelpayoutsToken ? '••••••••' : '',
    hasTravelpayoutsToken: Boolean(db.settings.travelpayoutsToken),
    kakaoRestApiKey: db.settings.kakaoRestApiKey || '',
    kakaoRedirectUri: db.settings.kakaoRedirectUri || `http://localhost:${PORT}/api/kakao/callback`,
    hasKakaoAccessToken: Boolean(db.settings.kakaoAccessToken),
    kakaoAccessTokenPreview: db.settings.kakaoAccessToken
      ? `${db.settings.kakaoAccessToken.slice(0, 8)}...`
      : '',
    checkIntervalMinutes: db.settings.checkIntervalMinutes || 180,
    cooldownHours: db.settings.cooldownHours || 12,
    autoNotifyOnTarget: db.settings.autoNotifyOnTarget !== false
  });
});

app.post('/api/settings', (req, res) => {
  const db = readDb();
  const body = req.body || {};

  if (body.preferredDataSource) db.settings.preferredDataSource = body.preferredDataSource;
  if (typeof body.amadeusClientId === 'string') db.settings.amadeusClientId = body.amadeusClientId.trim();
  if (typeof body.amadeusClientSecret === 'string' && body.amadeusClientSecret !== '••••••••') {
    db.settings.amadeusClientSecret = body.amadeusClientSecret.trim();
  }
  if (body.amadeusEnv) db.settings.amadeusEnv = body.amadeusEnv;
  if (typeof body.travelpayoutsToken === 'string' && body.travelpayoutsToken !== '••••••••') {
    db.settings.travelpayoutsToken = body.travelpayoutsToken.trim();
  }
  if (typeof body.kakaoRestApiKey === 'string') db.settings.kakaoRestApiKey = body.kakaoRestApiKey.trim();
  if (typeof body.kakaoClientSecret === 'string') db.settings.kakaoClientSecret = body.kakaoClientSecret.trim();
  if (typeof body.kakaoRedirectUri === 'string' && body.kakaoRedirectUri.trim()) {
    db.settings.kakaoRedirectUri = body.kakaoRedirectUri.trim();
  }
  if (typeof body.kakaoAccessToken === 'string' && body.kakaoAccessToken.trim()) {
    db.settings.kakaoAccessToken = body.kakaoAccessToken.trim();
  }
  if (typeof body.clearKakaoToken === 'boolean' && body.clearKakaoToken) {
    db.settings.kakaoAccessToken = '';
    db.settings.kakaoRefreshToken = '';
    db.settings.kakaoTokenExpiresAt = null;
  }
  if (typeof body.checkIntervalMinutes === 'number') {
    db.settings.checkIntervalMinutes = Math.max(15, body.checkIntervalMinutes);
  }
  if (typeof body.cooldownHours === 'number') {
    db.settings.cooldownHours = Math.max(1, body.cooldownHours);
  }
  if (typeof body.autoNotifyOnTarget === 'boolean') {
    db.settings.autoNotifyOnTarget = body.autoNotifyOnTarget;
  }

  writeDb(db);
  res.json({ ok: true, message: '설정이 저장되었습니다.' });
});

/**
 * 10. 카카오 로그인 OAuth 2.0
 */
app.get('/api/kakao/login', (req, res) => {
  try {
    const db = readDb();
    const authUrl = getKakaoAuthorizeUrl(db.settings);
    res.redirect(authUrl);
  } catch (err) {
    res.status(400).send(`
      <html>
        <head><meta charset="utf-8"><title>카카오 연동 안내</title></head>
        <body style="font-family: sans-serif; padding: 40px; text-align: center;">
          <h2>⚠️ 카카오 REST API 키가 먼저 필요합니다</h2>
          <p>${err.message}</p>
          <p>웹 대시보드의 <b>[API / 카톡 설정]</b> 탭에서 카카오 REST API 키를 저장한 뒤 다시 시도해 주세요.</p>
          <a href="/" style="display:inline-block; margin-top:16px; padding:10px 20px; background:#FEE500; color:#191919; text-decoration:none; border-radius:8px; font-weight:bold;">대시보드로 돌아가기</a>
        </body>
      </html>
    `);
  }
});

app.get('/api/kakao/callback', async (req, res) => {
  const { code, error, error_description } = req.query;
  if (error || !code) {
    return res.redirect(`/?kakao_error=${encodeURIComponent(error_description || error || '인가 코드가 없습니다.')}`);
  }

  try {
    const db = readDb();
    const tokens = await exchangeCodeForTokens(code, db.settings);
    db.settings.kakaoAccessToken = tokens.accessToken;
    db.settings.kakaoRefreshToken = tokens.refreshToken;
    db.settings.kakaoTokenExpiresAt = tokens.expiresAt;
    writeDb(db);
    res.redirect('/?kakao_connected=1');
  } catch (err) {
    res.redirect(`/?kakao_error=${encodeURIComponent(err.message)}`);
  }
});

// 동기 라우트에서 난 오류(예: store.json 을 읽지 못함)도 HTML 이 아니라 JSON 으로 알린다
// (HTML 오류 페이지는 화면이 'API 서버 없음'으로 오해해 브라우저 저장소로 넘어갈 수 있다)
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error(`[API] ${req.method} ${req.originalUrl} 처리 중 오류:`, err.message);
  return res.status(err.status || err.statusCode || 500).json({ error: err.message || '서버 오류가 발생했습니다.' });
});

// 서버를 직접 실행할 때만 정기 조회를 등록 (테스트가 모듈로 불러올 때 cron이 프로세스를 붙잡아 종료되지 않던 문제 방지)
function startPriceCheckCron() {
  cron.schedule('0 */3 * * *', async () => {
    try {
      console.log('[Cron] 정기 항공권 최저가 일괄 조회를 시작합니다...');
      await runBatchPriceCheck();
    } catch (err) {
      console.error('[Cron] 일괄 조회 중 오류:', err.message);
    }
  });
}

if (require.main === module) {
  startPriceCheckCron();
  app.listen(PORT, () => {
    console.log(`✈️ 대한민국 출발 국제 항공권 최저가 알림 서버(v2.1)가 실행 중입니다: http://localhost:${PORT}`);
  });
}

module.exports = app;
