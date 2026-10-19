/**
 * 목표가 알림 — 날짜를 정하지 않고 '희망 목표가'(성인 1인 왕복 = 가는 편 + 오는 편 편도 두 장 합)만 정해 두면,
 * 앞으로 정한 기간의 출발일을 하루씩 훑어 목표가 이하인 일정을 찾아 알려 준다.
 * 로컬 서버(server.js · schedulerService)와 Pages 번들(scripts/build-standalone.js)이 이 파일 하나를 함께 쓴다 (두 곳이 어긋나지 않게).
 * - 모의 가격: 이 엔진이 직접 훑는다 (scanTargetPriceDeals)
 * - 실제 운임: 브라우저가 프록시(Travelpayouts 최근 검색가)에서 받은 결과를 보내고, 여기서 일정·편도마다 다시 검증한다 (SerpApi 는 쓰지 않음)
 * 브라우저에서도 그대로 돌아야 하므로 Node 전용 기능을 쓰지 않는다.
 */

const { KOREAN_ORIGIN_AIRPORTS, getOriginByCode, getDestinationByCode, calculatePassengerPricing } = require('../config/airports');
const {
  scanTargetPriceDeals,
  rebuildExternalTargetScan,
  withRoundTripLinks,
  withoutRoundTripLinks,
  describeFareSource
} = require('./flightApiService');

const TARGET_ALERT_ID_PREFIX = 'talert';
const TARGET_ALERT_KIND = 'TARGET_PRICE';
const SIMULATED_SCAN_SOURCE = 'ONEWAY_COMBO_ENGINE';
const MIN_TARGET_PRICE_KRW = 1000;
const MAX_TARGET_PRICE_KRW = 20000000;
const MIN_WINDOW_DAYS = 7;
const MAX_WINDOW_DAYS = 186; // 엔진·프록시가 한 번에 훑는 최대 일수 (약 6개월)
const DEFAULT_WINDOW_DAYS = 90;
const MAX_NIGHTS = 30;
const DEFAULT_MIN_NIGHTS = 2;
const DEFAULT_MAX_NIGHTS = 5;
const MAX_PASSENGERS_PER_TYPE = 9;
const MATCH_LIMIT = 20;
const KAKAO_TOP_MATCHES = 3;
const DEFAULT_COOLDOWN_HOURS = 12;
const MAX_CITY_NAME_LENGTH = 20;
const KST_OFFSET_MS = 9 * 3600000;
const ORIGIN_CODES = KOREAN_ORIGIN_AIRPORTS.map((a) => a.code);
const KAKAO_IMAGE_URL = 'https://images.unsplash.com/photo-1436491865332-7a61a109cc05?auto=format&fit=crop&w=800&q=80';

// 가격 출처별 문구 (받는 사람이 그 가격으로 바로 예약할 수 있다고 오해하지 않게)
const FARE_WORDING = {
  SIMULATED: { tag: '모의 가격', note: '※ 모의 가격(실제 운임 아님) · 실제 운임은 예약 사이트에서 확인' },
  CACHED: { tag: '최근 검색가', note: '※ 다른 이용자의 최근 검색에서 모은 가격(며칠 지난 값일 수 있음) · 실제 운임은 예약 사이트에서 확인' },
  LIVE: { tag: '실시간', note: '※ 실시간 조회가 · 좌석·가격은 수시로 바뀜' }
};

function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const badAlert = (message) => codedError('BAD_TARGET_ALERT', message);

// 한국 시간 기준 날짜 (엔진·프록시·화면과 같은 기준)
function kstToday(nowMs = Date.now()) {
  return new Date(nowMs + KST_OFFSET_MS).toISOString().slice(0, 10);
}

function kstDateOf(iso) {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? '' : kstToday(time);
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// 빈 값이면 fallback, 정수가 아니거나 범위 밖이면 null
function intOrDefault(value, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

function windowLabel(days) {
  const months = { 30: '1개월', 60: '2개월', 90: '3개월', 180: '6개월' }[days];
  return months || `${days}일`;
}

/**
 * 새 목표가 알림 (가격은 아직 없음 — 등록하면서 곧바로 runTargetScan 으로 훑는다)
 * 잘못된 입력은 code 가 BAD_TARGET_ALERT · BAD_TARGET_PRICE 인 오류 (API 는 400)
 */
function createTargetAlert(body = {}, { nowIso = new Date().toISOString(), makeId = null } = {}) {
  const origin = String(body.origin || 'ALL_KOREA').trim().toUpperCase();
  if (!ORIGIN_CODES.includes(origin)) throw badAlert('출발 공항을 목록에서 골라 주세요.');
  const destination = String(body.destination || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(destination)) throw badAlert('도착 도시(3자리 공항 코드)를 골라 주세요.');
  // 한국 공항은 출발지로만 (한국→한국 노선은 이 앱의 국제선 계산·프록시가 받지 않는다)
  if (ORIGIN_CODES.includes(destination)) throw badAlert('도착지는 해외 도시로 골라 주세요 (한국 공항은 출발지로만).');

  const targetPrice = intOrDefault(Math.round(Number(body.targetPrice)), MIN_TARGET_PRICE_KRW, MAX_TARGET_PRICE_KRW, null);
  if (targetPrice === null) {
    throw codedError(
      'BAD_TARGET_PRICE',
      `희망 목표가는 ${MIN_TARGET_PRICE_KRW.toLocaleString('ko-KR')}~${MAX_TARGET_PRICE_KRW.toLocaleString('ko-KR')}원 사이 금액으로 넣어 주세요.`
    );
  }
  const windowDays = intOrDefault(body.windowDays, MIN_WINDOW_DAYS, MAX_WINDOW_DAYS, DEFAULT_WINDOW_DAYS);
  if (windowDays === null) throw badAlert(`찾을 기간은 ${MIN_WINDOW_DAYS}~${MAX_WINDOW_DAYS}일 사이로 골라 주세요.`);
  const minNights = intOrDefault(body.minNights, 1, MAX_NIGHTS, DEFAULT_MIN_NIGHTS);
  if (minNights === null) throw badAlert(`최소 박수는 1~${MAX_NIGHTS}박 사이로 골라 주세요.`);
  const maxNights = intOrDefault(body.maxNights, minNights, MAX_NIGHTS, Math.max(minNights, DEFAULT_MAX_NIGHTS));
  if (maxNights === null) throw badAlert(`최대 박수는 최소 박수(${minNights}박) 이상 ${MAX_NIGHTS}박 이하로 골라 주세요.`);

  const adults = intOrDefault(body.adults, 1, MAX_PASSENGERS_PER_TYPE, 1);
  const children = intOrDefault(body.children, 0, MAX_PASSENGERS_PER_TYPE, 0);
  const infants = intOrDefault(body.infants, 0, MAX_PASSENGERS_PER_TYPE, 0);
  if (adults === null || children === null || infants === null) {
    throw badAlert(`인원은 종류마다 ${MAX_PASSENGERS_PER_TYPE}명까지입니다 (성인은 1명 이상).`);
  }
  if (infants > adults) {
    throw badAlert('항공사 안전 규정상 유아(만 24개월 미만) 인원은 성인 인원수를 초과할 수 없습니다 (성인 1명당 유아 1명 동반 가능).');
  }

  return {
    id: typeof makeId === 'function' ? makeId(TARGET_ALERT_ID_PREFIX) : `${TARGET_ALERT_ID_PREFIX}_${Date.now().toString(16)}`,
    kind: TARGET_ALERT_KIND,
    origin,
    destination,
    customDestinationCity: String(body.customDestinationCity || '')
      .replace(/[\u0000-\u001f\u007f<>"'`&\\]/g, '')
      .trim()
      .slice(0, MAX_CITY_NAME_LENGTH),
    directOnly: body.directOnly !== false,
    adults,
    children,
    infants,
    targetPrice,
    windowDays,
    minNights,
    maxNights,
    isActive: true,
    sourceApi: SIMULATED_SCAN_SOURCE,
    fareFetchedAt: null,
    lastScan: null,
    createdAt: nowIso,
    lastCheckedAt: null,
    lastNotifiedAt: null,
    lastNotifiedPriceKrw: null
  };
}

// 엔진(모의)·검증(실제 운임)에 넘기는 조건 — 프록시 target-scan 과 같이 '내일부터 windowDays 일'
function targetScanParams(alert, { customDestinations = [], today = kstToday() } = {}) {
  const fromDate = addDays(today, 1);
  return {
    origin: alert.origin,
    destination: alert.destination,
    customCityName: alert.customDestinationCity || '',
    customDestinations,
    targetPrice: alert.targetPrice,
    windowDays: alert.windowDays,
    fromDate,
    toDate: addDays(fromDate, alert.windowDays - 1),
    minNights: alert.minNights,
    maxNights: alert.maxNights,
    adults: alert.adults,
    children: alert.children,
    infants: alert.infants,
    directOnly: alert.directOnly !== false,
    limit: MATCH_LIMIT,
    today
  };
}

function isRealFareTargetAlert(alert) {
  return describeFareSource(alert?.sourceApi) !== 'SIMULATED';
}

/**
 * 목표가 알림 한 번 훑기
 * - scanResult 없음: 모의 가격 엔진. 단 실제 운임으로 받아 온 알림이면 모의 가격으로 덮어쓰지 않게 REAL_FARE_NEEDS_PIN (API 는 409)
 * - scanResult 있음: 브라우저가 보낸 Travelpayouts 결과를 다시 검증 (출처가 다르면 BAD_FARE_SOURCE → 422)
 */
function runTargetScan(alert, { scanResult = null, customDestinations = [], today = kstToday() } = {}) {
  const params = targetScanParams(alert, { customDestinations, today });
  if (scanResult) return rebuildExternalTargetScan(scanResult, params);
  if (isRealFareTargetAlert(alert)) {
    throw codedError(
      'REAL_FARE_NEEDS_PIN',
      '실제 운임(최근 검색가)으로 받아 온 목표가 알림이라 모의 가격으로 덮어쓰지 않았습니다. PIN 을 넣으면 실제 운임으로 다시 조회합니다.'
    );
  }
  return { ...scanTargetPriceDeals(params), sourceApi: SIMULATED_SCAN_SOURCE, fetchedAt: null, partial: false };
}

function applyTargetScan(alert, scan, nowIso) {
  return {
    ...alert,
    sourceApi: scan.sourceApi,
    fareFetchedAt: scan.fetchedAt || null,
    lastCheckedAt: nowIso,
    lastScan: {
      fromDate: scan.fromDate,
      toDate: scan.toDate,
      minNights: scan.minNights,
      maxNights: scan.maxNights,
      scannedDays: scan.scannedDays,
      daysWithFares: scan.daysWithFares,
      matchCount: scan.matchCount,
      // 예약 링크는 빼고 저장하고, 보여 주거나 보낼 때 그 알림의 인원·직항으로 다시 만든다 (withRoundTripLinks)
      matches: scan.matches.map(withoutRoundTripLinks),
      cheapest: withoutRoundTripLinks(scan.cheapest),
      sourceApi: scan.sourceApi,
      fetchedAt: scan.fetchedAt || null,
      partial: Boolean(scan.partial),
      scannedAt: nowIso
    }
  };
}

// 아직 떠날 수 있는 일정만 (마지막으로 훑은 뒤 출발일이 지난 일정은 뺀다 — 훑기는 늘 '내일' 부터)
function liveMatchesOf(alert, today = kstToday()) {
  return (alert?.lastScan?.matches || []).filter((m) => m && m.departureDate > today);
}

function cheapestOf(alert, today = kstToday()) {
  const cheapest = alert?.lastScan?.cheapest;
  if (cheapest && cheapest.departureDate > today) return cheapest;
  return liveMatchesOf(alert, today)[0] || null;
}

// 목표가 이하인 날의 수 (출발일이 지나 빠진 일정만큼 뺀다)
function liveMatchCountOf(alert, today = kstToday()) {
  const live = liveMatchesOf(alert, today);
  if (!live.length) return 0;
  const expired = (alert.lastScan.matches || []).length - live.length;
  return Math.max(live.length, (alert.lastScan.matchCount || 0) - expired);
}

/**
 * 카카오톡을 보낼지: 목표가 이하 일정이 있고, 처음이거나 · 지난번 알린 값보다 더 싼 일정이 나왔거나 · 알림 간격(cooldownHours)이 지났을 때
 * (같은 값을 조회할 때마다 다시 보내지 않는다 — 날짜 지정 알림의 '목표가 이하면 매번' 과 다른 점)
 */
function shouldNotifyTargetAlert(alert, { settings = {}, nowMs = Date.now() } = {}) {
  if (settings.autoNotifyOnTarget === false || alert.isActive === false) return false;
  const best = liveMatchesOf(alert, kstToday(nowMs))[0];
  if (!best) return false;
  const lastAt = Date.parse(alert.lastNotifiedAt);
  if (!alert.lastNotifiedAt || Number.isNaN(lastAt)) return true;
  if (!(alert.lastNotifiedPriceKrw > 0) || best.combinedAdultPriceKrw < alert.lastNotifiedPriceKrw) return true;
  const cooldownMs = (Number(settings.cooldownHours) || DEFAULT_COOLDOWN_HOURS) * 3600000;
  return nowMs - lastAt >= cooldownMs;
}

function markTargetAlertNotified(alert, nowIso) {
  const best = liveMatchesOf(alert, kstDateOf(nowIso) || kstToday())[0];
  return { ...alert, lastNotifiedAt: nowIso, lastNotifiedPriceKrw: best ? best.combinedAdultPriceKrw : null };
}

const won = (n) => `${Math.round(Number(n) || 0).toLocaleString('ko-KR')}원`;
const monthDay = (iso) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}`;
const tripText = (m) =>
  `${monthDay(m.departureDate)}(${m.departureDayOfWeekKo})~${monthDay(m.returnDate)}(${m.returnDayOfWeekKo}) ${m.stayNights}박`;

function routeLabels(alert, customDestinations) {
  const destMeta = getDestinationByCode(alert.destination, customDestinations, alert.customDestinationCity);
  const originCity = alert.origin === 'ALL_KOREA' ? '한국 전체 공항' : getOriginByCode(alert.origin).city;
  const originLabel = alert.origin === 'ALL_KOREA' ? '전국' : alert.origin;
  return {
    originCity,
    destCity: destMeta.city,
    routeSummary: `${originCity}(${originLabel}) ↔ ${destMeta.city}(${alert.destination})`
  };
}

/**
 * 카카오톡 메시지(나에게 보내기 feed 템플릿)와 알림 이력·미리보기에 쓰는 내용
 * - 목표가 이하 일정이 있으면 싼 순서로 3개, 없으면(수동 발송) 기간 중 가장 싼 일정과 목표가까지 남은 금액
 */
function buildTargetAlertMessage(alert, { customDestinations = [], today = kstToday() } = {}) {
  const { originCity, destCity, routeSummary } = routeLabels(alert, customDestinations);
  const matches = liveMatchesOf(alert, today);
  const best = matches[0] || null;
  const cheapest = withRoundTripLinks(cheapestOf(alert, today), alert);
  const matchCount = liveMatchCountOf(alert, today);
  const pax = calculatePassengerPricing(cheapest ? cheapest.combinedAdultPriceKrw : alert.targetPrice, alert);
  const conditions = `${alert.directOnly !== false ? '직항' : '경유포함'} · ${pax.passengerSummaryText}`;
  const windowText = `앞으로 ${windowLabel(alert.windowDays)} · ${alert.minNights}~${alert.maxNights}박`;
  const fareKind = describeFareSource(alert.sourceApi);
  const wording = FARE_WORDING[fareKind] || FARE_WORDING.SIMULATED;
  const top = matches.slice(0, KAKAO_TOP_MATCHES);
  const bookingLinks = cheapest?.bookingLinks || {};
  const bookingUrl = bookingLinks.primaryUrl || 'https://flight.naver.com';

  let headline = '아직 가격을 찾은 날이 없음';
  if (best) headline = `목표가 이하 ${matchCount}일 발견 — 가장 싼 일정:`;
  else if (cheapest) {
    headline = `아직 목표가 이하 없음 — 기간 최저 ${won(cheapest.combinedAdultPriceKrw)} (목표까지 +${won(cheapest.combinedAdultPriceKrw - alert.targetPrice)})`;
  }
  const messagePreview = [
    `[🎯 목표가 알림 · ${wording.tag}]`,
    `▪ 노선: ${routeSummary} (${conditions})`,
    `▪ 목표가: 성인 1인 왕복 ${won(alert.targetPrice)} 이하 · ${windowText}`,
    `▪ ${headline}`,
    ...top.map((m, i) => `  ${i + 1}) ${tripText(m)} ${won(m.combinedAdultPriceKrw)} (총 ${won(m.totalPassengersPriceKrw)})`),
    `▪ ${wording.note}`
  ].join('\n');

  const templateObject = {
    object_type: 'feed',
    content: {
      title: `🎯 [${wording.tag}] ${originCity} ↔ ${destCity} ${best ? `목표가 이하 ${matchCount}일` : '목표가 이하 아직 없음'}`,
      description: [
        wording.note,
        `목표 ${won(alert.targetPrice)} · ${windowText}`,
        cheapest ? `최저 ${tripText(cheapest)} ${won(cheapest.combinedAdultPriceKrw)}` : ''
      ]
        .filter(Boolean)
        .join(' | '),
      image_url: KAKAO_IMAGE_URL,
      link: { web_url: bookingUrl, mobile_web_url: bookingUrl }
    },
    // 카카오 feed 항목 글자 수 한도: profile_text 16자 · item 6자 · item_op 14자
    ...(top.length
      ? {
          item_content: {
            profile_text: 'SkyBell 목표가 알림',
            items: top.map((m) => ({ item: monthDay(m.departureDate), item_op: `${m.stayNights}박 ${won(m.combinedAdultPriceKrw)}` }))
          }
        }
      : {}),
    buttons: [
      {
        title: best ? '가장 싼 일정 예약 검색' : '기간 최저가 일정 검색',
        link: { web_url: bookingUrl, mobile_web_url: bookingUrl }
      }
    ]
  };

  return {
    alertKind: TARGET_ALERT_KIND,
    routeSummary,
    scheduleSummary: best
      ? `${tripText(best)}${matchCount > 1 ? ` 외 목표가 이하 ${matchCount - 1}일` : ''} (${conditions})`
      : `${windowText} · 목표가 이하 일정 없음 (${conditions})`,
    airline: cheapest
      ? `출국: ${cheapest.outboundLeg.airline}(${won(cheapest.outboundLeg.oneWayPriceKrw)}) + 귀국: ${cheapest.inboundLeg.airline}(${won(cheapest.inboundLeg.oneWayPriceKrw)})`
      : '가격 정보 없음',
    outboundLeg: cheapest ? cheapest.outboundLeg : null,
    inboundLeg: cheapest ? cheapest.inboundLeg : null,
    notifiedPrice: cheapest ? cheapest.combinedAdultPriceKrw : 0,
    totalPassengersPriceKrw: cheapest ? cheapest.totalPassengersPriceKrw : 0,
    passengerSummaryText: pax.passengerSummaryText,
    isSimulatedPrice: fareKind === 'SIMULATED',
    fareKind,
    targetPrice: alert.targetPrice,
    savedAmount: best ? Math.max(0, alert.targetPrice - best.combinedAdultPriceKrw) : 0,
    mixMatchSavingsKrw: 0,
    matchCount,
    topMatches: top.map((m) => ({
      origin: m.origin,
      departureDate: m.departureDate,
      returnDate: m.returnDate,
      stayNights: m.stayNights,
      combinedAdultPriceKrw: m.combinedAdultPriceKrw,
      totalPassengersPriceKrw: m.totalPassengersPriceKrw
    })),
    bookingUrl,
    outboundBookingUrl: bookingLinks.outboundNaverUrl || bookingUrl,
    inboundBookingUrl: bookingLinks.inboundNaverUrl || bookingUrl,
    messagePreview,
    templateObject
  };
}

// 카카오톡 알림 이력 한 건 (서버는 실제 발송 결과, Pages 는 미리보기)
function targetAlertLogEntry(alertId, built, { id, sentAt, channel = 'KAKAO_MEMO_API', status = 'PREVIEW_SENT', detail = '' }) {
  return {
    id,
    ruleId: alertId,
    alertKind: built.alertKind,
    routeSummary: built.routeSummary,
    scheduleSummary: built.scheduleSummary,
    airline: built.airline,
    outboundLeg: built.outboundLeg,
    inboundLeg: built.inboundLeg,
    notifiedPrice: built.notifiedPrice,
    totalPassengersPriceKrw: built.totalPassengersPriceKrw,
    passengerSummaryText: built.passengerSummaryText,
    isSimulatedPrice: built.isSimulatedPrice,
    fareKind: built.fareKind,
    targetPrice: built.targetPrice,
    savedAmount: built.savedAmount,
    mixMatchSavingsKrw: built.mixMatchSavingsKrw,
    matchCount: built.matchCount,
    topMatches: built.topMatches,
    channel,
    status,
    detail,
    bookingUrl: built.bookingUrl,
    outboundBookingUrl: built.outboundBookingUrl,
    inboundBookingUrl: built.inboundBookingUrl,
    messagePreview: built.messagePreview,
    templateObject: built.templateObject,
    sentAt
  };
}

/**
 * 화면용 (대시보드): 지금 떠날 수 있는 목표가 이하 일정·기간 최저가·목표가까지 남은 금액
 * 저장된 일정 목록(lastScan.matches·cheapest)은 matches·cheapest 로 한 번만 내려보낸다
 */
function enrichTargetAlert(alert, { customDestinations = [], today = kstToday() } = {}) {
  const { originCity, destCity, routeSummary } = routeLabels(alert, customDestinations);
  const matches = liveMatchesOf(alert, today).map((m) => withRoundTripLinks(m, alert));
  const cheapest = withRoundTripLinks(cheapestOf(alert, today), alert);
  const targetPricing = calculatePassengerPricing(alert.targetPrice, alert);
  const scan = alert.lastScan;
  return {
    ...alert,
    lastScan: scan
      ? {
          fromDate: scan.fromDate,
          toDate: scan.toDate,
          scannedDays: scan.scannedDays,
          daysWithFares: scan.daysWithFares,
          sourceApi: scan.sourceApi,
          fetchedAt: scan.fetchedAt,
          partial: scan.partial,
          scannedAt: scan.scannedAt
        }
      : null,
    originCity,
    destCity,
    routeSummary,
    windowLabel: windowLabel(alert.windowDays),
    passengerSummaryText: targetPricing.passengerSummaryText,
    targetTotalPassengersPriceKrw: targetPricing.totalPassengersPriceKrw,
    matches,
    matchCount: liveMatchCountOf(alert, today),
    cheapest,
    isTargetReached: matches.length > 0,
    bestPriceKrw: matches.length ? matches[0].combinedAdultPriceKrw : null,
    gapToTargetKrw: cheapest ? cheapest.combinedAdultPriceKrw - alert.targetPrice : null,
    isRealFare: isRealFareTargetAlert(alert),
    checkedToday: kstDateOf(alert.lastCheckedAt) === today
  };
}

module.exports = {
  TARGET_ALERT_KIND,
  MATCH_LIMIT,
  kstToday,
  createTargetAlert,
  targetScanParams,
  isRealFareTargetAlert,
  runTargetScan,
  applyTargetScan,
  liveMatchesOf,
  shouldNotifyTargetAlert,
  markTargetAlertNotified,
  buildTargetAlertMessage,
  targetAlertLogEntry,
  enrichTargetAlert
};
