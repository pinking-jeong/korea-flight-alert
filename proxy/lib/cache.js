/**
 * 함수 인스턴스 메모리 캐시 (만료 시간 + 개수 상한, 오래 안 쓴 것부터 버림)
 * - 같은 키를 동시에 요청하면 실제 API 는 한 번만 부른다 (무료 한도 보호).
 * - 실패한 결과는 캐시하지 않는다.
 */
function createTtlCache({ maxEntries = 500, now = Date.now } = {}) {
  const entries = new Map(); // Map 의 순서 = 최근 사용 순서
  const inflight = new Map();

  function get(key) {
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now()) {
      entries.delete(key);
      return undefined;
    }
    entries.delete(key);
    entries.set(key, entry);
    return entry.value;
  }

  function set(key, value, ttlMs) {
    entries.delete(key);
    entries.set(key, { value, expiresAt: now() + ttlMs, storedAt: now() });
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  }

  function storedAt(key) {
    return entries.get(key)?.storedAt;
  }

  async function getOrLoad(key, ttlMs, loader) {
    const hit = get(key);
    if (hit !== undefined) return { value: hit, cached: true, storedAt: storedAt(key) };
    if (inflight.has(key)) return inflight.get(key);
    const pending = (async () => {
      try {
        const value = await loader();
        set(key, value, ttlMs);
        return { value, cached: false, storedAt: storedAt(key) };
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, pending);
    return pending;
  }

  return { get, set, getOrLoad };
}

module.exports = { createTtlCache };
