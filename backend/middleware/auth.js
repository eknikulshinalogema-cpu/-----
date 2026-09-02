// auth.js
// Middleware определяет, от лица какого сотрудника Битрикс24 сделан запрос.
//
// Модель безопасности:
// - Один общий READONLY API-ключ (X-Api-Key) используется бэкендом для ВСЕХ
//   вызовов к VibeCode API — это ключ уровня приложения, он не идентифицирует
//   конкретного сотрудника и никогда не попадает на фронтенд.
// - Персонализация "видит свои данные" реализована через заголовки
//   X-Vibe-*, которые Gateway VibeCode прикладывает к запросу, приходящему
//   от конкретного авторизованного сотрудника, когда он открывает встроенное
//   приложение внутри Битрикс24. Наш Express-бэкенд читает эти заголовки
//   ТОЛЬКО из входящего запроса (не пересылает их в VibeCode API).
// - Дополнительно, GET /v1/me используется для проверки, что API-ключ
//   валиден и приложение имеет доступ к порталу (см. services/vibeApi.getMe).
//
// ПРОВЕРИТЬ: точные названия заголовков Gateway (сейчас: x-vibe-user-id,
// x-vibe-user-name, x-vibe-user-email) — сверить с актуальной документацией
// после получения доступа к https://vibecode.bitrix24.tech/.

const config = require('../config');
const logger = require('../utils/logger');

// HTTP-заголовки по спецификации ограничены ASCII/Latin-1, поэтому
// нерусские платформы часто percent-encode'ят (encodeURIComponent)
// значения с кириллицей перед отправкой в заголовке. Пытаемся раскодировать
// по этой конвенции; если значение не было закодировано — decodeURIComponent
// на обычной ASCII-строке является no-op и просто вернёт её как есть.
// ПРОВЕРИТЬ: реальную конвенцию кодирования заголовков Gateway VibeCode
// (percent-encoding / UTF-8-as-Latin1 / обычный UTF-8) после получения
// доступа к документации — при необходимости заменить эту функцию.
function safeDecodeHeader(value) {
  if (!value) return value;
  try {
    return decodeURIComponent(value);
  } catch (e) {
    return value;
  }
}

function requireUserContext(req, res, next) {
  const headers = config.gatewayHeaders;
  const userId = req.headers[headers.userId];
  const userName = safeDecodeHeader(req.headers[headers.userName]);
  const userEmail = req.headers[headers.userEmail];

  if (!userId) {
    if (config.nodeEnv !== 'production') {
      // В режиме разработки допускаем работу без Gateway (локальный запуск
      // вне iframe Битрикс24), чтобы можно было тестировать API руками.
      logger.warn('Заголовки X-Vibe-* отсутствуют, используется тестовый пользователь (только dev-режим)');
      req.vibeUser = { id: 'dev-user', name: 'Тестовый пользователь (dev)', email: null };
      return next();
    }

    logger.warn('Запрос без заголовков X-Vibe-* от Gateway', { path: req.path });
    return res.status(401).json({ error: 'Сессия истекла, обновите страницу' });
  }

  req.vibeUser = { id: userId, name: userName || userId, email: userEmail || null };
  return next();
}

module.exports = { requireUserContext };
