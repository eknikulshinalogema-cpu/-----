// auth.js
// Middleware читает заголовки, которые Gateway VibeCode кладёт в каждый
// запрос, когда сотрудник открывает приложение изнутри Битрикс24
// (см. https://vibecode.bitrix24.tech/docs/infra/app-runtime).
//
// Главный заголовок — X-Vibe-Authorization: Bearer vibe_session_<...>.
// Это токен сессии ТЕКУЩЕГО сотрудника, который мы обязаны пересылать
// как Authorization: Bearer в каждом запросе к VibeCode API — иначе
// платформа отвечает 401 TOKEN_MISSING на любой вызов к сущностям CRM.
//
// Дашборд больше не ограничивает данные "только своими сделками":
// то, что видит сотрудник, определяется его правами в самом Битрикс24
// (Bearer передаёт его личность и права дальше в CRM), а фильтр по
// сотрудникам на дашборде — это отдельная, ручная фильтрация выборки,
// а не разграничение доступа.

const logger = require('../utils/logger');

function readGatewayContext(req, res, next) {
  const rawAuth = req.headers['x-vibe-authorization'];
  const bearer = rawAuth ? String(rawAuth).replace(/^Bearer\s+/i, '') : null;

  const userIdRaw = req.headers['x-vibe-user-id'];
  const nameEncoded = req.headers['x-vibe-user-name-encoded'];
  let userName = null;
  if (nameEncoded) {
    try {
      userName = decodeURIComponent(String(nameEncoded));
    } catch (e) {
      userName = String(nameEncoded);
    }
  }

  req.vibeBearer = bearer; // может быть null — обрабатывается в роутах
  req.vibeUser = {
    id: userIdRaw || null,
    name: userName,
    role: req.headers['x-vibe-user-role'] || null,
  };

  if (!bearer) {
    logger.warn('Запрос без X-Vibe-Authorization — приложение открыто не через Gateway/меню Битрикс24', {
      path: req.path,
    });
  }

  next();
}

module.exports = { readGatewayContext };
