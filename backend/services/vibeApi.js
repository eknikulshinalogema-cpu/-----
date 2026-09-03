// vibeApi.js
// Клиент реального VibeCode Entity API (https://vibecode.bitrix24.tech/v1).
//
// КЛЮЧЕВОЙ МОМЕНТ (важно понимать при чтении этого файла):
// Ваш ключ — vibe_app_... — это "ключ авторизации". Для сущностей CRM
// (сделки, статусы, пользователи и т.д.) ему НЕДОСТАТОЧНО одного
// X-Api-Key: платформа требует ЕЩЁ заголовок Authorization: Bearer
// с токеном сессии текущего сотрудника. Этот токен приложение получает
// не само — его на каждый запрос кладёт Gateway VibeCode в заголовок
// X-Vibe-Authorization, когда сотрудник открывает приложение из левого
// меню Битрикс24 (см. backend/middleware/auth.js). Наша задача —
// прочитать этот заголовок из ВХОДЯЩЕГО запроса от Gateway и переслать
// его как Authorization: Bearer в исходящем запросе к VibeCode API.
//
// Без этого шага (которого не было в первой версии кода) все вызовы
// к сущностям CRM отвечали ошибкой авторизации — это и была причина
// того, что дашборд показывал "Нет данных" и "Произошла ошибка".

const config = require('../config');
const logger = require('../utils/logger');

class VibeApiError extends Error {
  constructor(status, userMessage, code) {
    super(userMessage);
    this.status = status;
    this.userMessage = userMessage;
    this.code = code;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Реальные коды ошибок платформы (см. https://vibecode.bitrix24.tech/docs/errors
// и https://vibecode.bitrix24.tech/docs/keys-auth) → понятное сообщение пользователю.
function mapErrorToMessage(status, code) {
  if (code === 'TOKEN_MISSING' || code === 'INVALID_SESSION') {
    return 'Откройте приложение через левое меню Битрикс24 — сессия отсутствует или истекла';
  }
  if (code === 'KEY_EXPIRED' || code === 'KEY_INACTIVE' || code === 'INVALID_API_KEY') {
    return 'Ключ доступа приложения недействителен, обратитесь к администратору';
  }
  if (code === 'WRITE_BLOCKED_READONLY_KEY') {
    return 'Ключ работает в режиме "только чтение"';
  }
  if (code === 'BITRIX_ACCESS_DENIED') {
    return 'Недостаточно прав для просмотра данных';
  }
  if (status === 429 || code === 'RATE_LIMITED') {
    return 'Слишком много запросов, подождите...';
  }
  if (status === 502 || code === 'BITRIX_UNAVAILABLE') {
    return 'Сервис временно недоступен';
  }
  switch (status) {
    case 401:
      return 'Сессия истекла, обновите страницу';
    case 403:
      return 'Недостаточно прав для просмотра данных';
    case 502:
    case 503:
    case 504:
      return 'Сервис временно недоступен';
    default:
      return 'Произошла ошибка при получении данных';
  }
}

/**
 * @param {string} path - путь сущности, например '/deals/search' (БЕЗ /v1 — он уже в базовом URL)
 * @param {object} options - { method, params, body, bearer }
 *   bearer — токен сессии текущего сотрудника (из X-Vibe-Authorization входящего запроса).
 *   Без него запрос уйдёт с одним X-Api-Key — подходит только для /me и /guide.
 */
async function request(path, options = {}) {
  const { method = 'GET', params, body, bearer } = options;

  let url = `${config.vibeApiBaseUrl}${path}`;
  if (params) {
    const query = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      query.append(key, value);
    });
    const qs = query.toString();
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }

  const headers = {
    'X-Api-Key': config.vibeApiKey,
    'Content-Type': 'application/json',
  };
  if (bearer) {
    headers.Authorization = `Bearer ${bearer}`;
  }

  const { maxAttempts, baseDelayMs } = config.retry;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (networkErr) {
      logger.error('Сетевая ошибка при обращении к VibeCode API', {
        path,
        attempt,
        errType: networkErr.name,
      });
      if (attempt === maxAttempts) {
        throw new VibeApiError(502, mapErrorToMessage(502), 'NETWORK_ERROR');
      }
      await delay(baseDelayMs * 2 ** (attempt - 1));
      continue;
    }

    if (response.status === 429) {
      // Платформа отдаёт заголовок Retry-After — используем его, если он есть,
      // иначе экспоненциальная задержка.
      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : null;
      logger.warn('Получен 429 от VibeCode API, повторная попытка', { path, attempt });
      if (attempt === maxAttempts) {
        throw new VibeApiError(429, mapErrorToMessage(429, 'RATE_LIMITED'), 'RATE_LIMITED');
      }
      await delay(retryAfterMs || baseDelayMs * 2 ** (attempt - 1));
      continue;
    }

    let json = null;
    try {
      json = await response.json();
    } catch (parseErr) {
      // тело не JSON
    }

    if (!response.ok) {
      const code = json && json.error && json.error.code;
      const message = (json && json.error && json.error.message) || null;
      logger.error('VibeCode API вернул ошибку', { path, status: response.status, code });
      throw new VibeApiError(response.status, mapErrorToMessage(response.status, code), code || message);
    }

    return json;
  }

  throw new VibeApiError(502, mapErrorToMessage(502), 'UNKNOWN');
}

/**
 * GET /v1/me — самоописание ключа. Работает БЕЗ bearer (currentUser будет null) —
 * используется при старте сервера как проверка доступности платформы,
 * и с bearer — чтобы узнать currentUser.bitrixUserId текущего сотрудника.
 */
async function getMe(bearer) {
  return request('/me', { method: 'GET', bearer });
}

/** GET /v1/{entity} — список с пагинацией (offset-based). */
async function listEntity(entity, { limit, offset, select, order, withTotal, bearer } = {}) {
  const params = {};
  if (limit !== undefined) params.limit = limit;
  if (offset !== undefined) params.offset = offset;
  if (select) params.select = Array.isArray(select) ? select.join(',') : select;
  if (order) {
    Object.entries(order).forEach(([field, dir]) => {
      params[`order[${field}]`] = dir;
    });
  }
  if (withTotal !== undefined) params.withTotal = withTotal;
  return request(`/${entity}`, { method: 'GET', params, bearer });
}

/** POST /v1/{entity}/search — поиск с фильтрацией. */
async function searchEntity(entity, { filter, sort, limit, offset, withTotal, bearer } = {}) {
  const body = {};
  if (filter) body.filter = filter;
  if (sort) body.sort = sort;
  if (limit !== undefined) body.limit = limit;
  if (offset !== undefined) body.offset = offset;
  if (withTotal !== undefined) body.withTotal = withTotal;
  return request(`/${entity}/search`, { method: 'POST', body, bearer });
}

/** POST /v1/{entity}/aggregate — счётчики и суммы (пока не используется, задел на будущее). */
async function aggregateEntity(entity, { aggregate, filter, groupBy, bearer } = {}) {
  const body = {};
  if (aggregate) body.aggregate = aggregate;
  if (filter) body.filter = filter;
  if (groupBy) body.groupBy = groupBy;
  return request(`/${entity}/aggregate`, { method: 'POST', body, bearer });
}

module.exports = {
  request,
  getMe,
  listEntity,
  searchEntity,
  aggregateEntity,
  VibeApiError,
};
