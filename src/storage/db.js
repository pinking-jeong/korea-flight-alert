const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  getOriginByCode,
  getDestinationByCode,
  calculatePassengerPricing,
  buildBookingLinks
} = require('../config/airports');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'store.json');
const SCHEMA_VERSION = 3;

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
  const rule2Id = 'rule_icn_dad_02';
  const rule3Id = 'rule_pus_kix_03';

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
        date: dep1,
        airline: '이스타항공',
        airlineCode: 'ZE',
        flightNumber: 'ZE601',
        baggageInfo: '위탁 15kg 포함',
        scheduleTime: '08:00 → 10:25',
        oneWayPriceKrw: 89200
      },
      inboundLeg: {
        direction: 'INBOUND',
        date: ret1,
        airline: '에어프레미아',
        airlineCode: 'YP',
        flightNumber: 'YP102',
        baggageInfo: '위탁 23kg 포함',
        scheduleTime: '12:30 → 15:15',
        oneWayPriceKrw: 97200
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
      bookingLinks: buildBookingLinks({
        origin: 'ICN',
        destination: 'NRT',
        departureDate: dep1,
        returnDate: ret1,
        adults: 1,
        children: 0,
        infants: 0,
        directOnly: true
      }),
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
        date: dep2,
        airline: '진에어',
        airlineCode: 'LJ',
        flightNumber: 'LJ913',
        baggageInfo: '위탁 23kg 포함',
        scheduleTime: '09:15 → 14:45',
        oneWayPriceKrw: 118000
      },
      inboundLeg: {
        direction: 'INBOUND',
        date: ret2,
        airline: '제주항공',
        airlineCode: '7C',
        flightNumber: '7C3102',
        baggageInfo: '위탁 23kg 포함',
        scheduleTime: '16:50 → 20:30',
        oneWayPriceKrw: 124000
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
      bookingLinks: buildBookingLinks({
        origin: 'ICN',
        destination: 'GUM',
        departureDate: dep2,
        returnDate: ret2,
        adults: 2,
        children: 1,
        infants: 1,
        directOnly: true
      }),
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
        date: dep3,
        airline: '에어부산',
        airlineCode: 'BX',
        flightNumber: 'BX124',
        baggageInfo: '위탁 15kg 포함',
        scheduleTime: '08:35 → 10:05',
        oneWayPriceKrw: 85000
      },
      inboundLeg: {
        direction: 'INBOUND',
        date: ret3,
        airline: '제주항공',
        airlineCode: '7C',
        flightNumber: '7C1351',
        baggageInfo: '위탁 15kg 포함',
        scheduleTime: '16:50 → 18:20',
        oneWayPriceKrw: 89000
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
      bookingLinks: buildBookingLinks({
        origin: 'PUS',
        destination: 'KIX',
        departureDate: dep3,
        returnDate: ret3,
        adults: 2,
        children: 0,
        infants: 0,
        directOnly: true
      }),
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

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DB_FILE)) {
    const initial = createInitialStore();
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2), 'utf8');
    return initial;
  }
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed.schemaVersion || parsed.schemaVersion < SCHEMA_VERSION) {
      const upgraded = createInitialStore();
      upgraded.settings = { ...upgraded.settings, ...(parsed.settings || {}) };
      upgraded.customDestinations = parsed.customDestinations || [];
      fs.writeFileSync(DB_FILE, JSON.stringify(upgraded, null, 2), 'utf8');
      return upgraded;
    }
    if (!Array.isArray(parsed.customDestinations)) {
      parsed.customDestinations = [];
    }
    return parsed;
  } catch (err) {
    const fallback = createInitialStore();
    fs.writeFileSync(DB_FILE, JSON.stringify(fallback, null, 2), 'utf8');
    return fallback;
  }
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
  const originMeta = getOriginByCode(rule.origin);
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

  return {
    ...rule,
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
    bookingLinks:
      rule.bookingLinks ||
      buildBookingLinks({
        origin: rule.origin,
        destination: rule.destination,
        departureDate: rule.departureDate,
        returnDate: rule.returnDate,
        adults: passengerPricing.adults,
        children: passengerPricing.children,
        infants: passengerPricing.infants,
        directOnly: rule.directOnly
      })
  };
}

module.exports = {
  generateId,
  buildWatchKey,
  readDb,
  writeDb,
  enrichRule
};
