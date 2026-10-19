/**
 * 쿼리 값 검증 — 실제 API 로 넘어가는 값은 모두 여기서 형식과 범위를 확인한다
 */
const MAX_DAYS_AHEAD = 330; // 항공권 판매·검색이 되는 대략의 범위

function fail(error) {
  return { ok: false, error };
}

function parseIata(value) {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? { ok: true, value: code } : fail('공항 코드는 영문 3글자여야 합니다.');
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86400000);
}

function isRealDate(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

function parseDate(value, { today = todayUtc(), maxDaysAhead = MAX_DAYS_AHEAD } = {}) {
  const iso = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || !isRealDate(iso)) return fail('날짜는 YYYY-MM-DD 형식이어야 합니다.');
  const ahead = daysBetween(today, iso);
  if (ahead < 0) return fail('지난 날짜는 조회할 수 없습니다.');
  if (ahead > maxDaysAhead) return fail(`${maxDaysAhead}일 이후 날짜는 조회할 수 없습니다.`);
  return { ok: true, value: iso };
}

function parseMonth(value, { today = todayUtc() } = {}) {
  const ym = String(value || '').trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) return fail('연월은 YYYY-MM 형식이어야 합니다.');
  if (ym < today.slice(0, 7)) return fail('지난 달은 조회할 수 없습니다.');
  return { ok: true, value: ym };
}

function parseIntInRange(value, { min, max, fallback } = {}) {
  if ((value === undefined || value === '') && fallback !== undefined) return { ok: true, value: fallback };
  const text = String(value ?? '').trim();
  if (!/^-?\d+$/.test(text)) return fail(`${min}~${max} 사이 정수여야 합니다.`);
  const n = Number(text);
  return n >= min && n <= max ? { ok: true, value: n } : fail(`${min}~${max} 사이 정수여야 합니다.`);
}

function parseBool(value, fallback) {
  if ((value === undefined || value === '') && fallback !== undefined) return { ok: true, value: fallback };
  if (value === 'true' || value === true) return { ok: true, value: true };
  if (value === 'false' || value === false) return { ok: true, value: false };
  return fail('true 또는 false 여야 합니다.');
}

module.exports = { MAX_DAYS_AHEAD, todayUtc, daysBetween, parseIata, parseDate, parseMonth, parseIntInRange, parseBool };
