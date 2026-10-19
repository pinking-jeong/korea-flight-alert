# 🔑 실제 운임 모드 (PIN) 운영 가이드

공개 페이지(GitHub Pages)에서 **PIN 을 넣은 사람만** 실제 운임을 볼 수 있게 한 기능입니다.
PIN 을 넣기 전 화면의 가격은 지금처럼 계산식으로 만든 **모의 값**이고, PIN 을 넣으면 같은 화면이 실제 운임으로 바뀝니다.

```text
브라우저 (GitHub Pages · public/realFares.js)
   │  X-Access-Pin 머리글 (PIN 은 이 탭의 sessionStorage 에만 — 탭을 닫으면 지워짐)
   ▼
운임 프록시 (Vercel 함수 · proxy/)  ── CORS 허용 사이트 확인 → PIN 확인(틀리면 잠금) → 입력 검증
   ├─ SerpApi 구글 플라이트  (실시간 · 무료 월 250회)       ← 키: Vercel 환경 변수에만
   └─ Travelpayouts         (최근 검색가 · 분당 600회 한도) ← 토큰: Vercel 환경 변수에만
```

- 프록시 주소: `https://skybell-fare-proxy.vercel.app` (Vercel 프로젝트 `skybell-fare-proxy`, 지역 `icn1`)
- API 키·토큰·PIN 은 **프록시의 환경 변수에만** 있습니다. 저장소·페이지 코드·브라우저에는 없습니다.

---

## 1. 기능별로 어떤 가격을 쓰나

조회량이 많은 기능은 한도가 넉넉한 Travelpayouts 를, 조회 한 번이 비싼 SerpApi 는 알림 조회에만 씁니다.

| 화면 기능 | PIN 모드의 가격 출처 | 화면 표시 |
| :--- | :--- | :--- |
| 최저가 TOP 30 (도시 미지정, 6개월) | Travelpayouts | `최근 검색가` |
| 선택 노선 시세표 (월별·요일별 차트) | Travelpayouts — **앞으로 12개월** | `최근 검색가` |
| 귀국일별 가격표 · 60일 추천 일정 · 가격 추이 차트 | Travelpayouts | `최근 검색가` |
| 폼에서 알림 등록 · 🔍 재조회 · 🔄 일괄 조회 | 구글 플라이트 (SerpApi) | `실시간 M/D HH:MM` |
| 메뉴 머리글의 `🔍 조회` | 그 메뉴의 출처 그대로 다시 조회 — **알림 목록의 조회만** 알림 일괄 조회(SerpApi, 확인 창) | 메뉴마다 위와 같음 |
| 상단 `🔄 전체 조회` | 모든 메뉴(Travelpayouts) + 알림 일괄 조회(SerpApi, 확인 창 — 취소해도 메뉴 값은 다시 불러옴) | 메뉴마다 위와 같음 |
| TOP 30·귀국일표·추천 카드의 `+ 알림 등록` | 그 카드의 최근 검색가 그대로 (SerpApi 횟수 안 씀) | `최근 검색가` |
| ⚡ 급락 시뮬레이션 | 모의 값 (예전과 같음) | `모의` |

- **Travelpayouts 최근 검색가**: 다른 이용자들이 검색한 결과에서 모은 실제 운임입니다. 공식 문서는 '최근 48시간 검색'이라고 하지만, 10-19 TOP 30 의 60구간 가운데 65% 가 하루 넘게 묵었고 가장 오래된 값은 7일 전에 검색됐습니다. 그래서 화면은 구간마다 검색한 날(`10/16 검색 · 3일 전`, 2일 이상 지나면 주황)을 보여 줍니다(프록시가 출처 링크의 `search_date` 를 `searchedOn` 으로 넘김 — 없는 날짜·내일보다 뒤·1년보다 앞은 버림). 실시간 가격이 아니며, 검색이 없던 날은 비어 있습니다. 과거 기록(2년 시세)은 주지 않으므로 PIN 모드의 시세표는 '지난 2년'이 아니라 **이번 달부터 12개월**의 검색가로 바뀝니다. 이 때문에 '2년 평균 대비 할인율'과 그 정렬은 PIN 모드에서 쓰지 않습니다.
- **구글 플라이트 실시간**: 조회 한 번에 가는 편·오는 편 두 번 검색합니다(=2회 사용). 같은 조건은 프록시가 20분, SerpApi 가 1시간 동안 다시 검색하지 않습니다. 일괄 조회는 남은 횟수를 보여 주고 확인을 받은 뒤 실행하며, 정기 조회처럼 알림 간격을 지켜 같은 알림을 거듭 보내지 않습니다.
- 실제 조회가 실패하면 **그 기능만** 모의 가격으로 보여 주고 이유(예: `프록시에 API 키가 아직 없음`, `무료 조회 한도 초과`)를 표시합니다. 단, 재조회는 실패하면 기존 가격을 모의 값으로 덮어쓰지 않고 멈춥니다.
- **실제 운임으로 받아 온 알림은 모의 가격으로 덮어쓰지 않습니다.** PIN 없이(모의 가격 모드에서) 그런 알림을 재조회하면 PIN 을 묻고, 모의 일괄 조회와 서버의 정기 조회는 그런 알림을 건너뛰고 몇 건 건너뛰었는지 알려 줍니다.
- 카카오톡 알림 문구도 출처에 따라 `모의 가격` / `최근 검색가(실시간 아님)` / `실시간 조회가(M/D HH:MM 조회)` 로 구분됩니다. 카카오톡 전송이 실패해도 조회한 가격은 저장하고 실패 이유를 보여 줍니다.

---

## 2. 처음 설정하기 (키 넣기)

### 2.1 키 발급
1. **SerpApi**: <https://serpapi.com> 무료 가입 → Dashboard 의 *Your Private API Key* 복사 (무료 월 250회).
2. **Travelpayouts**: <https://www.travelpayouts.com> 가입 → 프로필(Profile)의 *API token* 복사.

### 2.2 Vercel 환경 변수 (Production)

| 이름 | 필수 | 설명 |
| :--- | :---: | :--- |
| `ACCESS_PIN` | ✅ | 페이지에서 넣을 PIN (숫자 4~8자리). 없으면 모든 요청이 `PIN_NOT_CONFIGURED` |
| `SERPAPI_KEY` | | 없으면 알림 등록·재조회가 모의 가격으로 동작 (화면에 `미설정` 표시) |
| `TRAVELPAYOUTS_TOKEN` | | 없으면 TOP 30·시세·일정이 모의 가격으로 동작 (화면에 `미설정` 표시) |
| `ALLOWED_ORIGINS` | | 쉼표로 구분한 허용 사이트. 기본값 `https://pinking-jeong.github.io,http://localhost:3000,http://127.0.0.1:3000` |
| `TRAVELPAYOUTS_MARKET` | | Travelpayouts `market` 값 (선택). 비우면 Travelpayouts 기본값 |

Vercel 대시보드 → 프로젝트 `skybell-fare-proxy` → Settings → Environment Variables 에서 넣거나, 터미널에서:

```bash
cd proxy
vercel env add SERPAPI_KEY production          # 값을 물으면 붙여 넣기 (화면·기록에 남지 않게)
vercel env add TRAVELPAYOUTS_TOKEN production
vercel deploy --prod                           # 환경 변수는 다시 배포해야 반영됩니다
```

### 2.3 PIN 바꾸기
```bash
cd proxy
vercel env rm ACCESS_PIN production
vercel env add ACCESS_PIN production --sensitive
vercel deploy --prod
```
PIN 을 바꾸면 이미 PIN 을 넣어 둔 탭은 다음 조회 때 `PIN 이 맞지 않음`으로 모의 가격 모드로 돌아갑니다.

---

## 3. PIN 의 한계 (알고 쓰기)

- 잠금 규칙: 한 IP 가 15분 안에 5번 틀리면 그 IP 를 15분, 모든 IP 를 합쳐 10분 안에 30번 틀리면 PIN 입력 전체를 10분 막고, 틀릴 때마다 응답을 0.4초 늦춥니다.
- **숫자 4자리 PIN 은 가벼운 문입니다.** 위 규칙으로도 IP 를 여러 개 쓰는 사람은 하루 4천 번 남짓 시도할 수 있어, 4자리(1만 가지)는 하루 이틀이면 맞출 수 있습니다. 잠금 기록이 함수 인스턴스 메모리에 있어 인스턴스가 바뀌면 초기화되므로 실제로는 더 빠를 수 있습니다.
- **8자리로 바꾸기를 권합니다.** 페이지는 4~8자리를 받으므로 코드는 그대로 두고 2.3 처럼 `ACCESS_PIN` 만 바꾸면 됩니다. 같은 속도로 8자리는 평균 수십 년이 걸립니다.
- 같은 규칙 때문에, 누군가 10분마다 틀린 PIN 을 30번 보내면 그동안은 맞는 PIN 도 막힙니다(전체 잠금).
- 틀린 PIN 은 프록시 기록(Vercel → 프로젝트 `skybell-fare-proxy` → Logs)에 `[fare-proxy] PIN 실패` 로 남습니다. IP 는 알아볼 수 없는 표시로 바꾸고, 넣은 PIN 은 남기지 않습니다. 기록 보관 기간은 Vercel 요금제에 따라 짧을 수 있습니다.
- PIN 이 뚫려도 키는 밖으로 나가지 않으며, 최악의 경우는 **무료 조회 한도가 소진되는 것**입니다 (SerpApi 월 250회). PIN 이 새어 나간 것 같으면 2.3 으로 바꾸고, SerpApi 대시보드에서 사용량을 확인하세요.
- 페이지가 불러오는 외부 스크립트(Tailwind CDN·Chart.js)도 이 탭에 저장된 PIN 을 읽을 수 있는 위치에 있습니다. Chart.js 는 파일 해시(`integrity`)를 확인해 바뀐 파일은 실행하지 않습니다.

---

## 4. 프록시 API

모두 `X-Access-Pin` 머리글이 필요하고, 허용된 사이트(`ALLOWED_ORIGINS`)에서만 브라우저로 부를 수 있습니다.

| 경로 | 공급자 | 내용 |
| :--- | :--- | :--- |
| `POST /api/session` | — | PIN 확인 + 공급자 설정 여부 `{ ok, providers: { serpapi, travelpayouts } }` |
| `GET /api/status` | SerpApi 계정 | 남은 검색 횟수 등 요약 (계정 조회는 검색 횟수에 들어가지 않음) |
| `GET /api/flights` | SerpApi | 가는 편·오는 편 실시간 편도 (알림 등록·재조회용) |
| `GET /api/anywhere-top10` | Travelpayouts | 실제 운임 TOP 30 |
| `GET /api/route-stats` | Travelpayouts | 앞으로 12개월 월별·요일별 가는 편/오는 편 시세 |
| `GET /api/return-date-matrix` · `schedule-recommendations` · `route-price-trend` | Travelpayouts | 앱과 같은 계산(엔진 사본)에 실제 운임 달력을 넣은 결과 |

오류 코드: `PIN_INVALID`(401) · `PIN_LOCKED`(429, `Retry-After`) · `PIN_NOT_CONFIGURED`·`PROVIDER_NOT_CONFIGURED`(503) · `BAD_REQUEST`(400) · `SERPAPI_LIMIT`·`TP_RATE_LIMIT`(429) · `SERPAPI_*`·`TP_*`(502) · `TP_TIME_BUDGET`(504, Travelpayouts 계산이 한 요청 40초 안에 끝나지 않음 — 잠시 뒤 다시 시도). 날짜는 오늘부터 330일 안쪽만 받습니다.

---

## 5. 개발·테스트

- **엔진 사본**: 프록시는 앱 계산 엔진(`src/config/airports.js`, `src/services/flightApiService.js`)의 사본을 `proxy/lib/engine/` 에 둡니다. 엔진을 고치면 `npm run sync:proxy` 로 사본을 맞추세요 (`npm test` 가 사본이 다르면 실패합니다).
- **로컬 프록시**: `ACCESS_PIN=… SERPAPI_KEY=… TRAVELPAYOUTS_TOKEN=… npm run proxy:dev` → `http://127.0.0.1:8787`. 페이지가 로컬 프록시를 쓰게 하려면 페이지를 열기 전에 `window.SKYBELL_PROXY_URL = 'http://127.0.0.1:8787'` 를 넣고, 페이지 주소를 `ALLOWED_ORIGINS` 에 더하세요.
- **테스트**: `npm test` 에 프록시(가짜 상류 API `test/fixtures/fake-upstream.js`)·엔진·서버/Pages 라우트·화면 로직(`test/real-fares-client.test.js`) 시험이 들어 있습니다. 실제 키·네트워크·실제 PIN 없이 돌아갑니다 (시험용 PIN 은 더미 값).
- **배포**: 앱(페이지)은 지금처럼 `npm run build:standalone` 후 `main` 에 푸시하면 Pages 에 반영되고(`docs/realFares.js`·`docs/menuRefresh.js` 포함), 프록시는 `proxy/` 에서 `vercel deploy --prod` 로 따로 배포합니다.

---

## 6. 실제 키로 확인한 결과 (2026-10-19)

공개 페이지에서 PIN 을 넣고 기능을 모두 한 번씩 써 본 결과입니다 (SerpApi 검색 2회 사용).
- **원화**: Travelpayouts 는 `currency=krw` 요청에 원화로 바로 답합니다(환율 환산을 쓰지 않음). 같은 편을 비교하면 11/12 나리타→인천 TW242 가 Travelpayouts 172,804원, 구글 플라이트 176,422원으로 2% 안쪽입니다.
- **노선 수**: TOP 30 은 도착지 40곳을 살펴 30개를 채웠습니다(동남아 15·일본 8·중화권 7). 전국통합↔나리타의 12개월 시세는 가는 편 199일·오는 편 178일에 값이 있고, 가까운 6개월은 촘촘하지만 7~12개월 뒤는 달마다 2~10일뿐입니다.
- **공항 코드**: 응답마다 실제 출발 공항(인천·김해·제주·김포 등)이 들어 있습니다.
- **SerpApi**: 편명(TW257 등)·시각·소요 시간이 정상이고, 출발 공항 여러 곳을 한 번에 검색합니다. 알림 1건 등록에 검색 2회를 씁니다.
- **응답 시간(첫 조회)**: TOP 30 약 9초, 12개월 시세 약 5초, 귀국일표·추천 일정·가격 추이 약 2초, 구글 플라이트 약 4초.
- **항공사 이름**: 구글은 TW 를 'Trinity Airways' 로 적어 앱 이름표를 먼저 쓰게 맞췄습니다. 티웨이항공의 2026년 사명 변경에 맞춰 앱 이름표(`src/config/airports.js`)의 TW 도 '트리니티항공'으로, 공식 홈페이지도 `https://www.trinityairways.com/` 으로 바꿨습니다(옛 주소 `twayair.com/app/main` 은 403). 옛 이름으로 이미 저장된 알림은 다음 조회 때 새 이름으로 바뀝니다.

## 7. 예약 사이트 금액과 다른 이유 (2026-10-19 실측)

배포판의 TOP 30 4건·알림 1건을 예약 페이지(구글 17번·트립닷컴 6번 등, 읽기만)와 맞대 보았습니다 (SerpApi 새 검색 0회).
- **링크 조건은 맞습니다**: TOP 30 30건 모두 링크의 출발 공항·도착지·날짜·인원·직항이 카드와 같았습니다.
- **최근 검색가는 지금 파는 값이 아닙니다**: 같은 편의 지금 구글 값과 −4.8%~+50.9%(중앙값 +11.2%) 달랐고, 출발이 가까울수록 컸습니다(내일 출발 +23%·+51%). → 구간마다 검색한 날을 표시합니다.
- **큰 예약 버튼은 왕복 검색입니다**: 카드 금액은 '편도 두 장 합'인데 네이버·스카이스캐너·구글·트립닷컴 버튼은 왕복을 엽니다. 구간별로 0.0%·−0.1% 맞은 실시간 알림도 구글 왕복 화면은 +0.7~3.3% 달랐습니다. → 버튼 이름에 '왕복'을 붙이고 그 위에 안내를 달았으며, 카드 금액과 같은 기준으로 확인하도록 구간마다 `구글 편도 ↗` 링크를 붙였습니다.
- **2명 이상**: 구글은 일행 총액, 트립닷컴은 1인 가격을 보여 줍니다(앱의 큰 글씨는 1인). 구간별 `구글 편도 ↗` 도 그 인원으로 열리므로 두 구간을 더해 카드의 총액과 견줘야 합니다. → 안내와 링크 설명에 'N명 총액'·'트립닷컴 왕복은 1인 가격'(트립닷컴 버튼이 있는 카드만)을 적고, 소아·유아가 있으면 앱의 금액이 추정값(소아 80%·유아 10%)이라고 적습니다. 인원은 화면 폼이 아니라 그 카드의 링크가 실제로 연 인원(`bookingLinks.bookingMeta`)을 씁니다.
- **Aviasales 링크**: 열면 기대 가격이 지워진 새 검색(영어·달러)으로 바뀌어, 이름을 '출처'에서 `Aviasales 가는 편 ↗`·`Aviasales ↗` 로 바꾸고 새로 검색한다는 설명을 달았습니다.
- **고칠 수 없는 차이**: 사이트마다 파는 편(구글에 없는 TW317 등)·조건부 특가(트립닷컴 '전용 특가')·수하물·환율이 다릅니다.
- PIN 없이 보는 화면은 모의 가격이라 처음부터 예약 사이트와 다릅니다. PIN 은 탭마다 다시 넣어야 합니다(이 탭의 `sessionStorage` 에만 둠).
