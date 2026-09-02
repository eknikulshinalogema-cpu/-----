// vibeApi.js
// Единая точка обращения к платформе VibeCode API.
// ВСЕ запросы уходят с бэкенда с заголовком X-Api-Key (READONLY-ключ).
// Ключ никогда не попадает во фронтенд и не логируется.

const config = require('../config');
const logger = require('../utils/logger');

// Класс ошибки API с "человеческим" сообщением для фронтенда
// и исходным статус-кодом для внутренней диагностики.
class VibeApiError extends Error {
  constructor(status, userMessage, details) {
    super(userMessage);
    this.status = status;
    this.userMessage = userMessage;
    this.details = details;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mapStatusToMessage(status) {
  switch (status) {
    case 401:
      return 'Сессия истекла, обновите страницу';
    case 403:
      return 'Недостаточно прав для просмотра данных';
    case 429:
      return 'Слишком много запросов, подождите...';
    case 502:
    case 503:
    case 504:
      return 'Сервис временно недоступен';
    default:
      return 'Произошла ошибка при получении данных';
  }
}

/**
 * Выполняет один HTTP-запрос к VibeCode API с экспоненциальной задержкой
 * при получении 429 (rate limit).
 *
 * @param {string} path - путь, например '/crm.category.list'
 * @param {object} options - { method, params, body }
 */
async function request(path, options = {}) {
  const { method = 'GET', params, body } = options;

  let url = `${config.vibeApiBaseUrl}${path}`;
  if (params) {
    const query = new URLSearchParams(params).toString();
    if (query) url += (url.includes('?') ? '&' : '?') + query;
  }

  const { maxAttempts, baseDelayMs } = config.retry;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          // Ключ передаётся ТОЛЬКО здесь, на сервере, никогда на клиента.
          'X-Api-Key': config.vibeApiKey,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (networkErr) {
      // Сетевая ошибка (сервис недоступен физически)
      logger.error('Сетевая ошибка при обращении к VibeCode API', {
        path,
        attempt,
        errType: networkErr.name,
      });
      if (attempt === maxAttempts) {
        throw new VibeApiError(502, mapStatusToMessage(502));
      }
      await delay(baseDelayMs * 2 ** (attempt - 1));
      continue;
    }

    if (response.status === 429) {
      logger.warn('Получен 429 от VibeCode API, повторная попытка', {
        path,
        attempt,
      });
      if (attempt === maxAttempts) {
        throw new VibeApiError(429, mapStatusToMessage(429));
      }
      // Экспоненциальная задержка: 500ms, 1000ms, 2000ms, 4000ms...
      await delay(baseDelayMs * 2 ** (attempt - 1));
      continue;
    }

    if (!response.ok) {
      // 401 / 403 / 502 и прочие — не повторяем, сразу пробрасываем наверх.
      logger.error('VibeCode API вернул ошибку', {
        path,
        status: response.status,
      });
      throw new VibeApiError(response.status, mapStatusToMessage(response.status));
    }

    try {
      return await response.json();
    } catch (parseErr) {
      logger.error('Не удалось распарсить ответ VibeCode API', { path });
      throw new VibeApiError(502, mapStatusToMessage(502));
    }
  }

  // Теоретически недостижимо, но на всякий случай:
  throw new VibeApiError(502, mapStatusToMessage(502));
}

/**
 * GET /v1/me — получение контекста текущего доступа (проверка валидности
 * ключа и получение информации о портале/приложении).
 */
async function getMe() {
  return request('/me', { method: 'GET' });
}

/**
 * POST /v1/batch — группировка нескольких вызовов в один запрос.
 * Формат тела запроса: { halt: 0, cmd: { key1: 'method?param=value', ... } }
 * Формат ответа: { result: { result: { key1: ..., key2: ... }, result_error: {...} } }
 *
 * ВАЖНО: формат batch-контракта основан на распространённой конвенции
 * Bitrix24-совместимых API. Перед боевым использованием сверьте с
 * актуальной документацией https://vibecode.bitrix24.tech/v1/batch —
 * доступ к ней требует авторизации, которой нет на этапе разработки.
 *
 * @param {Record<string, string>} cmd - карта "ключ" -> "метод?параметры"
 */
async function batch(cmd) {
  const result = await request('/batch', {
    method: 'POST',
    body: { halt: 0, cmd },
  });

  // Если платформа вернула ошибки по отдельным командам батча —
  // логируем факт ошибки без деталей содержимого.
  if (result && result.result && result.result.result_error) {
    const failedKeys = Object.keys(result.result.result_error);
    if (failedKeys.length > 0) {
      logger.warn('Часть команд batch-запроса завершилась с ошибкой', {
        failedKeys: failedKeys.join(','),
      });
    }
  }

  return result;
}

module.exports = {
  request,
  getMe,
  batch,
  VibeApiError,
};
