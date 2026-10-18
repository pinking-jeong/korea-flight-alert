/**
 * 로컬 Express 서버(src/server.js) API 회귀 테스트
 * - 임시 데이터 폴더(SKYBELL_DATA_DIR)를 써서 실제 data/store.json은 건드리지 않습니다.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skybell-api-test-'));
process.env.SKYBELL_DATA_DIR = dataDir;

const cron = require('node-cron');
const app = require('../src/server');
const { fetchLowestRoundTripPrice } = require('../src/services/flightApiService');

const storeFile = path.join(dataDir, 'store.json');
let server;
let base;

function futureDate(days) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

async function call(method, url, body) {
  const options = { method };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  const res = await fetch(`${base}${url}`, options);
  return { status: res.status, body: await res.json() };
}

function resetStore() {
  fs.rmSync(storeFile, { force: true });
}

function writeStore(store) {
  fs.writeFileSync(storeFile, JSON.stringify(store), 'utf8');
}

function filesStartingWith(prefix) {
  return fs.readdirSync(dataDir).filter((f) => f.startsWith(prefix));
}

// 이전 엔진(무작위 변동)으로 마지막 조회된 것처럼 가격이 어긋난 v3 규칙
function staleV3Rule(overrides = {}) {
  return {
    id: 'rule_stale',
    origin: 'PUS',
    destination: 'TPE',
    departureDate: futureDate(40),
    returnDate: futureDate(44),
    directOnly: true,
    adults: 2,
    children: 0,
    infants: 0,
    targetPrice: 100000,
    currentLowestPrice: 999999,
    previousPrice: 888888,
    isActive: true,
    ...overrides
  };
}

before(() => {
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('모듈로 불러올 때는 3시간 주기 cron을 등록하지 않는다 (npm test가 끝나야 함)', () => {
  assert.equal(cron.getTasks().size, 0);
});

test('스키마 v3 store.json을 v4로 올릴 때 규칙·이력·알림·사용자 도시를 보존한다', async () => {
  const legacyStore = {
    schemaVersion: 3,
    customDestinations: [
      {
        code: 'HEL',
        city: '헬싱키',
        country: '핀란드',
        region: '유럽',
        basePriceKrw: 980000,
        flightDuration: '직접 등록 노선',
        benchmark2Y: { avg2YKrw: 980000, lowest2YKrw: 529000, top10Deal2YKrw: 706000, peakHigh2YKrw: 1686000 }
      }
    ],
    settings: { preferredDataSource: 'AUTO', cooldownHours: 6, kakaoRestApiKey: '' },
    watchRules: [
      {
        id: 'rule_user_kept',
        origin: 'PUS',
        destination: 'TPE',
        departureDate: futureDate(40),
        returnDate: futureDate(44),
        directOnly: true,
        adults: 2,
        children: 0,
        infants: 0,
        targetPrice: 230000,
        currentLowestPrice: 241000,
        isActive: true,
        watchKey: 'PUS-TPE-x-y-DIRECT'
      }
    ],
    priceHistories: [{ id: 'ph_kept', ruleId: 'rule_user_kept', priceKrw: 241000, recordedAt: new Date().toISOString() }],
    notificationLogs: [{ id: 'noti_kept', ruleId: 'rule_user_kept', routeSummary: '부산 ↔ 타이베이', notifiedPrice: 241000 }],
    apiQuotaStats: { amadeusCallsThisMonth: 0, simulationCallsThisMonth: 42, deduplicatedSavedCalls: 3 }
  };
  fs.writeFileSync(storeFile, JSON.stringify(legacyStore), 'utf8');

  const dashboard = (await call('GET', '/api/dashboard')).body;
  assert.deepEqual(dashboard.watchRules.map((r) => r.id), ['rule_user_kept']);
  assert.deepEqual(dashboard.notificationLogs.map((n) => n.id), ['noti_kept']);
  assert.equal(dashboard.historiesByRule.rule_user_kept.length, 1);
  assert.equal(dashboard.apiQuotaStats.simulationCallsThisMonth, 42);

  const saved = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  assert.equal(saved.schemaVersion, 4);
  assert.equal(saved.settings.cooldownHours, 6);

  const meta = (await call('GET', '/api/meta')).body;
  const hel = meta.destinations.find((d) => d.code === 'HEL');
  assert.equal(hel.benchmark2Y.avg2YKrw, 980000);
  assert.equal(hel.benchmark2Y.monthlyStats2Y.length, 12);
  assert.equal(hel.benchmark2Y.dayOfWeekStats2Y.length, 7);
});

test('가격 추이는 요청한 도착 도시를 따른다 (도쿄 나리타 고정 아님)', async () => {
  resetStore();
  const dep = futureDate(30);
  const ret = futureDate(34);
  const fuk = (await call('GET', `/api/route-price-trend?origin=ICN&destination=FUK&departureDate=${dep}&returnDate=${ret}`)).body;
  const bkk = (await call('GET', `/api/route-price-trend?origin=ICN&destination=BKK&departureDate=${dep}&returnDate=${ret}`)).body;

  assert.equal(fuk.destination, 'FUK');
  assert.match(fuk.destinationCity, /후쿠오카/);
  assert.equal(bkk.destination, 'BKK');
  assert.equal(fuk.stayNights, 4);
  assert.equal(fuk.points.length, 15);
  assert.notDeepEqual(
    fuk.points.map((p) => p.combinedAdultPriceKrw),
    bkk.points.map((p) => p.combinedAdultPriceKrw)
  );
});

test('카카오톡 알림 이력은 한 건씩, 또는 전체를 삭제할 수 있다', async () => {
  resetStore();
  const ruleId = (await call('GET', '/api/dashboard')).body.watchRules[0].id;
  await call('POST', `/api/rules/${ruleId}/notify`);
  await call('POST', `/api/rules/${ruleId}/notify`);
  const before = (await call('GET', '/api/dashboard')).body.notificationLogs;
  assert.ok(before.length >= 2);

  const del = await call('DELETE', `/api/notifications/${before[0].id}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.deletedId, before[0].id);

  const afterOne = (await call('GET', '/api/dashboard')).body.notificationLogs;
  assert.equal(afterOne.length, before.length - 1);

  assert.equal((await call('DELETE', '/api/notifications/noti_does_not_exist')).status, 404);

  const all = await call('DELETE', '/api/notifications');
  assert.equal(all.status, 200);
  assert.equal(all.body.deletedCount, afterOne.length);
  const emptied = (await call('GET', '/api/dashboard')).body;
  assert.equal(emptied.notificationLogs.length, 0);
  assert.equal(emptied.notificationLogsTotal, 0);
});

test('모든 도착 도시가 월별 12개·요일별 7개의 가는 편/오는 편 평균을 제공한다', async () => {
  resetStore();
  const meta = (await call('GET', '/api/meta')).body;
  for (const dest of meta.destinations) {
    assert.equal(dest.benchmark2Y.monthlyStats2Y.length, 12, `${dest.code} 월별`);
    assert.equal(dest.benchmark2Y.dayOfWeekStats2Y.length, 7, `${dest.code} 요일별`);
  }
});

test('v3에서 옮겨 온 규칙의 옛 가격은 첫 조회 때 알림 없이 현재 가격으로 맞추고, v3 원본 파일은 백업한다', async () => {
  const rule = staleV3Rule();
  writeStore({ schemaVersion: 3, settings: {}, customDestinations: [], watchRules: [rule], priceHistories: [], notificationLogs: [] });

  const dashboard = (await call('GET', '/api/dashboard')).body;
  const migrated = dashboard.watchRules.find((r) => r.id === 'rule_stale');
  const { offer } = await fetchLowestRoundTripPrice(rule, {});
  assert.equal(migrated.currentLowestPrice, offer.priceKrw);
  assert.equal(migrated.previousPrice, 888888, '이전 가격 기록은 그대로');
  assert.equal(dashboard.notificationLogsTotal, 0, '조용히 맞춤 (알림 없음)');
  assert.equal((dashboard.historiesByRule.rule_stale || []).length, 0, '가격 이력도 만들지 않음');

  const saved = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  assert.equal(saved.watchRules[0].needsReprice, undefined);
  assert.ok(
    filesStartingWith('store.backup-v3-').some((f) => fs.readFileSync(path.join(dataDir, f), 'utf8').includes('"rule_stale"')),
    'v3 원본 백업 파일'
  );
});

test('v3 저장소의 문자열 버전·빠진 배열·잘못된 규칙도 샘플로 바꾸지 않고 사용자 데이터만 옮긴다', async () => {
  writeStore({ schemaVersion: '3', settings: {}, watchRules: [null, 'broken', staleV3Rule({ id: 'rule_ok' })] });

  const res = await call('GET', '/api/dashboard');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.watchRules.map((r) => r.id), ['rule_ok']);
  assert.equal(res.body.notificationLogsTotal, 0, '샘플 알림을 끼워 넣지 않음');
  assert.deepEqual(Object.keys(res.body.historiesByRule), [], '샘플 가격 이력을 끼워 넣지 않음');
});

test('손상된 store.json은 지우지 않고 옆에 보관한 뒤 새 저장소로 시작한다', async () => {
  const broken = '{"schemaVersion":3,"watchRules":[{"id":"precious_rule"';
  fs.writeFileSync(storeFile, broken, 'utf8');

  assert.equal((await call('GET', '/api/dashboard')).status, 200);
  assert.ok(
    filesStartingWith('store.corrupt-').some((f) => fs.readFileSync(path.join(dataDir, f), 'utf8') === broken),
    '손상된 원본이 store.corrupt-*.json 으로 남아 있어야 함'
  );
});

test('BOM 이 붙은 store.json(메모장·PowerShell 저장)도 손상으로 보지 않고 그대로 읽는다', async () => {
  resetStore();
  await call('GET', '/api/dashboard');
  const store = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  store.watchRules[0].id = 'rule_bom_marker';
  fs.writeFileSync(storeFile, String.fromCharCode(0xfeff) + JSON.stringify(store), 'utf8');
  const corruptBefore = filesStartingWith('store.corrupt-').length;

  const dashboard = await call('GET', '/api/dashboard');
  assert.equal(dashboard.status, 200);
  assert.ok(dashboard.body.watchRules.some((r) => r.id === 'rule_bom_marker'), '사용자 규칙이 그대로 있어야 함');
  assert.equal(filesStartingWith('store.corrupt-').length, corruptBefore, '손상 백업을 만들지 않음');
});

// store.json 읽기가 파일 잠김(EBUSY)으로 실패하는 상황을 흉내 낸다
async function withLockedStore(fn) {
  const realReadFileSync = fs.readFileSync;
  fs.readFileSync = function readFileSyncLocked(file, ...rest) {
    if (path.resolve(String(file)) === path.resolve(storeFile)) {
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    }
    return realReadFileSync.call(this, file, ...rest);
  };
  try {
    return await fn();
  } finally {
    fs.readFileSync = realReadFileSync;
  }
}

test('store.json 을 읽다 난 I/O 오류(파일 잠김 등)는 손상으로 보지 않고 저장소를 그대로 둔다', async () => {
  resetStore();
  await call('GET', '/api/dashboard');
  const original = fs.readFileSync(storeFile, 'utf8');
  const corruptBefore = filesStartingWith('store.corrupt-').length;

  const res = await withLockedStore(() => call('GET', '/api/dashboard'));
  assert.equal(res.status, 500, '오류로 알림');
  assert.equal(fs.readFileSync(storeFile, 'utf8'), original, '저장소 내용이 그대로여야 함');
  assert.equal(filesStartingWith('store.corrupt-').length, corruptBefore, '손상 백업을 만들지 않음');
});

test('저장소를 못 읽을 때 /api/meta 와 동기 API 도 HTML 이 아니라 JSON 오류(500)로 답한다 (화면이 서버 없음으로 오해하지 않게)', async () => {
  resetStore();
  await call('GET', '/api/dashboard');
  const responses = await withLockedStore(() =>
    Promise.all([fetch(`${base}/api/meta`), fetch(`${base}/api/notifications/any_id`, { method: 'DELETE' })])
  );
  for (const res of responses) {
    assert.equal(res.status, 500, res.url);
    assert.match(res.headers.get('content-type') || '', /application\/json/, res.url);
    assert.ok((await res.json()).error, res.url);
  }
});

test('사용자가 추가한 도시도 재조회·일괄 조회 가격이 등록 가격과 같고, 카톡 메시지에 그 도시 이름이 나온다', async () => {
  resetStore();
  await call('POST', '/api/custom-destinations', { code: 'HEL', city: '헬싱키', country: '핀란드', region: '유럽', avg2YKrw: 980000 });
  const created = await call('POST', '/api/rules', {
    origin: 'ICN', destination: 'HEL', departureDate: futureDate(30), returnDate: futureDate(34),
    targetPrice: 500000, directOnly: true, adults: 1, children: 0, infants: 0
  });
  assert.equal(created.status, 201);
  const { id, currentLowestPrice: registered } = created.body.rule;

  const checked = await call('POST', `/api/rules/${id}/check`, {});
  assert.equal(checked.body.offer.priceKrw, registered, '재조회 가격');
  assert.equal(checked.body.notificationResult, null, '목표가에 못 미치면 알림 없음');

  await call('POST', '/api/batch-check');
  const afterBatch = (await call('GET', '/api/dashboard')).body.watchRules.find((r) => r.id === id);
  assert.equal(afterBatch.currentLowestPrice, registered, '일괄 조회 가격');

  const notified = await call('POST', `/api/rules/${id}/notify`);
  assert.match(notified.body.notificationResult.routeSummary, /헬싱키/);
});

test('목록에 없는 공항 코드를 직접 입력해 등록해도 등록 전후의 가격이 같다', async () => {
  resetStore();
  const dep = futureDate(30);
  const ret = futureDate(34);
  const matrixPrice = async () =>
    (await call('GET', `/api/return-date-matrix?origin=ICN&destination=ZQX&departureDate=${dep}`)).body.returnOptions.find(
      (o) => o.returnDate === ret
    ).combinedAdultPriceKrw;

  const before = await matrixPrice();
  const created = await call('POST', '/api/rules', {
    origin: 'ICN', destination: 'ZQX', departureDate: dep, returnDate: ret,
    targetPrice: before, directOnly: true, adults: 1, children: 0, infants: 0
  });
  assert.equal(created.body.rule.currentLowestPrice, before, '등록 가격');
  assert.equal(await matrixPrice(), before, '등록 뒤 귀국일표 가격');
});

test('다른 사이트에서 보낸 요청에는 CORS 허용 헤더를 주지 않는다 (일괄 삭제 API 보호)', async () => {
  const preflight = await fetch(`${base}/api/rules`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'DELETE' }
  });
  assert.equal(preflight.headers.get('access-control-allow-origin'), null);

  const read = await fetch(`${base}/api/settings`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(read.headers.get('access-control-allow-origin'), null);
});

test('추천 일정의 최대 박수와 인원 수에는 상한이 있어 한 번의 요청이 서버를 오래 붙잡지 않는다', async () => {
  resetStore();
  const pax = 'adults=60000&children=60000&infants=60000';
  const started = Date.now();
  const recommend = await call('GET', `/api/schedule-recommendations?origin=ICN&destination=FUK&minNights=2&maxNights=5000&${pax}`);
  const top = await call('GET', `/api/anywhere-top10?origin=ALL_KOREA&region=ALL&limit=30&${pax}`);
  const elapsed = Date.now() - started;

  assert.equal(recommend.status, 200);
  assert.equal(top.status, 200);
  assert.ok(elapsed < 3000, `${elapsed}ms`);
});
