/**
 * 화면 스크립트(public/*.js)를 브라우저 없이 VM 에 올리는 시험 도구 (real-fares-client · flex-target-ui 시험이 함께 쓴다)
 * - fetch 는 routes 로 흉내 낸다: 키는 '방법 + /api/ 뒤 경로' (예: 'GET flex-dates') — 실제 운임 프록시 호출이 여기로 온다
 * - withBundle: Pages 번들(소스로 새로 만든 standaloneEngine)을 함께 올려 앱 API(/api/*)를 가짜 localStorage 로 처리한다
 *   (fetch 를 거치지 않으므로 routes 에는 프록시 경로만 넣으면 된다)
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { buildStandaloneSource } = require('../../scripts/build-standalone');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const PROXY_URL = 'http://proxy.test';
// index.html 이 불러오는 순서 그대로
const CLIENT_FILES = ['app.js', 'realFares.js', 'flexTargetUi.js', 'menuRefresh.js'];

// 가짜 요소: 클래스·속성·disabled 를 기록하고, focus() 를 부르면 onFocus 로 알린다 (document.activeElement 로 확인)
// key: 찾은 방법 ('#아이디' 또는 querySelector 선택자) — 어느 요소에 초점이 갔는지 시험에서 읽는다
function fakeElement({ key = '', onFocus = () => {} } = {}) {
  const classes = new Set();
  const attributes = new Map();
  const element = {
    key,
    textContent: '',
    innerHTML: '',
    value: '',
    className: '',
    disabled: false,
    dataset: {},
    style: {},
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle(name, force) {
        const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
      contains: (name) => classes.has(name)
    },
    setAttribute: (name, value) => attributes.set(name, String(value)),
    getAttribute: (name) => (attributes.has(name) ? attributes.get(name) : null),
    removeAttribute: (name) => attributes.delete(name),
    querySelector: () => null,
    closest: () => null,
    focus: () => onFocus(element),
    select() {}
  };
  return element;
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    dump: () => Object.fromEntries(map)
  };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// routes: { 'GET anywhere-top10': (url, options) => response | Error }
function loadClient({ routes = {}, withBundle = false } = {}) {
  const calls = [];
  const elements = new Map();
  const document = {
    activeElement: null,
    focusLog: [], // 초점을 받은 요소의 key 순서
    getElementById(id) {
      return elementFor(`#${id}`);
    },
    // 화면 스크립트는 펼치기 버튼에 초점을 돌려줄 때만 쓴다 (focusRowToggle) — 선택자마다 요소 하나
    querySelector(selector) {
      return elementFor(selector);
    }
  };
  function elementFor(key) {
    if (!elements.has(key)) {
      const onFocus = (element) => {
        document.activeElement = element;
        document.focusLog.push(element.key);
      };
      elements.set(key, fakeElement({ key, onFocus }));
    }
    return elements.get(key);
  }
  const context = {
    window: {
      SKYBELL_PROXY_URL: PROXY_URL,
      addEventListener() {},
      location: { origin: 'https://pinking-jeong.github.io', pathname: '/korea-flight-alert/' }
    },
    document,
    sessionStorage: memoryStorage(),
    localStorage: memoryStorage(),
    console: { log() {}, error() {}, warn() {} },
    // 토스트(4.3초)·요청 시간 제한 타이머가 테스트 프로세스를 붙잡지 않게 한다
    setTimeout: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref();
      return timer;
    },
    clearTimeout,
    AbortController,
    URL,
    URLSearchParams,
    // 구글 플라이트 검색 주소(tfs)를 만들 때 번들이 쓰는 브라우저 기본 함수
    TextEncoder,
    btoa,
    async fetch(url, options = {}) {
      calls.push({ url: String(url), options });
      const u = new URL(String(url));
      const key = `${options.method || 'GET'} ${u.pathname.replace(/^\/api\//, '')}`;
      const handler = routes[key];
      if (!handler) return jsonResponse(404, { error: '없는 경로', code: 'NOT_FOUND' });
      const result = await handler(u, options);
      if (result instanceof Error) throw result;
      return result;
    }
  };
  vm.createContext(context);
  if (withBundle) {
    // 번들은 브라우저에서 window·localStorage 전역을 쓴다 — 함수로 감싸 그 둘만 넘긴다
    vm.runInContext(`(function (window, localStorage) {\n${buildStandaloneSource()}\n})(window, localStorage);`, context, {
      filename: 'standaloneEngine.js'
    });
  }
  for (const file of CLIENT_FILES) {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8'), context, { filename: file });
  }
  const run = (code) => vm.runInContext(code, context);
  if (withBundle) run('state.useStandaloneMode = true;');
  return { context, calls, run, elements };
}

function enableRealMode(client, providers = { serpapi: true, travelpayouts: true }) {
  client.run(`realFareState.enabled = true; realFareState.pin = '2468'; realFareState.providers = ${JSON.stringify(providers)};`);
  client.context.sessionStorage.setItem('SKYBELL_REAL_FARE_PIN', '2468');
}

module.exports = { PUBLIC_DIR, PROXY_URL, CLIENT_FILES, fakeElement, memoryStorage, jsonResponse, loadClient, enableRealMode };
