/**
 * 가격 출처 표시: 실제 운임 API 를 거치지 않은 가격(계산식으로 만든 모의 값)은 카카오톡 알림에서도 모의 가격이라고 밝힌다.
 * 2026-10-19 기준 실제 운임을 받아 오는 연결은 없다 (Amadeus 셀프서비스는 2026-07-17 종료, Travelpayouts 조회 코드는 없음).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { buildKakaoAlertTemplate } = require('../src/services/kakaoService');
const {
  LIVE_FARE_SOURCE_APIS,
  CACHED_FARE_SOURCE_APIS,
  isSimulatedFareSource,
  fetchLowestRoundTripPrice
} = require('../src/services/flightApiService');
const { createNotificationLogEntry } = require('../src/services/schedulerService');

// Amadeus 토큰·편도 검색 응답을 흉내 낸다 (실제 네트워크 호출 없음)
function stubAmadeusFetch() {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/v1/security/oauth2/token')) {
      return new Response(JSON.stringify({ access_token: 'stub-token', expires_in: 1799 }), { status: 200 });
    }
    const offer = {
      price: { grandTotal: '150000' },
      validatingAirlineCodes: ['KE'],
      itineraries: [
        { segments: [{ carrierCode: 'KE', number: '845', departure: { at: '2027-01-01T09:00:00' }, arrival: { at: '2027-01-01T10:30:00' } }] }
      ]
    };
    return new Response(JSON.stringify({ data: [offer], dictionaries: { carriers: { KE: 'KOREAN AIR' } } }), { status: 200 });
  };
  return { calls, restore: () => { global.fetch = original; } };
}

function futureDate(days) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

const RULE = {
  id: 'rule_price_source',
  origin: 'ICN',
  destination: 'TAO',
  departureDate: futureDate(40),
  returnDate: futureDate(43),
  adults: 1,
  children: 0,
  infants: 0,
  directOnly: true,
  targetPrice: 120000
};

test('운임 API 키가 없으면 가격은 모의 엔진에서 나오고 출처도 모의 엔진으로 남는다', async () => {
  const { usedProvider, offer } = await fetchLowestRoundTripPrice(RULE, {});
  assert.equal(usedProvider, 'SIMULATION');
  assert.equal(offer.sourceApi, 'ONEWAY_COMBO_ENGINE');
});

test('모의 가격으로 만든 카카오톡 알림은 제목·설명·미리보기에 모의 가격임을 밝힌다', async () => {
  const { offer } = await fetchLowestRoundTripPrice(RULE, {});
  const built = buildKakaoAlertTemplate(RULE, offer);

  assert.equal(built.isSimulatedPrice, true);
  assert.match(built.templateObject.content.title, /모의 가격/);
  assert.match(built.templateObject.content.description, /실제 운임은 예약 사이트에서 확인/);
  assert.match(built.templateObject.item_content.profile_text, /모의 가격/);
  assert.match(built.messagePreview, /모의 가격/);
});

test('Amadeus 테스트 환경 결과(제한된 캐시 데이터)는 실제 운임으로 치지 않고, 운영 환경 결과만 실제 운임이다', async () => {
  const stub = stubAmadeusFetch();
  try {
    const keys = { amadeusClientId: 'stub-id', amadeusClientSecret: 'stub-secret' };
    const testEnv = await fetchLowestRoundTripPrice(RULE, { ...keys, amadeusEnv: 'test' });
    const production = await fetchLowestRoundTripPrice(RULE, { ...keys, amadeusEnv: 'production' });

    assert.equal(testEnv.usedProvider, 'AMADEUS');
    assert.equal(isSimulatedFareSource(testEnv.offer.sourceApi), true, '테스트 환경');
    assert.equal(production.usedProvider, 'AMADEUS');
    assert.equal(isSimulatedFareSource(production.offer.sourceApi), false, '운영 환경');
    assert.ok(stub.calls.some((u) => u.startsWith('https://test.api.amadeus.com/')));
    assert.ok(stub.calls.some((u) => u.startsWith('https://api.amadeus.com/')));
  } finally {
    stub.restore();
  }
});

test('화면(app.js)의 실제 운임 출처 목록이 서버 목록과 같다 (한쪽만 바꾸면 화면과 카톡 표시가 어긋난다)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  for (const [name, expected] of [
    ['LIVE_FARE_SOURCE_APIS', LIVE_FARE_SOURCE_APIS],
    ['CACHED_FARE_SOURCE_APIS', CACHED_FARE_SOURCE_APIS]
  ]) {
    const m = src.match(new RegExp(`const ${name} = (\\[[^\\]]*\\]);`));
    assert.ok(m, `app.js 에 ${name} 목록이 있어야 한다`);
    assert.deepEqual(JSON.parse(m[1].replace(/'/g, '"')), expected, name);
  }
});

test('offer 없이 보내는 수동 알림은 규칙에 남은 출처로 판단한다 (출처가 없던 옛 규칙도 모의 가격)', async () => {
  const { offer } = await fetchLowestRoundTripPrice(RULE, {});
  const savedRule = { ...RULE, currentLowestPrice: offer.priceKrw, outboundLeg: offer.outboundLeg, inboundLeg: offer.inboundLeg };

  assert.equal(buildKakaoAlertTemplate({ ...savedRule, sourceApi: 'ONEWAY_COMBO_ENGINE' }, null).isSimulatedPrice, true);
  assert.equal(buildKakaoAlertTemplate(savedRule, null).isSimulatedPrice, true, '출처가 없던 규칙');
  assert.equal(buildKakaoAlertTemplate({ ...savedRule, sourceApi: 'AMADEUS_ONEWAY_COMBO' }, null).isSimulatedPrice, false);
});

test('실제 운임 API(Amadeus)로 받은 가격이면 모의 표시를 붙이지 않는다', async () => {
  const { offer } = await fetchLowestRoundTripPrice(RULE, {});
  const built = buildKakaoAlertTemplate(RULE, { ...offer, sourceApi: 'AMADEUS_ONEWAY_COMBO' });

  assert.equal(built.isSimulatedPrice, false);
  assert.doesNotMatch(built.templateObject.content.title, /모의/);
  assert.doesNotMatch(built.templateObject.content.description, /모의/);
  assert.doesNotMatch(built.templateObject.item_content.profile_text, /모의/);
  assert.doesNotMatch(built.messagePreview, /모의/);
});

test('알림 이력에 모의 가격 여부가 남는다 (화면 미리보기가 이 값을 읽고, 값이 없으면 모의 가격으로 본다)', async () => {
  const { offer } = await fetchLowestRoundTripPrice(RULE, {});
  const simulated = createNotificationLogEntry(RULE.id, buildKakaoAlertTemplate(RULE, offer), new Date().toISOString());
  const live = createNotificationLogEntry(
    RULE.id,
    buildKakaoAlertTemplate(RULE, { ...offer, sourceApi: 'AMADEUS_ONEWAY_COMBO' }),
    new Date().toISOString()
  );

  assert.equal(simulated.isSimulatedPrice, true);
  assert.equal(live.isSimulatedPrice, false);

  const { isSimulatedPrice: _omitted, ...sentWithoutFlag } = buildKakaoAlertTemplate(RULE, offer);
  assert.equal(createNotificationLogEntry(RULE.id, sentWithoutFlag, new Date().toISOString()).isSimulatedPrice, true);
});
