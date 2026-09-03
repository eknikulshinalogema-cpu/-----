// dashboard.js
// Роуты API дашборда. BFF-паттерн: фронтенд обращается только сюда,
// а сюда уже мы пересылаем Bearer-сессию текущего сотрудника в VibeCode API.

const express = require('express');
const crm = require('../services/crm');
const { VibeApiError } = require('../services/vibeApi');
const { parseDashboardQuery, ValidationError } = require('../utils/validation');
const { resolveDateRange } = require('../utils/dateRange');
const { readGatewayContext } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();

router.use(readGatewayContext);

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
    employeeIds: parsed.employeeIds,
    from,
    to,
    limit: parsed.limit,
  };
}

// GET /api/dashboard/funnels — список воронок для фильтра
router.get('/funnels', asyncHandler(async (req, res) => {
  const funnels = await crm.getFunnels(req.vibeBearer);
  res.json({ items: [{ id: null, name: 'Все воронки' }, ...funnels] });
}));

// GET /api/dashboard/employees?period=...&funnel=... — список сотрудников для фильтра
// (только те, у кого есть сделки под текущим периодом/воронкой)
router.get('/employees', asyncHandler(async (req, res) => {
  const { funnelId, from, to } = extractFilters(req);
  const employees = await crm.getEmployeesForFilter({ funnelId, from, to }, req.vibeBearer);
  res.json({ items: employees });
}));

// GET /api/dashboard/stages — сводка: сотрудник × воронка × стадия
router.get('/stages', asyncHandler(async (req, res) => {
  const { funnelId, employeeIds, from, to } = extractFilters(req);
  const rows = await crm.getStagesReport({ funnelId, employeeIds, from, to }, req.vibeBearer);
  res.json({ items: rows });
}));

// GET /api/dashboard/metrics — ключевые показатели: сотрудник × воронка + итог
router.get('/metrics', asyncHandler(async (req, res) => {
  const { funnelId, employeeIds, from, to } = extractFilters(req);
  const report = await crm.getMetricsReport({ funnelId, employeeIds, from, to }, req.vibeBearer);
  res.json(report);
}));

// GET /api/dashboard/recent — последние сделки
router.get('/recent', asyncHandler(async (req, res) => {
  const { funnelId, employeeIds, from, to, limit } = extractFilters(req);
  const items = await crm.getRecentReport(
    { funnelId, employeeIds, from, to, limit: limit || 20 },
    req.vibeBearer,
  );
  res.json({ items });
}));

module.exports = router;
