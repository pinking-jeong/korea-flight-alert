/**
 * Vercel 함수 진입점 — /api/* 요청은 vercel.json 의 rewrites 로 모두 이 함수로 온다 (경로 이름은 ?route= 로도 전달)
 * 키·PIN 은 Vercel 환경 변수(ACCESS_PIN, SERPAPI_KEY, TRAVELPAYOUTS_TOKEN)에만 둔다
 */
const { createRouter } = require('../lib/router');

module.exports = createRouter({ env: process.env });
