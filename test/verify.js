/**
 * SkyBell KR v2.1 엔드투엔드(E2E) 핵심 기능 검증 스크립트
 */
const app = require('../src/server');

async function runTests() {
  const server = app.listen(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  console.log(`🧪 테스트 서버 시작 (v2.1): ${base}`);

  try {
    // 1. /api/meta 및 60개+ 도시 확장 검증
    const metaRes = await fetch(`${base}/api/meta`);
    const meta = await metaRes.json();
    if (!meta.destinations || meta.destinations.length < 60) {
      throw new Error(`도시 수 부족: ${meta.destinations?.length}`);
    }
    console.log(
      `✅ [1/7] /api/meta 통과: 한국 출발 공항 ${meta.origins.length}곳 · 전 세계 취항 도시 ${meta.destinations.length}곳 탑재 확인`
    );

    // 2. 사용자 직접 입력(Custom) 도시 추가 검증 (POST /api/custom-destinations)
    const customRes = await fetch(`${base}/api/custom-destinations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: 'HEL',
        city: '헬싱키',
        country: '핀란드',
        region: '유럽',
        avg2YKrw: 980000
      })
    });
    const customData = await customRes.json();
    if (!customRes.ok || customData.destination?.code !== 'HEL') {
      throw new Error('사용자 직접 입력 도시 추가 실패');
    }
    console.log(
      `✅ [2/7] 사용자 직접 입력 도시(Custom IATA) 추가 통과: ${customData.destination.city}(${customData.destination.code}) · 2년 최저가 ${customData.destination.benchmark2Y.lowest2YKrw.toLocaleString()}원`
    );

    // 3. 대한민국 전체 공항 통합(ALL_KOREA) 기준 향후 6개월 이내 무조건 가장 싼 금액순 TOP 10 / TOP 20 / TOP 30 3단 구분 검증
    const top30Res = await fetch(
      `${base}/api/anywhere-top10?origin=ALL_KOREA&region=ALL&sortBy=LOWEST_PRICE&limit=30&adults=2&children=0&infants=1`
    );
    const top30Data = await top30Res.json();
    if (
      !top30Res.ok ||
      !top30Data.tiers ||
      top30Data.tiers.top10?.items?.length !== 10 ||
      top30Data.tiers.top20?.items?.length !== 10 ||
      top30Data.tiers.top30?.items?.length !== 10 ||
      top30Data.top30Deals?.length !== 30
    ) {
      throw new Error('향후 6개월 이내 저렴한 항공편 TOP 10 / TOP 20 / TOP 30 3단 구분 API 실패');
    }
    const t10 = top30Data.tiers.top10;
    const t20 = top30Data.tiers.top20;
    const t30 = top30Data.tiers.top30;
    if (t10.maxPriceKrw > t20.minPriceKrw || t20.maxPriceKrw > t30.minPriceKrw) {
      throw new Error('무조건 가장 싼 금액순 오름차순 정렬 불일치');
    }
    const firstDeal = t10.items[0];
    const firstDealLinks = firstDeal.bookingLinks;
    if (
      !firstDeal.origin ||
      firstDeal.origin === 'ALL_KOREA' ||
      firstDeal.origin.length !== 3 ||
      !firstDealLinks?.naverUrl ||
      !firstDealLinks?.outboundNaverUrl ||
      !firstDealLinks?.inboundNaverUrl ||
      !firstDealLinks?.skyscannerUrl ||
      !firstDealLinks?.googleFlightsUrl ||
      !firstDealLinks?.tripComUrl ||
      !firstDealLinks?.outboundAirlineOfficialUrl ||
      !firstDealLinks?.inboundAirlineOfficialUrl
    ) {
      throw new Error('ALL_KOREA 공항 코드 매핑 또는 항공편 예약 링크(bookingLinks) 누락');
    }
    const uniqueOriginAirports = [...new Set(top30Data.top30Deals.map((d) => `${d.originCity}(${d.origin})`))];
    console.log(
      `✅ [3/7] 대한민국 전체 공항 통합(ALL_KOREA) TOP 10 / TOP 20 / TOP 30 & 예약 링크 검증 통과 (총 ${top30Data.scannedCitiesCount}개 도시 스캔):`
    );
    console.log(
      `   ├─ 🇰🇷 선정된 전국 출발 공항 분포: ${uniqueOriginAirports.join(', ')}`
    );
    console.log(
      `   ├─ 🥇 TOP 10 (1~10위): ${t10.minPriceKrw.toLocaleString()}원 ~ ${t10.maxPriceKrw.toLocaleString()}원 (평균 ${t10.avgPriceKrw.toLocaleString()}원) · 1위 ${firstDeal.originCity}(${firstDeal.origin})→${firstDeal.destinationCity}(${firstDeal.destination})`
    );
    console.log(
      `   ├─ 🥈 TOP 20 (11~20위): ${t20.minPriceKrw.toLocaleString()}원 ~ ${t20.maxPriceKrw.toLocaleString()}원 (평균 ${t20.avgPriceKrw.toLocaleString()}원) · 11위 ${t20.items[0].originCity}(${t20.items[0].origin})→${t20.items[0].destinationCity}(${t20.items[0].destination})`
    );
    console.log(
      `   ├─ 🥉 TOP 30 (21~30위): ${t30.minPriceKrw.toLocaleString()}원 ~ ${t30.maxPriceKrw.toLocaleString()}원 (평균 ${t30.avgPriceKrw.toLocaleString()}원) · 21위 ${t30.items[0].originCity}(${t30.items[0].origin})→${t30.items[0].destinationCity}(${t30.items[0].destination})`
    );
    console.log(
      `   └─ 🔗 예약 링크 생성 확인: 네이버(${firstDealLinks.naverUrl.slice(0, 48)}...) / 스카이스캐너 / 구글플라이트 / 트립닷컴 / 항공사 공식(${firstDealLinks.outboundAirlineOfficialUrl})`
    );

    // 4. 직접 추가한 도시(HEL) 기준 단일 출발일 귀국 일정별 가격 매트릭스 검증 (ALL_KOREA 지원)
    const matrixRes = await fetch(
      `${base}/api/return-date-matrix?origin=ALL_KOREA&destination=HEL&departureDate=2026-11-18&adults=2&children=0&infants=1&maxStayDays=10`
    );
    const matrixData = await matrixRes.json();
    if (!matrixRes.ok || !matrixData.outboundLeg || matrixData.returnOptions?.length !== 10) {
      throw new Error('귀국 일정별 가격 매트릭스 API 실패');
    }
    console.log(
      `✅ [4/7] 직접 추가 도시(HEL) 출발일 지정 → 귀국 일정별(1박~10박) 가격표 통과: 최저가 귀국일 ${matrixData.cheapestOption.returnDate} 합산 ${matrixData.cheapestOption.combinedAdultPriceKrw.toLocaleString()}원`
    );

    // 5. 노선별 저렴한 일정 자동 제안 검증
    const recRes = await fetch(
      `${base}/api/schedule-recommendations?origin=ICN&destination=PQC&minNights=3&maxNights=5&adults=2&children=1&infants=1`
    );
    const recData = await recRes.json();
    if (!recRes.ok || !recData.recommendations?.length) {
      throw new Error('저렴한 추천 일정 API 실패');
    }
    console.log(
      `✅ [5/7] 푸꾸옥(PQC) 저렴한 일정 자동 제안 통과: 1위 ${recData.recommendations[0].departureDate}~${recData.recommendations[0].returnDate} 합산 ${recData.recommendations[0].combinedAdultPriceKrw.toLocaleString()}원`
    );

    // 6. 성인/소아/유아 포함 편도조합 알림 규칙 등록 검증
    const createRes = await fetch(`${base}/api/rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origin: 'ICN',
        destination: 'PQC',
        departureDate: '2026-11-24',
        returnDate: '2026-11-28',
        directOnly: true,
        adults: 2,
        children: 1,
        infants: 1,
        targetPrice: 265000
      })
    });
    const created = await createRes.json();
    if (!createRes.ok || !created.rule?.outboundLeg || created.rule.infants !== 1) {
      throw new Error('편도조합 및 유아 포함 규칙 등록 실패');
    }
    console.log(
      `✅ [6/7] 편도 개별 합산 & 유아 인원 등록 통과: 1인 합산 ${created.rule.currentLowestPrice.toLocaleString()}원 · 가족 총액(${created.rule.passengerPricing.passengerSummaryText}) ${created.rule.passengerPricing.totalPassengersPriceKrw.toLocaleString()}원`
    );

    // 7. 특가 급락 시뮬레이션 & 카카오톡 알림 카드 생성 검증
    const checkRes = await fetch(`${base}/api/rules/${created.rule.id}/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ forceTargetHit: true, forceNotify: true })
    });
    const checked = await checkRes.json();
    if (!checkRes.ok || !checked.isTargetReached || !checked.notificationResult) {
      throw new Error('특가 급락 시뮬레이션 및 카카오톡 발송 실패');
    }
    console.log(
      `✅ [7/7] 특가 급락 시뮬레이션 & 카카오톡 카드 생성 통과: 1인 합산 ${checked.offer.priceKrw.toLocaleString()}원`
    );
    console.log('🎉 모든 v2.1 검증 테스트를 통과했습니다!');
  } finally {
    server.close();
  }
}

runTests().catch((err) => {
  console.error('❌ 테스트 실패:', err);
  process.exit(1);
});
