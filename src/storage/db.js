const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  getOriginByCode,
  getDestinationByCode,
  calculatePassengerPricing,
  buildBookingLinks,
  rebuildStoredDestinations
} = require('../config/airports');

// 테스트 등에서 실제 data/store.json 대신 임시 폴더를 쓰도록 SKYBELL_DATA_DIR 로 바꿀 수 있음
const DATA_DIR = process.env.SKYBELL_DATA_DIR
  ? path.resolve(process.env.SKYBELL_DATA_DIR)
  : path.join(__dirname, '..', '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'store.json');
const SCHEMA_VERSION = 4;
// v3 → v4 는 필드 추가뿐이므로 사용자 데이터(규칙·가격 이력·알림 이력)를 그대로 옮김
const PRESERVABLE_LEGACY_SCHEMA_VERSION = 3;

function generateId(prefix = 'id') {
  return `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
}

function buildWatchKey({ origin, destination, departureDate, returnDate, directOnly }) {
  return `${origin}-${destination}-${departureDate}-${returnDate}-${directOnly ? 'DIRECT' : 'ANY'}`;
}

function getFutureDateString(daysFromNow) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

function createInitialStore() {
  const now = new Date();
  const dep1 = getFutureDateString(21);
  const ret1 = getFutureDateString(24);

  const dep2 = getFutureDateString(35);
  const ret2 = getFutureDateString(39);

  const dep3 = getFutureDateString(48);
  const ret3 = getFutureDateString(51);

  const rule1Id = 'rule_icn_nrt_01';
  const rule2Id = 'rule_icn_gum_02';
  const rule3Id = 'rule_pus_kix_03';

  const links1 = buildBookingLinks({
    origin: 'ICN',
    destination: 'NRT',
    departureDate: dep1,
    returnDate: ret1,
    adults: 1,
    children: 0,
    infants: 0,
    directOnly: true,
    outboundAirline: '이스타항공',
    inboundAirline: '에어프레미아',
    outboundAirlineCode: 'ZE',
    inboundAirlineCode: 'YP'
  });

  const links2 = buildBookingLinks({
    origin: 'ICN',
    destination: 'GUM',
    departureDate: dep2,
    returnDate: ret2,
    adults: 2,
    children: 1,
    infants: 1,
    directOnly: true,
    outboundAirline: '진에어',
    inboundAirline: '제주항공',
    outboundAirlineCode: 'LJ',
    inboundAirlineCode: '7C'
  });

  const links3 = buildBookingLinks({
    origin: 'PUS',
    destination: 'KIX',
    departureDate: dep3,
    returnDate: ret3,
    adults: 2,
    children: 0,
    infants: 0,
    directOnly: true,
    outboundAirline: '에어부산',
    inboundAirline: '제주항공',
    outboundAirlineCode: 'BX',
    inboundAirlineCode: '7C'
  });

  const rules = [
    {
      id: rule1Id,
      origin: 'ICN',
      destination: 'NRT',
      departureDate: dep1,
      returnDate: ret1,
      directOnly: true,
      adults: 1,
      children: 0,
      infants: 0,
      targetPrice: 198000,
      currentLowestPrice: 186400,
      previousPrice: 234000,
      sameAirlineBundledPriceKrw: 212000,
      mixMatchSavingsKrw: 25600,
      isDifferentAirlineCombo: true,
      outboundLeg: {
        direction: 'OUTBOUND',
        originAirportCode: 'ICN',
        originAirportCity: '서울/인천',
        date: dep1,
        airline: '이스타항공',
        airlineCode: 'ZE',
        flightNumber: 'ZE601',
        baggageInfo: '위탁 15kg 포함',
        scheduleTime: '08:00 → 10:25',
        oneWayPriceKrw: 89200,
        naverOneWayUrl: links1.outboundNaverUrl,
        officialBookingUrl: links1.outboundAirlineOfficialUrl
      },
      inboundLeg: {
        direction: 'INBOUND',
        originAirportCode: 'ICN',
        originAirportCity: '서울/인천',
        date: ret1,
        airline: '에어프레미아',
        airlineCode: 'YP',
        flightNumber: 'YP102',
        baggageInfo: '위탁 23kg 포함',
        scheduleTime: '12:30 → 15:15',
        oneWayPriceKrw: 97200,
        naverOneWayUrl: links1.inboundNaverUrl,
        officialBookingUrl: links1.inboundAirlineOfficialUrl
      },
      latestAirline: '이스타항공(출국) + 에어프레미아(귀국)',
      latestAirlineCode: 'ZE+YP',
      flightNumber: 'ZE601 / YP102',
      baggageInfo: '출국(위탁 15kg 포함) · 귀국(위탁 23kg 포함)',
      departureTime: '08:00 → 10:25',
      returnTime: '12:30 → 15:15',
      sourceApi: 'ONEWAY_COMBO_ENGINE',
      isActive: true,
      watchKey: buildWatchKey({ origin: 'ICN', destination: 'NRT', departureDate: dep1, returnDate: ret1, directOnly: true }),
      bookingLinks: links1,
      createdAt: new Date(now.getTime() - 7 * 86400000).toISOString(),
      lastCheckedAt: new Date(now.getTime() - 1800000).toISOString(),
      lastNotifiedAt: new Date(now.getTime() - 1800000).toISOString()
    },
    {
      id: rule2Id,
      origin: 'ICN',
      destination: 'GUM',
      departureDate: dep2,
      returnDate: ret2,
      directOnly: true,
      adults: 2,
      children: 1,
      infants: 1,
      targetPrice: 255000,
      currentLowestPrice: 242000,
      previousPrice: 289000,
      sameAirlineBundledPriceKrw: 274000,
      mixMatchSavingsKrw: 32000,
      isDifferentAirlineCombo: true,
      outboundLeg: {
        direction: 'OUTBOUND',
        originAirportCode: 'ICN',
        originAirportCity: '서울/인천',
        date: dep2,
        airline: '진에어',
        airlineCode: 'LJ',
        flightNumber: 'LJ913',
        baggageInfo: '위탁 23kg 포함',
        scheduleTime: '09:15 → 14:45',
        oneWayPriceKrw: 118000,
        naverOneWayUrl: links2.outboundNaverUrl,
        officialBookingUrl: links2.outboundAirlineOfficialUrl
      },
      inboundLeg: {
        direction: 'INBOUND',
        originAirportCode: 'ICN',
        originAirportCity: '서울/인천',
        date: ret2,
        airline: '제주항공',
        airlineCode: '7C',
        flightNumber: '7C3102',
        baggageInfo: '위탁 23kg 포함',
        scheduleTime: '16:50 → 20:30',
        oneWayPriceKrw: 124000,
        naverOneWayUrl: links2.inboundNaverUrl,
        officialBookingUrl: links2.inboundAirlineOfficialUrl
      },
      latestAirline: '진에어(출국) + 제주항공(귀국)',
      latestAirlineCode: 'LJ+7C',
      flightNumber: 'LJ913 / 7C3102',
      baggageInfo: '출국(위탁 23kg 포함) · 귀국(위탁 23kg 포함)',
      departureTime: '09:15 → 14:45',
      returnTime: '16:50 → 20:30',
      sourceApi: 'ONEWAY_COMBO_ENGINE',
      isActive: true,
      watchKey: buildWatchKey({ origin: 'ICN', destination: 'GUM', departureDate: dep2, returnDate: ret2, directOnly: true }),
      bookingLinks: links2,
      createdAt: new Date(now.getTime() - 6 * 86400000).toISOString(),
      lastCheckedAt: new Date(now.getTime() - 1800000).toISOString(),
      lastNotifiedAt: new Date(now.getTime() - 1800000).toISOString()
    },
    {
      id: rule3Id,
      origin: 'PUS',
      destination: 'KIX',
      departureDate: dep3,
      returnDate: ret3,
      directOnly: true,
      adults: 2,
      children: 0,
      infants: 0,
      targetPrice: 165000,
      currentLowestPrice: 174000,
      previousPrice: 205000,
      sameAirlineBundledPriceKrw: 196000,
      mixMatchSavingsKrw: 22000,
      isDifferentAirlineCombo: true,
      outboundLeg: {
        direction: 'OUTBOUND',
        originAirportCode: 'PUS',
        originAirportCity: '부산/김해',
        date: dep3,
        airline: '에어부산',
        airlineCode: 'BX',
        flightNumber: 'BX124',
        baggageInfo: '위탁 15kg 포함',
        scheduleTime: '08:35 → 10:05',
        oneWayPriceKrw: 85000,
        naverOneWayUrl: links3.outboundNaverUrl,
        officialBookingUrl: links3.outboundAirlineOfficialUrl
      },
      inboundLeg: {
        direction: 'INBOUND',
        originAirportCode: 'PUS',
        originAirportCity: '부산/김해',
        date: ret3,
        airline: '제주항공',
        airlineCode: '7C',
        flightNumber: '7C1351',
        baggageInfo: '위탁 15kg 포함',
        scheduleTime: '16:50 → 18:20',
        oneWayPriceKrw: 89000,
        naverOneWayUrl: links3.inboundNaverUrl,
        officialBookingUrl: links3.inboundAirlineOfficialUrl
      },
      latestAirline: '에어부산(출국) + 제주항공(귀국)',
      latestAirlineCode: 'BX+7C',
      flightNumber: 'BX124 / 7C1351',
      baggageInfo: '출국(위탁 15kg 포함) · 귀국(위탁 15kg 포함)',
      departureTime: '08:35 → 10:05',
      returnTime: '16:50 → 18:20',
      sourceApi: 'ONEWAY_COMBO_ENGINE',
      isActive: true,
      watchKey: buildWatchKey({ origin: 'PUS', destination: 'KIX', departureDate: dep3, returnDate: ret3, directOnly: true }),
      bookingLinks: links3,
      createdAt: new Date(now.getTime() - 5 * 86400000).toISOString(),
      lastCheckedAt: new Date(now.getTime() - 1800000).toISOString(),
      lastNotifiedAt: null
    }
  ];

  const priceHistories = [];
  const seedSeries = {
    [rule1Id]: [264000, 255000, 248000, 242000, 236000, 229000, 221000, 214000, 199000, 186400],
    [rule2Id]: [345000, 332000, 319000, 308000, 295000, 289000, 276000, 268000, 254000, 242000],
    [rule3Id]: [221000, 215000, 209000, 204000, 198000, 194000, 189000, 184000, 179000, 174000]
  };

  for (const rule of rules) {
    const series = seedSeries[rule.id] || [];
    series.forEach((price, idx) => {
      const daysAgo = series.length - 1 - idx;
      const recordedAt = new Date(now.getTime() - daysAgo * 12 * 3600000).toISOString();
      priceHistories.push({
        id: generateId('ph'),
        ruleId: rule.id,
        watchKey: rule.watchKey,
        priceKrw: price,
        airline: rule.latestAirline,
        flightNumber: rule.flightNumber,
        sourceApi: 'ONEWAY_COMBO_ENGINE',
        recordedAt
      });
    });
  }

  const notificationLogs = [
    {
      id: generateId('noti'),
      ruleId: rule1Id,
      routeSummary: '서울/인천(ICN) ↔ 도쿄 나리타(NRT)',
      scheduleSummary: `${dep1} ~ ${ret1} (직항 · 성인 1명)`,
      airline: '출국: 이스타항공(89,200원) + 귀국: 에어프레미아(97,200원)',
      notifiedPrice: 186400,
      totalPassengersPriceKrw: 186400,
      passengerSummaryText: '성인 1명',
      targetPrice: 198000,
      savedAmount: 11600,
      mixMatchSavingsKrw: 25600,
      channel: 'KAKAO_MEMO_API',
      status: 'PREVIEW_SENT',
      bookingUrl: rules[0].bookingLinks.primaryUrl,
      outboundBookingUrl: rules[0].bookingLinks.outboundNaverUrl,
      inboundBookingUrl: rules[0].bookingLinks.inboundNaverUrl,
      messagePreview: `[✈️ 편도조합 최저가 도달 알림]\n서울/인천(ICN) ↔ 도쿄 나리타(NRT)\n출국편: 이스타항공 89,200원\n귀국편: 에어프레미아 97,200원\n편도합산 최저가: 186,400원 (왕복 묶음 대비 -25,600원 추가 절약!)`,
      sentAt: new Date(now.getTime() - 1800000).toISOString()
    },
    {
      id: generateId('noti'),
      ruleId: rule2Id,
      routeSummary: '서울/인천(ICN) ↔ 괌(GUM)',
      scheduleSummary: `${dep2} ~ ${ret2} (직항 · 성인 2명 · 소아 1명 · 유아 1명)`,
      airline: '출국: 진에어(118,000원) + 귀국: 제주항공(124,000원)',
      notifiedPrice: 242000,
      totalPassengersPriceKrw: 701800,
      passengerSummaryText: '성인 2명 · 소아 1명 · 유아 1명',
      targetPrice: 255000,
      savedAmount: 13000,
      mixMatchSavingsKrw: 32000,
      channel: 'KAKAO_MEMO_API',
      status: 'PREVIEW_SENT',
      bookingUrl: rules[1].bookingLinks.primaryUrl,
      outboundBookingUrl: rules[1].bookingLinks.outboundNaverUrl,
      inboundBookingUrl: rules[1].bookingLinks.inboundNaverUrl,
      messagePreview: `[✈️ 편도조합 최저가 도달 알림]\n서울/인천(ICN) ↔ 괌(GUM)\n성인 1인 합산: 242,000원\n4인 가족 총액(성인2·소아1·유아1): 701,800원`,
      sentAt: new Date(now.getTime() - 3600000).toISOString()
    }
  ];

  return {
    schemaVersion: SCHEMA_VERSION,
    customDestinations: [],
    settings: {
      amadeusClientId: process.env.AMADEUS_CLIENT_ID || '',
      amadeusClientSecret: process.env.AMADEUS_CLIENT_SECRET || '',
      amadeusEnv: process.env.AMADEUS_ENV || 'test',
      travelpayoutsToken: process.env.TRAVELPAYOUTS_TOKEN || '',
      preferredDataSource: 'AUTO',
      kakaoRestApiKey: process.env.KAKAO_REST_API_KEY || '',
      kakaoClientSecret: process.env.KAKAO_CLIENT_SECRET || '',
      kakaoRedirectUri: process.env.KAKAO_REDIRECT_URI || 'http://localhost:3000/api/kakao/callback',
      kakaoAccessToken: process.env.KAKAO_ACCESS_TOKEN || '',
      kakaoRefreshToken: process.env.KAKAO_REFRESH_TOKEN || '',
      kakaoTokenExpiresAt: null,
      kakaoUserProfile: null,
      checkIntervalMinutes: 180,
      cooldownHours: 12,
      autoNotifyOnTarget: true
    },
    watchRules: rules,
    priceHistories,
    notificationLogs,
    apiQuotaStats: {
      amadeusCallsThisMonth: 0,
      travelpayoutsCallsThisMonth: 0,
      simulationCallsThisMonth: 6,
      deduplicatedSavedCalls: 2,
      lastBatchRunAt: new Date(now.getTime() - 1800000).toISOString()
    }
  };
}

// 객체가 아닌 항목(null, 문자열 등)은 버리고, 배열이 없으면 샘플 대신 빈 목록으로 옮긴다
function keepObjectItems(list) {
  return Array.isArray(list) ? list.filter((item) => item && typeof item === 'object' && !Array.isArray(item)) : [];
}

function upgradeLegacyStore(parsed) {
  const fresh = createInitialStore();
  const upgraded = {
    ...fresh,
    settings: { ...fresh.settings, ...(parsed.settings || {}) },
    customDestinations: rebuildStoredDestinations(parsed.customDestinations)
  };
  if (Number(parsed.schemaVersion) !== PRESERVABLE_LEGACY_SCHEMA_VERSION) {
    // 형식을 알 수 없는 더 오래된 저장소: 설정과 사용자 도시만 유지하고 샘플 데이터로 시작 (원본은 백업 파일로 남음)
    return upgraded;
  }
  return {
    ...upgraded,
    // 이전 엔진(무작위 변동)이 매긴 가격은 첫 대시보드 조회 때 알림 없이 다시 계산 (schedulerService.repriceMigratedRules)
    watchRules: keepObjectItems(parsed.watchRules).map((rule) => ({ ...rule, needsReprice: true })),
    priceHistories: keepObjectItems(parsed.priceHistories),
    notificationLogs: keepObjectItems(parsed.notificationLogs),
    apiQuotaStats: { ...fresh.apiQuotaStats, ...(parsed.apiQuotaStats || {}) }
  };
}

// 메모장·PowerShell 등이 UTF-8 파일 앞에 붙이는 BOM 은 JSON 이 아니므로 떼고 읽는다
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// 저장소를 덮어쓰기 전에 원본을 store.<label>-<시각>.json 으로 남긴다
function backupStoreFile(label) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(DB_FILE, path.join(DATA_DIR, `store.${label}-${stamp}.json`));
}

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DB_FILE)) {
    const initial = createInitialStore();
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2), 'utf8');
    return initial;
  }

  // 읽기 자체가 실패(파일 잠김·권한 등)한 것은 손상이 아니므로 저장소를 건드리지 않고 오류를 그대로 올린다
  const raw = stripBom(fs.readFileSync(DB_FILE, 'utf8'));
  let parsed;
  try {
    parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('store.json 최상위가 객체가 아님');
    }
  } catch (err) {
    // 손상된 저장소는 지우지 않고 옆에 보관한 뒤 새 저장소로 시작
    backupStoreFile('corrupt');
    const fallback = createInitialStore();
    fs.writeFileSync(DB_FILE, JSON.stringify(fallback, null, 2), 'utf8');
    return fallback;
  }

  if (!(Number(parsed.schemaVersion) >= SCHEMA_VERSION)) {
    const upgraded = upgradeLegacyStore(parsed);
    backupStoreFile(`backup-v${Number(parsed.schemaVersion) || 0}`);
    fs.writeFileSync(DB_FILE, JSON.stringify(upgraded, null, 2), 'utf8');
    return upgraded;
  }
  if (!Array.isArray(parsed.customDestinations)) {
    parsed.customDestinations = [];
  }
  return parsed;
}

function readDb() {
  return ensureDb();
}

function writeDb(data) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
  return data;
}

function enrichRule(rule, customDestinations = []) {
  const effectiveOrigin =
    rule.outboundLeg?.originAirportCode ||
    (rule.origin && rule.origin !== 'ALL_KOREA' ? rule.origin : 'ICN');
  const originMeta = getOriginByCode(effectiveOrigin);
  const destMeta = getDestinationByCode(rule.destination, customDestinations, rule.customDestinationCity);
  const benchmark2Y = destMeta.benchmark2Y || {};
  const avg2YKrw = benchmark2Y.avg2YKrw || destMeta.basePriceKrw || 300000;

  const currentPrice = rule.currentLowestPrice || avg2YKrw;
  const diffFromTarget = currentPrice - (rule.targetPrice || 0);
  const isTargetReached = Boolean(rule.currentLowestPrice && rule.currentLowestPrice <= rule.targetPrice);
  const discountRateVsMarket = avg2YKrw ? Math.round(((avg2YKrw - currentPrice) / avg2YKrw) * 100) : 0;

  const passengerPricing = calculatePassengerPricing(currentPrice, {
    adults: rule.adults || 1,
    children: rule.children || 0,
    infants: rule.infants || 0
  });

  // 항상 최신 노선·날짜·인원·항공사 정보로 예약 링크(bookingLinks) 재산출하여 불일치 원천 차단
  const freshBookingLinks = buildBookingLinks({
    origin: effectiveOrigin,
    destination: rule.destination,
    departureDate: rule.departureDate,
    returnDate: rule.returnDate,
    adults: passengerPricing.adults,
    children: passengerPricing.children,
    infants: passengerPricing.infants,
    directOnly: rule.directOnly,
    outboundAirline: rule.outboundLeg?.airline || '',
    inboundAirline: rule.inboundLeg?.airline || '',
    outboundAirlineCode: rule.outboundLeg?.airlineCode || '',
    inboundAirlineCode: rule.inboundLeg?.airlineCode || ''
  });

  const enrichedOutbound = rule.outboundLeg
    ? {
        ...rule.outboundLeg,
        originAirportCode: effectiveOrigin,
        originAirportCity: originMeta.city,
        naverOneWayUrl: freshBookingLinks.outboundNaverUrl,
        officialBookingUrl: freshBookingLinks.outboundAirlineOfficialUrl
      }
    : null;

  const enrichedInbound = rule.inboundLeg
    ? {
        ...rule.inboundLeg,
        originAirportCode: effectiveOrigin,
        originAirportCity: originMeta.city,
        naverOneWayUrl: freshBookingLinks.inboundNaverUrl,
        officialBookingUrl: freshBookingLinks.inboundAirlineOfficialUrl
      }
    : null;

  return {
    ...rule,
    origin: effectiveOrigin,
    adults: passengerPricing.adults,
    children: passengerPricing.children,
    infants: passengerPricing.infants,
    passengerPricing,
    originMeta,
    destMeta,
    benchmark2Y,
    diffFromTarget,
    isTargetReached,
    discountRateVsMarket,
    outboundLeg: enrichedOutbound,
    inboundLeg: enrichedInbound,
    bookingLinks: freshBookingLinks
  };
}

module.exports = {
  generateId,
  buildWatchKey,
  readDb,
  writeDb,
  enrichRule
};
