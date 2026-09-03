// validation.js
// Валидация всех входных параметров запросов к нашему API.

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Проверяет и нормализует параметры фильтра (period/from/to/funnel/employees).
 */
function parseDashboardQuery(query) {
  const result = {};

  // --- Период ---
  const allowedPeriods = ['all', 'today', 'yesterday', 'week', 'month', 'quarter', 'year', 'custom'];
  const period = query.period || 'all';
  if (!allowedPeriods.includes(period)) {
    throw new ValidationError(`Недопустимое значение period. Разрешены: ${allowedPeriods.join(', ')}`);
  }
  result.period = period;

  if (period === 'custom') {
    if (!query.from || !query.to) {
      throw new ValidationError('Для period=custom обязательны параметры from и to (формат YYYY-MM-DD)');
    }
  }

  if (query.from !== undefined) {
    if (!DATE_RE.test(query.from)) {
      throw new ValidationError('Параметр from должен быть в формате YYYY-MM-DD');
    }
    result.from = query.from;
  }

  if (query.to !== undefined) {
    if (!DATE_RE.test(query.to)) {
      throw new ValidationError('Параметр to должен быть в формате YYYY-MM-DD');
    }
    result.to = query.to;
  }

  if (result.from && result.to && result.from > result.to) {
    throw new ValidationError('Параметр from не может быть позже to');
  }

  // --- Воронка ---
  if (query.funnel !== undefined && query.funnel !== '' && query.funnel !== 'all') {
    const funnelId = Number(query.funnel);
    if (!Number.isInteger(funnelId) || funnelId < 0) {
      throw new ValidationError('Параметр funnel должен быть целым неотрицательным числом или "all"');
    }
    result.funnelId = funnelId;
  } else {
    result.funnelId = null;
  }

  // --- Сотрудники (через запятую: employees=12,45,7) ---
  if (query.employees !== undefined && query.employees !== '' && query.employees !== 'all') {
    const ids = String(query.employees)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number);
    if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
      throw new ValidationError('Параметр employees должен быть списком положительных целых чисел через запятую');
    }
    result.employeeIds = ids;
  } else {
    result.employeeIds = null; // все сотрудники
  }

  // --- limit (только для /recent) ---
  if (query.limit !== undefined) {
    const limit = Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw new ValidationError('Параметр limit должен быть целым числом от 1 до 20');
    }
    result.limit = limit;
  }

  return result;
}

module.exports = { parseDashboardQuery, ValidationError };
