// cache.js
// Простой in-memory кэш с TTL. Используется для справочников
// (названия воронок и стадий), которые редко меняются —
// это снижает число обращений к VibeCode API.

const store = new Map();

/**
 * @param {string} key
 * @param {number} ttlMs
 * @param {() => Promise<any>} loader - функция, возвращающая свежие данные
 */
async function getOrLoad(key, ttlMs, loader) {
  const cached = store.get(key);
  const now = Date.now();

  if (cached && now - cached.loadedAt < ttlMs) {
    return cached.value;
  }

  const value = await loader();
  store.set(key, { value, loadedAt: now });
  return value;
}

function invalidate(key) {
  store.delete(key);
}

module.exports = { getOrLoad, invalidate };
