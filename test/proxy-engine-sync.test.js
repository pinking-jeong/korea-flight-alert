/**
 * 프록시(proxy/lib/engine)가 쓰는 엔진 사본이 앱 원본과 같아야 실제 운임 화면과 앱의 계산 방식이 어긋나지 않는다
 * 엔진을 고친 뒤 이 테스트가 실패하면: node scripts/sync-proxy-engine.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { ENGINE_FILES } = require('../scripts/sync-proxy-engine');

test('프록시의 엔진 사본(airports.js·flightApiService.js)이 원본과 바이트 단위로 같다', () => {
  const root = path.join(__dirname, '..');
  for (const [from, to] of ENGINE_FILES) {
    const original = fs.readFileSync(path.join(root, from));
    const copy = fs.readFileSync(path.join(root, to));
    assert.ok(original.equals(copy), `${to} 가 ${from} 와 다르다 → node scripts/sync-proxy-engine.js`);
  }
});
