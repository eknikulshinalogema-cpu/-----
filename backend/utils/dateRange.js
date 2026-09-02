// dateRange.js
// Преобразует значение фильтра "период" (period) в конкретные границы
// дат ISO (YYYY-MM-DD) либо null, если фильтр по дате не нужен
// ("весь период" — по умолчанию, без ограничения).

function pad(n) {
  return String(n).padStart(2, '0');
}

function toIsoDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * @param {{period: string, from?: string, to?: string}} params
 * @returns {{from: string|null, to: string|null}}
 */
function resolveDateRange({ period, from, to }) {
  const now = new Date();
  const today = startOfDay(now);

  switch (period) {
    case 'all':
      return { from: null, to: null };

    case 'today':
      return { from: toIsoDate(today), to: toIsoDate(today) };

    case 'yesterday': {
      const y = new Date(today);
      y.setDate(y.getDate() - 1);
      return { from: toIsoDate(y), to: toIsoDate(y) };
    }

    case 'week': {
      const start = new Date(today);
      start.setDate(start.getDate() - 6);
      return { from: toIsoDate(start), to: toIsoDate(today) };
    }

    case 'month': {
      const start = new Date(today.getFullYear(), today.getMonth(), 1);
      return { from: toIsoDate(start), to: toIsoDate(today) };
    }

    case 'quarter': {
      const currentQuarter = Math.floor(today.getMonth() / 3);
      const start = new Date(today.getFullYear(), currentQuarter * 3, 1);
      return { from: toIsoDate(start), to: toIsoDate(today) };
    }

    case 'year': {
      const start = new Date(today.getFullYear(), 0, 1);
      return { from: toIsoDate(start), to: toIsoDate(today) };
    }

    case 'custom':
      return { from, to };

    default:
      return { from: null, to: null };
  }
}

module.exports = { resolveDateRange };
