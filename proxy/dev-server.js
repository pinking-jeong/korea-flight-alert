/**
 * 실제 운임 프록시 로컬 실행 (Vercel 함수와 같은 라우터)
 *   ACCESS_PIN=… SERPAPI_KEY=… TRAVELPAYOUTS_TOKEN=… ALLOWED_ORIGINS=http://localhost:3000 node proxy/dev-server.js
 * 테스트·E2E 는 startDevServer({ env, fetchImpl }) 로 가짜 상류 API 를 끼워 쓴다.
 */
const http = require('http');
const { createRouter } = require('./lib/router');

function startDevServer({ port = 8787, host = '127.0.0.1', env = process.env, fetchImpl = fetch, failureDelayMs, log } = {}) {
  const handle = createRouter({ env, fetchImpl, failureDelayMs, log });
  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('{"error":"internal","code":"INTERNAL"}');
      }
    });
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

if (require.main === module) {
  startDevServer({ port: Number(process.env.PORT) || 8787 }).then((server) => {
    console.log(`실제 운임 프록시: http://127.0.0.1:${server.address().port}/api/session`);
  });
}

module.exports = { startDevServer };
