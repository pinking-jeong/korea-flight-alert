/**
 * 카카오 디벨로퍼스 카카오톡 메시지 API (A안 - 100% 완전 무료 / 사업자 불필요)
 * - 출국 편도 + 귀국 편도 조합 상세 내역, 2년 평균 대비 절감액, 성인/소아/유아 총액 포함 피드 카드 발송
 */

const { getOriginByCode, getDestinationByCode, calculatePassengerPricing } = require('../config/airports');

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
    body: params.toString()
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
    body: params.toString()
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

  const messagePreview = [
    `[✈️ 편도조합 최저가 도달 알림]`,
    `▪ 노선: ${routeSummary}`,
    `▪ 일정: ${scheduleSummary}`,
    `▪ 편도 조합: ${airlineSummary}`,
    `▪ 성인 1인 합산: ${currentPrice.toLocaleString('ko-KR')}원 (목표가 ${targetPrice.toLocaleString('ko-KR')}원)`,
    `▪ 전체 탑승객(${pax.passengerSummaryText}) 총액: ${pax.totalPassengersPriceKrw.toLocaleString('ko-KR')}원`
  ].join('\n');

  const templateObject = {
    object_type: 'feed',
    content: {
      title: `✈️ [편도조합 특가] ${originMeta.city} ↔ ${destMeta.city} ${currentPrice.toLocaleString('ko-KR')}원!`,
      description: `${scheduleSummary} | ${airlineSummary} | 총 결제 예상액 ${pax.totalPassengersPriceKrw.toLocaleString('ko-KR')}원`,
      image_url: 'https://images.unsplash.com/photo-1436491865332-7a61a109cc05?auto=format&fit=crop&w=800&q=80',
      link: {
        web_url: bookingUrl,
        mobile_web_url: bookingUrl
      }
    },
    item_content: {
      profile_text: 'SkyBell KR · 편도 개별 합산 최저가',
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
          item: '왕복묶음 대비',
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
  const built = buildKakaoAlertTemplate(rule, offer, customDestinations);

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
      body: body.toString()
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
  sendKakaoAlertMessage
};
