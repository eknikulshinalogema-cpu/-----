// dashboard.js
// Роуты API дашборда. Все обращения к VibeCode API идут ЧЕРЕЗ бэкенд
// (BFF-паттерн) — фронтенд обращается только к этим эндпоинтам.

const express = require('express');
const crm = require('../services/crm');
const { VibeApiError } = require('../services/vibeApi');
const { parseDashboardQuery, ValidationError } = require('../utils/validation');
const { resolveDateRange } = require('../utils/dateRange');
const { requireUserContext } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();

router.use(requireUserContext);

// Единая обёртка для обработки ошибок валидации и ошибок API.
function asyncHandler(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      if (err instanceof ValidationError) {
        return res.status(400).json({ error: err.message });
      }
      if (err instanceof VibeApiError) {
        return res.status(err.status).json({ error: err.userMessage });
      }
      // Неожиданная ошибка — логируем техническую информацию без
      // персональных данных и отдаём общее сообщение.
      logger.error('Необработанная ошибка в роуте дашборда', {
        path: req.path,
        message: err.message,
      });
      return res.status(500).json({ error: 'Произошла ошибка на сервере' });
    }
    return undefined;
  };
}

function extractFilters(req) {
  const parsed = parseDashboardQuery(req.query);
  const { from, to } = resolveDateRange(parsed);
  return {
    funnelId: parsed.funnelId,
    from,
    to,
    limit: parsed.limit,
  };
}

// GET /api/dashboard/funnels — список всех воронок для фильтра
router.get('/funnels', asyncHandler(async (req, res) => {
  const funnels = await crm.getFunnels();
  res.json({
    items: [{ id: null, name: 'Все воронки' }, ...funnels],
  });
}));

// GET /api/dashboard/stages?period=...&from=...&to=...&funnel=...
router.get('/stages', asyncHandler(async (req, res) => {
  const { funnelId, from, to } = extractFilters(req);
  const stages = await crm.getStagesSummary({
    funnelId,
    from,
    to,
    currentUserId: req.vibeUser.id,
  });
  res.json({ items: stages });
}));

// GET /api/dashboard/metrics?period=...&from=...&to=...&funnel=...
router.get('/metrics', asyncHandler(async (req, res) => {
  const { funnelId, from, to } = extractFilters(req);
  const metrics = await crm.getMetrics({
    funnelId,
    from,
    to,
    currentUserId: req.vibeUser.id,
  });
  res.json(metrics);
}));

// GET /api/dashboard/recent?period=...&from=...&to=...&funnel=...&limit=20
router.get('/recent', asyncHandler(async (req, res) => {
  const { funnelId, from, to, limit } = extractFilters(req);
  const deals = await crm.getRecentDeals({
    funnelId,
    from,
    to,
    limit: limit || 20,
    currentUserId: req.vibeUser.id,
    currentUserName: req.vibeUser.name,
  });
  res.json({ items: deals });
}));

module.exports = router;
