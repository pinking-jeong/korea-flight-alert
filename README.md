# ✈️ SkyBell KR (대한민국 출발 국제 항공권 편도조합 최저가 알림 & 스마트 탐색기)

> **GitHub Repository**: [https://github.com/pinking-jeong/korea-flight-alert](https://github.com/pinking-jeong/korea-flight-alert)  
> **Online Web App (GitHub Pages)**: [https://pinking-jeong.github.io/korea-flight-alert/](https://pinking-jeong.github.io/korea-flight-alert/)  
> **Local Server**: `http://localhost:3000` (`npm start`)

대한민국 **전국 7개 국제공항 통합(`ALL_KOREA`: 인천·김포·김해·청주·대구·제주·무안)** 또는 개별 공항에서 출발하는 전 세계 70개+ 주요 도시(및 사용자 직접 입력 공항)의 **출국 편도 + 귀국 편도 최저가 조합(Mix & Match)**을 탐색하고, 목표가 도달 시 **카카오톡 알림**과 **즉시 예약 링크(네이버 항공권, 스카이스캐너, 구글 플라이트, 트립닷컴, 항공사 공식 홈페이지)**를 제공하는 하이브리드 웹 애플리케이션입니다.

> ⚠️ **PIN 을 넣기 전 화면의 가격은 모의 값입니다.** 운임·편명·출발 시각·2년 시세는 계산식으로 만든 값이라 예약 사이트 가격과 다릅니다.
> 화면 맨 위 **🔑 PIN 으로 실제 운임 보기**에 PIN 을 넣으면 TOP 30·시세·일정·±3일 최저가·목표가 알림은 Travelpayouts **최근 검색가**(다른 이용자 검색 — 길게는 1주일 전 값이라 구간마다 검색한 날 표시, 실시간 아님)로 바뀌고, 이전 방식(날짜 지정) 알림의 재조회만 **구글 플라이트 실시간**(SerpApi) 가격을 씁니다. 키는 별도 운임 프록시(Vercel)의 환경 변수에만 있습니다 → [REAL_FARES.md](REAL_FARES.md)

---

## 🌟 핵심 기능 요약

1. **🇰🇷 출항 공항 대한민국 전체 통합 (`ALL_KOREA`) & 개별 공항 선택**
   - `🇰🇷 한국 전체 공항 통합 (인천·김포·김해·청주·대구·제주·무안)` 선택 시, 전국 7개 국제공항 중 노선·날짜별로 가장 저렴한 한국 출발 공항을 자동 탐색하여 카드마다 `🛫 청주(CJJ) 출발`, `🛫 김해(PUS) 출발`, `🛫 인천(ICN) 출발` 배지로 표시합니다.
2. **🏆 도시 미지정 향후 6개월(180일) 무조건 가장 싼 금액순 `TOP 10` · `TOP 20` · `TOP 30` 3단 구분**
   - **🥇 TOP 10 (1위 ~ 10위)**: 10만 원 안팎 초특가 노선
   - **🥈 TOP 20 (11위 ~ 20위)**: 가성비 단·중거리 인기 노선 (`1~20위 누적 보기` 전환 지원)
   - **🥉 TOP 30 (21위 ~ 30위)**: 실속 중거리 휴양지·대도시 노선 (`1~30위 누적 보기` 전환 지원)
3. **🔗 원클릭 항공권 예약 바로가기 딥링크**
   - 가는편 네이버 편도 예약 / 오는편 네이버 편도 예약 / 항공사 공식 홈페이지
   - 네이버 왕복·통합 예약 / 스카이스캐너 / 구글 플라이트 / 트립닷컴(Trip.com)
4. **✈️ 왕복 묶음이 아닌 '출국 편도 + 귀국 편도' 개별 최저가 합산 (Mix & Match)**
   - 서로 다른 항공사 편도 조합으로 기존 왕복 묶음 대비 평균 12~18% 추가 절감
5. **📊 노선별 2년(24개월) 모의 시세: 최저가 · 상위 10% 특가 기준선 · 평균가 벤치마크** (실제 거래 데이터 아님)
6. **🗓️ 단일 출발일 지정 시 돌아오는 일정별(1박 2일 ~ 10박 11일) 귀국 가격 매트릭스**
7. **👨‍👩‍👧‍👦 성인 · 소아(만 2~11세, 80%) · 유아(만 24개월 미만, 10%) 인원별 총액 자동 계산**
8. **✍️ 70개+ 전 세계 도시 검색 & 원하는 도시/공항 코드(IATA) 직접 추가**
9. **🌐 온·오프라인 하이브리드 아키텍처**
   - 로컬 서버(`http://localhost:3000`)에서는 Express + JSON DB + `node-cron` 스케줄러로 동작
   - GitHub Pages 온라인 환경(`https://pinking-jeong.github.io/korea-flight-alert/`)에서는 `public/standaloneEngine.js` 브라우저 독립 엔진 + `localStorage`로 서버 없이도 100% 동일하게 동작
10. **🔑 PIN 실제 운임 모드** ([REAL_FARES.md](REAL_FARES.md))
   - TOP 30 · 앞으로 12개월 시세 · 귀국일표 · 추천 일정 · 가격 추이 · ±3일 최저가 · 목표가 알림은 Travelpayouts 최근 검색가(SerpApi 횟수를 쓰지 않음), 이전 방식(날짜 지정) 알림의 재조회·일괄 조회만 구글 플라이트 실시간(SerpApi 무료 월 250회, 확인 창)
   - 가격 옆 `모의` · `최근 검색가` · `실시간` 표시와 카카오톡 문구로 출처를 구분하고, 실제 조회가 실패하면 그 기능만 모의 가격으로 보여 주며 이유를 표시
   - 구간마다 그 가격을 가져온 사이트에서 같은 항공편을 여는 링크(`가격 출처 Aviasales ↗`·`구글 같은 편 ↗`, 실시간은 `가격 출처 구글 ↗`)를 붙입니다
11. **🔍 ±3일 최저가 찾기** (노선·인원 설정)
   - 입력한 가는 날·오는 날을 각각 앞뒤 3일까지 옮긴 조합(최대 7×7=49개, 지난 날·뒤바뀐 날 제외)에서 편도 합산 최저가 20개를 싼 순서로 보여 주고, 줄마다 입력 일정과의 차이·구간별 예약 링크·`📅 이 일정으로 폼 바꾸기`·`🎯 이 가격 이하 알림`을 붙입니다
12. **🎯 목표가 알림** (날짜 없이 희망 목표가만)
   - 목표가(성인 1인 왕복 = 편도 두 장 합)와 찾을 기간(내일부터 30·60·90·180일)·박수 범위(기본 2~5박)를 정하면 출발일을 하루씩 훑어 목표가 이하인 일정을 출발일마다 1건씩, 최대 20건 찾아 알림 목록과 카카오톡으로 알려 줍니다
   - 앱을 열면 하루 한 번 자동으로 다시 훑고(알림 목록의 `🔍 조회`·상단 `🔄 전체 조회`로 바로 훑기), 로컬 서버는 3시간마다 모의 가격 알림을 훑습니다. 같은 결과는 12시간 안에 다시 보내지 않습니다
   - TOP 30·귀국일표·추천 카드의 `🎯 목표가 알림`은 그 카드 가격을 목표가로 등록합니다. 예전 날짜 지정 알림은 목록에 남아 재조회할 수 있지만 새로 만들지는 않습니다

---

## 🚀 실행 및 빌드 방법

```bash
# 1. 패키지 설치
npm install

# 2. 로컬 서버 실행 (http://localhost:3000)
npm start

# 3. GitHub Pages 온라인용 Standalone 번들 갱신 (src 코드 수정 시 실행)
npm run build:standalone

# 4. 전체 자동 테스트 (엔진·서버·Pages 번들·운임 프록시·화면 로직 — 실제 키·네트워크 없이)
npm test

# 5. (실제 운임 모드) 운임 프록시 로컬 실행 · 엔진 사본 맞추기 — 자세한 내용은 REAL_FARES.md
npm run proxy:dev
npm run sync:proxy
```

---

## 📁 프로젝트 디렉토리 구조

```text
korea-flight-alert/
├── .github/workflows/
│   └── deploy-pages.yml         # main 브랜치 푸시 시 GitHub Pages 자동 빌드·배포 워크플로우
├── data/
│   └── store.json               # 로컬 서버용 영속 데이터 스토어 (목표가 알림, 날짜 지정 알림, 가격 이력, 카톡 로그, 커스텀 도시)
├── public/                      # 프론트엔드 & GitHub Pages 정적 호스팅 루트 (docs/ 는 이 폴더의 빌드 사본)
│   ├── index.html               # 메인 반응형 UI 대시보드 (Tailwind CSS + Chart.js)
│   ├── app.js                   # 프론트엔드 상태 관리 및 하이브리드 apiFetch 클라이언트
│   ├── realFares.js             # PIN 실제 운임 모드: PIN 창·프록시 호출·응답 정리·실패 시 모의 가격 전환
│   ├── flexTargetUi.js          # ±3일 최저가 목록 · 목표가 알림(등록·하루씩 훑기·자동 확인·카드)
│   ├── menuRefresh.js           # 메뉴별 🔍 조회 · 머리글 🔄 전체 조회
│   └── standaloneEngine.js      # 온라인(GitHub Pages) 서버리스 동작을 위한 자동 생성 번들 엔진
├── proxy/                       # 실제 운임 프록시 (별도 Vercel 프로젝트 skybell-fare-proxy)
│   ├── api/index.js             # Vercel 함수 진입점
│   ├── lib/                     # CORS·PIN 잠금·입력 검증·SerpApi·Travelpayouts·운임 달력·TOP 30
│   │   └── engine/              # 앱 계산 엔진 사본 (npm run sync:proxy 로 맞춤)
│   └── vercel.json              # /api/:route → /api 재작성, icn1 지역
├── scripts/
│   ├── build-standalone.js      # src/config/airports.js + src/services/flightApiService.js 번들러 (+ docs/ 동기화)
│   └── sync-proxy-engine.js     # 프록시용 엔진 사본 갱신
├── src/
│   ├── server.js                # Express REST API 서버 및 3시간 주기 node-cron 스케줄러
│   ├── config/
│   │   └── airports.js          # 한국 전체 공항(ALL_KOREA+7개 공항), 70개+ 해외 도시, 2년 시세, 예약 링크 생성기
│   ├── services/
│   │   ├── flightApiService.js  # 편도 조합(Mix & Match) 탐색, TOP 10/20/30, 귀국일 매트릭스, ±3일 최저가, 목표가 일 단위 훑기, 모의 가격 엔진(Amadeus 조회 코드는 2026-07-17 서비스 종료로 동작 안 함)
│   │   ├── targetAlerts.js      # 목표가 알림 검증·훑기·알림 판단·카카오톡 문구 (서버와 Pages 번들이 함께 씀)
│   │   ├── kakaoService.js      # 카카오 OAuth 2.0 및 카카오톡 나에게 보내기 API / 미리보기 빌더
│   │   └── schedulerService.js  # 동일 노선 중복 호출 방지(Deduplication) 및 쿨다운 알림 엔진
│   └── storage/
│       └── db.js                # JSON DB 읽기/쓰기 및 초기 샘플 데이터 시드
└── test/
    ├── verify.js                # API·데이터 무결성 자동 검증 스크립트
    ├── *.test.js                # node --test 시험 (엔진·서버·Pages 번들·프록시·화면 로직)
    └── fixtures/fake-upstream.js # SerpApi·Travelpayouts 가짜 응답 (실제 키·네트워크 없이 시험)
```
