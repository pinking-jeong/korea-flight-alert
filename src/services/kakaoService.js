/**
 * 카카오 디벨로퍼스 카카오톡 메시지 API (A안 - 100% 완전 무료 / 사업자 불필요)
 * - 출국 편도 + 귀국 편도 조합 상세 내역, 2년 평균 대비 절감액, 성인/소아/유아 총액 포함 피드 카드 발송
 */

const { getOriginByCode, getDestinationByCode, calculatePassengerPricing } = require('../config/airports');
const { describeFareSource } = require('./flightApiService');
const { buildTargetAlertMessage } = require('./targetAlerts');

// 카카오 API 가 답하지 않을 때 무한정 기다리지 않게 (저장소 순서 큐를 붙잡고 있으므로 다른 요청도 막힌다)
const KAKAO_TIMEOUT_MS = 15000;

// 가격 출처별 알림 문구 (받는 사람이 그 가격으로 바로 예약할 수 있다고 오해하지 않게)
// - 모의: 계산식 가격 / 최근 검색가: 다른 이용자의 최근 검색에서 모은 실제 가격(며칠 지난 값일 수 있음) / 실시간: 조회 순간의 실제 가격
const FARE_KIND_WORDING = {
  SIMULATED: {
    titleTag: '모의 가격',
    previewTag: ' · 모의 가격',
    profileText: 'SkyBell KR · 모의 가격 (실제 운임 아님)',
    note: () => '※ 모의 가격(실제 운임 아님) · 실제 운임은 예약 사이트에서 확인',
    savingsLabel: '왕복묶음 대비'
  },
  CACHED: {
    titleTag: '최근 검색가',
    previewTag: ' · 최근 검색가',
    profileText: 'SkyBell KR · 최근 검색가 (실시간 아님)',
    note: () => '※ 최근 이용자 검색에서 모은 가격(며칠 지난 값일 수 있음) · 실제 운임은 예약 사이트에서 확인',
    savingsLabel: '같은 항공사 편도 대비'
  },
  LIVE: {
    titleTag: '편도조합 특가',
    previewTag: '',
    profileText: 'SkyBell KR · 편도 개별 합산 최저가',
    note: (fetchedAt) => `※ 실시간 조회가${fetchedAt ? ` (${formatKstShort(fetchedAt)} 조회)` : ''} · 좌석·가격은 수시로 바뀜`,
    savingsLabel: '같은 항공사 편도 대비'
  }
};

// '10/19 12:04' (한국 시간)
function formatKstShort(iso) {
  const kst = new Date(Date.parse(iso) + 9 * 3600000);
  if (Number.isNaN(kst.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${kst.getUTCMonth() + 1}/${kst.getUTCDate()} ${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}`;
}

function getKakaoAuthorizeUrl(settings) {
  if (!settings.kakaoRestApiKey) {
    throw new Error('카카오 REST API 키가 설정되지 않았습니다.');
  }
  const params = new URLSearchParams({
    client_id: settings.kakaoRestApiKey,
    redirect_uri: settings.kakaoRedirectUri || 'http://localhost:3000/api/kakao/callback',
    response_type: 'code',
    scope: 'talk_message'
  });
  return `https://kauth.kakao.com/oauth/authorize?${params.toString()}`;
}

async function exchangeCodeForTokens(code, settings) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: settings.kakaoRestApiKey,
    redirect_uri: settings.kakaoRedirectUri || 'http://localhost:3000/api/kakao/callback',
    code
  });

  if (settings.kakaoClientSecret) {
    params.append('client_secret', settings.kakaoClientSecret);
  }

  const res = await fetch('https://kauth.kakao.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: params.toString(),
    signal: AbortSignal.timeout(KAKAO_TIMEOUT_MS)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`카카오 토큰 발급 실패 (${res.status}): ${errText}`);
  }

  const tokenData = await res.json();
  return {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token || settings.kakaoRefreshToken || '',
    expiresAt: Date.now() + (tokenData.expires_in || 21599) * 1000
  };
}

async function refreshKakaoAccessToken(settings) {
  if (!settings.kakaoRestApiKey || !settings.kakaoRefreshToken) {
    throw new Error('카카오 리프레시 토큰 또는 REST API 키가 없습니다.');
  }

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: settings.kakaoRestApiKey,
    refresh_token: settings.kakaoRefreshToken
  });

  if (settings.kakaoClientSecret) {
    params.append('client_secret', settings.kakaoClientSecret);
  }

  const res = await fetch('https://kauth.kakao.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: params.toString(),
    signal: AbortSignal.timeout(KAKAO_TIMEOUT_MS)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`카카오 토큰 갱신 실패 (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || settings.kakaoRefreshToken,
    expiresAt: Date.now() + (data.expires_in || 21599) * 1000
  };
}

function buildKakaoAlertTemplate(rule, offer, customDestinations = []) {
  const originMeta = getOriginByCode(rule.origin);
  // 사용자가 추가한 도시(예: HEL 헬싱키)도 'HEL (직접입력 도시)'가 아니라 등록한 이름으로 표시
  const destMeta = getDestinationByCode(rule.destination, customDestinations, rule.customDestinationCity);
  const currentPrice = offer?.priceKrw || rule.currentLowestPrice || 0;
  const targetPrice = rule.targetPrice || 0;
  const savedAmount = Math.max(0, targetPrice - currentPrice);

  const outLeg = offer?.outboundLeg || rule.outboundLeg;
  const inLeg = offer?.inboundLeg || rule.inboundLeg;
  const mixMatchSavingsKrw = offer?.mixMatchSavingsKrw ?? rule.mixMatchSavingsKrw ?? 0;

  const pax = calculatePassengerPricing(currentPrice, {
    adults: rule.adults || 1,
    children: rule.children || 0,
    infants: rule.infants || 0
  });

  const airlineSummary =
    outLeg && inLeg
      ? `출국: ${outLeg.airline}(${outLeg.oneWayPriceKrw.toLocaleString('ko-KR')}원) + 귀국: ${inLeg.airline}(${inLeg.oneWayPriceKrw.toLocaleString('ko-KR')}원)`
      : offer?.airline || rule.latestAirline || '편도 조합 특가';

  const bookingLinks = offer?.bookingLinks || rule.bookingLinks || {};
  const bookingUrl = bookingLinks.primaryUrl || 'https://flight.naver.com';

  const routeSummary = `${originMeta.city}(${rule.origin}) ↔ ${destMeta.city}(${rule.destination})`;
  const scheduleSummary = `${rule.departureDate} ~ ${rule.returnDate} (${rule.directOnly ? '직항' : '경유포함'} · ${pax.passengerSummaryText})`;
  // 수동 발송(offer 없음)은 규칙에 남은 마지막 조회 출처로 판단한다
  const fareKind = describeFareSource(offer?.sourceApi || rule.sourceApi);
  const isSimulatedPrice = fareKind === 'SIMULATED';
  const wording = FARE_KIND_WORDING[fareKind];
  const fareNote = wording.note(offer ? offer.fareFetchedAt : rule.fareFetchedAt);

  const messagePreview = [
    `[✈️ 편도조합 최저가 도달 알림${wording.previewTag}]`,
    `▪ 노선: ${routeSummary}`,
    `▪ 일정: ${scheduleSummary}`,
    `▪ 편도 조합: ${airlineSummary}`,
    `▪ 성인 1인 합산: ${currentPrice.toLocaleString('ko-KR')}원 (목표가 ${targetPrice.toLocaleString('ko-KR')}원)`,
    `▪ 전체 탑승객(${pax.passengerSummaryText}) 총액: ${pax.totalPassengersPriceKrw.toLocaleString('ko-KR')}원`,
    `▪ ${fareNote}`
  ].join('\n');

  const templateObject = {
    object_type: 'feed',
    content: {
      title: `✈️ [${wording.titleTag}] ${originMeta.city} ↔ ${destMeta.city} ${currentPrice.toLocaleString('ko-KR')}원${fareKind === 'LIVE' ? '!' : ''}`,
      description: `${fareNote} | ${scheduleSummary} | ${airlineSummary} | 총 결제 예상액 ${pax.totalPassengersPriceKrw.toLocaleString('ko-KR')}원`,
      image_url: 'https://images.unsplash.com/photo-1436491865332-7a61a109cc05?auto=format&fit=crop&w=800&q=80',
      link: {
        web_url: bookingUrl,
        mobile_web_url: bookingUrl
      }
    },
    item_content: {
      profile_text: wording.profileText,
      items: [
        {
          item: '가는편 편도',
          item_op: outLeg ? `${outLeg.airline} ${outLeg.oneWayPriceKrw.toLocaleString('ko-KR')}원` : '-'
        },
        {
          item: '오는편 편도',
          item_op: inLeg ? `${inLeg.airline} ${inLeg.oneWayPriceKrw.toLocaleString('ko-KR')}원` : '-'
        },
        { item: '성인 1인 합산', item_op: `${currentPrice.toLocaleString('ko-KR')}원` },
        {
          item: `총액(${pax.passengerSummaryText})`,
          item_op: `${pax.totalPassengersPriceKrw.toLocaleString('ko-KR')}원`
        },
        {
          item: wording.savingsLabel,
          item_op: mixMatchSavingsKrw > 0 ? `-${mixMatchSavingsKrw.toLocaleString('ko-KR')}원 추가절약` : '최저가 조합'
        }
      ]
    },
    buttons: [
      {
        title: '가는편 편도 예약하기',
        link: {
          web_url: bookingLinks.outboundNaverUrl || bookingUrl,
          mobile_web_url: bookingLinks.outboundNaverUrl || bookingUrl
        }
      },
      {
        title: '오는편 편도 예약하기',
        link: {
          web_url: bookingLinks.inboundNaverUrl || bookingUrl,
          mobile_web_url: bookingLinks.inboundNaverUrl || bookingUrl
        }
      }
    ]
  };

  return {
    routeSummary,
    scheduleSummary,
    airline: airlineSummary,
    outboundLeg: outLeg,
    inboundLeg: inLeg,
    notifiedPrice: currentPrice,
    totalPassengersPriceKrw: pax.totalPassengersPriceKrw,
    passengerSummaryText: pax.passengerSummaryText,
    isSimulatedPrice,
    fareKind,
    targetPrice,
    savedAmount,
    mixMatchSavingsKrw,
    bookingUrl,
    outboundBookingUrl: bookingLinks.outboundNaverUrl || bookingUrl,
    inboundBookingUrl: bookingLinks.inboundNaverUrl || bookingUrl,
    messagePreview,
    templateObject
  };
}

async function sendKakaoAlertMessage(rule, offer, settings, onTokenRefreshed, customDestinations = []) {
  return sendKakaoBuiltMessage(buildKakaoAlertTemplate(rule, offer, customDestinations), settings, onTokenRefreshed);
}

// 목표가 알림 (날짜 없이 희망 목표가만) — 문구는 Pages 와 함께 쓰는 targetAlerts.js 가 만든다
async function sendKakaoTargetAlertMessage(alert, settings, onTokenRefreshed, customDestinations = []) {
  return sendKakaoBuiltMessage(buildTargetAlertMessage(alert, { customDestinations }), settings, onTokenRefreshed);
}

// built.templateObject 를 카카오톡 '나에게 보내기'로 보낸다 (토큰이 없으면 화면 미리보기로만 남긴다)
async function sendKakaoBuiltMessage(built, settings, onTokenRefreshed) {
  if (!settings.kakaoAccessToken) {
    return {
      ...built,
      channel: 'KAKAO_MEMO_API',
      status: 'PREVIEW_SENT',
      detail: '카카오 액세스 토큰 미연동 상태이므로 웹 대시보드 내 카카오톡 카드 미리보기로 발송되었습니다.'
    };
  }

  let activeToken = settings.kakaoAccessToken;

  if (
    settings.kakaoTokenExpiresAt &&
    Date.now() > settings.kakaoTokenExpiresAt - 60000 &&
    settings.kakaoRefreshToken &&
    settings.kakaoRestApiKey
  ) {
    try {
      const refreshed = await refreshKakaoAccessToken(settings);
      activeToken = refreshed.accessToken;
      if (typeof onTokenRefreshed === 'function') {
        onTokenRefreshed(refreshed);
      }
    } catch (refreshErr) {
      console.warn('[KakaoAPI] 토큰 자동 갱신 실패:', refreshErr.message);
    }
  }

  const sendRequest = async (token) => {
    const body = new URLSearchParams({
      template_object: JSON.stringify(built.templateObject)
    });
    return fetch('https://kapi.kakao.com/v2/api/talk/memo/default/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8'
      },
      body: body.toString(),
      signal: AbortSignal.timeout(KAKAO_TIMEOUT_MS)
    });
  };

  let res = await sendRequest(activeToken);

  if (res.status === 401 && settings.kakaoRefreshToken && settings.kakaoRestApiKey) {
    const refreshed = await refreshKakaoAccessToken(settings);
    activeToken = refreshed.accessToken;
    if (typeof onTokenRefreshed === 'function') {
      onTokenRefreshed(refreshed);
    }
    res = await sendRequest(activeToken);
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`카카오톡 메시지 전송 실패 (${res.status}): ${errText}`);
  }

  const resultJson = await res.json();
  return {
    ...built,
    channel: 'KAKAO_MEMO_API',
    status: resultJson.result_code === 0 ? 'KAKAO_SENT' : `CODE_${resultJson.result_code}`,
    detail: '실제 카카오톡 나에게 보내기 완료'
  };
}

module.exports = {
  getKakaoAuthorizeUrl,
  exchangeCodeForTokens,
  refreshKakaoAccessToken,
  buildKakaoAlertTemplate,
  sendKakaoAlertMessage,
  sendKakaoTargetAlertMessage
};
