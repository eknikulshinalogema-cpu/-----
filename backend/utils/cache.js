// cache.js
// Простой in-memory кэш с TTL. Используется для справочников
// (воронки, стадии, сотрудники), которые редко меняются — это снижает
// число обращений к VibeCode API.
//
// Дополнительно (по итогам разбора таймаутов BH_APP_TIMEOUT сразу после
// деплоя): кэш переиспользует уже ИДУЩИЙ запрос для одного и того же
// ключа — если несколько эндпоинтов дашборда (metrics/stages/employees)
// одновременно запрашивают один и тот же справочник при холодном кэше
// (например, сразу после рестарта сервера, когда фронтенд шлёт все три
// запроса параллельно), они не будут запускать по отдельному запросу
// к Битрикс24 каждый, а дождутся ОДНОГО общего — это и было основной
// причиной, по которой запросы утраивали нагрузку именно в момент
// первой загрузки страницы после деплоя.

const store = new Map();
const inFlight = new Map();

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

  // Запрос за этим же ключом уже выполняется — переиспользуем его
  // промис вместо того, чтобы стартовать ещё один параллельный запрос.
  if (inFlight.has(key)) {
    return inFlight.get(key);
  }

  const promise = (async () => {
    try {
      const value = await loader();
      store.set(key, { value, loadedAt: Date.now() });
      return value;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, promise);
  return promise;
}

function invalidate(key) {
  store.delete(key);
  inFlight.delete(key);
}

module.exports = { getOrLoad, invalidate };
