/**
 * scripts/sync-proxy-engine.js
 * 실제 운임 프록시(proxy/, Vercel 에 따로 배포)가 앱과 같은 계산(귀국일표·추천 일정·TOP 30 묶음·예약 링크)을 쓰도록
 * 엔진 파일 두 개를 proxy/lib/engine/ 아래로 그대로 복사한다. 상대 경로(require('../config/airports'))도 그대로 맞는다.
 * test/proxy-engine-sync.test.js 가 원본과 사본이 같은지 확인하므로 엔진을 고치면 이 스크립트를 다시 실행한다.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const ENGINE_FILES = [
  ['src/config/airports.js', 'proxy/lib/engine/config/airports.js'],
  ['src/services/flightApiService.js', 'proxy/lib/engine/services/flightApiService.js']
];

function syncProxyEngine() {
  for (const [from, to] of ENGINE_FILES) {
    const target = path.join(ROOT, to);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ROOT, from), target);
  }
}

if (require.main === module) {
  syncProxyEngine();
  console.log('✅ Synced engine files -> proxy/lib/engine/');
}

module.exports = { ENGINE_FILES, syncProxyEngine };
