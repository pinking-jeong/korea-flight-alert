/**
 * 가짜 상류 API (SerpApi 구글 플라이트 · Travelpayouts · 공개 환율표·항공사 목록)
 * - 프록시 라우터 테스트와 로컬 E2E(가짜 프록시)에서 실제 네트워크·키 없이 같은 모양의 응답을 준다
 * - 가격은 노선·날짜로 정해지는 고정 값이라 다시 불러도 같다
 */
const DEFAULT_KEYS = { serpapiKey: 'fake-serpapi-key', travelpayoutsToken: 'fake-tp-token' };

// 1단계(도착지 없이) 목록에 나오는 도착지들
const ANYWHERE_DESTINATIONS = ['NRT', 'KIX', 'FUK', 'CTS', 'OKA', 'TPE', 'HKG', 'BKK', 'DAD', 'CEB', 'SIN', 'CDG', 'LHR', 'JFK', 'CJU'];
const AIRLINES = ['7C', 'LJ', 'TW', 'KE', 'OZ', 'ZE'];

function hash(text) {
  let h = 0;
  for (const ch of String(text)) h = (h * 31 + ch.charCodeAt(0)) % 100003;
  return h;
}

function basePrice(from, to) {
  const longHaul = ['CDG', 'LHR', 'JFK'];
  const base = longHaul.includes(from) || longHaul.includes(to) ? 520000 : 70000;
  return base + (hash(`${from}${to}`) % 40) * 1000;
}

function dayPrice(from, to, date) {
  return basePrice(from, to) + (hash(`${from}${to}${date}`) % 30) * 1000;
}

function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function json(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function createFakeUpstream({ keys = DEFAULT_KEYS, now = () => Date.now(), failTravelpayouts = false } = {}) {
  const counts = { serpapiSearches: 0, travelpayouts: 0, rates: 0, airlines: 0 };

  function serpSearch(params) {
    if (params.get('api_key') !== keys.serpapiKey) return json(401, { error: 'Invalid API key.' });
    counts.serpapiSearches += 1;
    const froms = params.get('departure_id').split(',');
    const tos = params.get('arrival_id').split(',');
    const date = params.get('outbound_date');
    const flights = [];
    froms.slice(0, 3).forEach((from) => {
      tos.slice(0, 3).forEach((to) => {
        ['7C', 'KE'].forEach((code, i) => {
          const price = dayPrice(from, to, date) + i * 23000;
          flights.push({
            flights: [
              {
                departure_airport: { name: from, id: from, time: `${date} ${i ? '13:20' : '08:40'}` },
                arrival_airport: { name: to, id: to, time: `${date} ${i ? '15:45' : '11:05'}` },
                duration: 145,
                airline: i ? '대한항공' : '제주항공',
                flight_number: `${code} ${100 + (hash(from + to) % 800) + i}`
              }
            ],
            total_duration: 145,
            price,
            type: 'One way'
          });
        });
      });
    });
    const created = new Date(now()).toISOString().replace('T', ' ').slice(0, 19);
    return json(200, {
      search_metadata: { status: 'Success', created_at: `${created} UTC`, google_flights_url: 'https://www.google.com/travel/flights?hl=ko' },
      best_flights: flights.slice(0, 1),
      other_flights: flights.slice(1)
    });
  }

  function serpAccount(params) {
    if (params.get('api_key') !== keys.serpapiKey) return json(401, { error: 'Invalid API key.' });
    return json(200, {
      account_email: 'someone@example.com',
      api_key: keys.serpapiKey,
      plan_name: 'Free Plan',
      searches_per_month: 250,
      total_searches_left: 250 - counts.serpapiSearches,
      this_month_usage: counts.serpapiSearches,
      this_hour_searches: counts.serpapiSearches,
      account_rate_limit_per_hour: 50
    });
  }

  // 실제 응답처럼 link 에 검색한 날(search_date, 일월년)을 넣는다 — 표마다 0~5일 전
  function searchDateParam(from, to, date) {
    const searched = new Date(now() - (hash(`${from}${to}${date}searched`) % 6) * 86400000);
    const dd = String(searched.getUTCDate()).padStart(2, '0');
    const mm = String(searched.getUTCMonth() + 1).padStart(2, '0');
    return `${dd}${mm}${searched.getUTCFullYear()}`;
  }

  function ticket(from, to, date, price, airline) {
    return {
      origin: from,
      destination: to,
      origin_airport: from,
      destination_airport: to,
      price,
      airline,
      flight_number: String(100 + (hash(from + to + date) % 800)),
      departure_at: `${date}T09:30:00+09:00`,
      transfers: 0,
      return_transfers: 0,
      duration: 150,
      duration_to: 150,
      link: `/search/${from}${date.slice(8, 10)}${date.slice(5, 7)}${to}1?t=FAKE&search_date=${searchDateParam(from, to, date)}`
    };
  }

  function pricesForDates(params, headers) {
    if (failTravelpayouts) return json(500, null);
    if (headers['X-Access-Token'] !== keys.travelpayoutsToken) return json(401, null);
    counts.travelpayouts += 1;
    const origin = params.get('origin') || '';
    const destination = params.get('destination') || '';
    const month = params.get('departure_at');
    const data = [];
    if (origin && destination) {
      for (let day = 1; day <= daysInMonth(month); day++) {
        const date = `${month}-${String(day).padStart(2, '0')}`;
        data.push(ticket(origin, destination, date, dayPrice(origin, destination, date), AIRLINES[hash(date + origin) % AIRLINES.length]));
      }
    } else if (origin) {
      for (const dest of ANYWHERE_DESTINATIONS) {
        const day = 1 + (hash(origin + dest + month) % daysInMonth(month));
        const date = `${month}-${String(day).padStart(2, '0')}`;
        data.push(ticket(origin, dest, date, dayPrice(origin, dest, date), AIRLINES[hash(dest) % AIRLINES.length]));
      }
    }
    data.sort((a, b) => a.price - b.price);
    return json(200, { success: true, currency: 'krw', data });
  }

  async function fetchImpl(url, options = {}) {
    const u = new URL(String(url));
    const headers = options.headers || {};
    if (u.host === 'serpapi.com' && u.pathname === '/search.json') return serpSearch(u.searchParams);
    if (u.host === 'serpapi.com' && u.pathname === '/account.json') return serpAccount(u.searchParams);
    if (u.host === 'api.travelpayouts.com' && u.pathname === '/aviasales/v3/prices_for_dates') return pricesForDates(u.searchParams, headers);
    if (u.host === 'api.travelpayouts.com' && u.pathname === '/data/ko/airlines.json') {
      counts.airlines += 1;
      return json(200, [{ code: 'QW', name: null, name_translations: { en: 'Qingdao Airlines' } }]);
    }
    if (u.host === 'yasen.aviasales.com') {
      counts.rates += 1;
      return json(200, { rub: 1, krw: 0.0631, usd: 84.25 });
    }
    return json(404, { error: 'not found' });
  }

  return { fetchImpl, counts, keys };
}

module.exports = { createFakeUpstream, DEFAULT_KEYS, ANYWHERE_DESTINATIONS };
