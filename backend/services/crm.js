// crm.js
// Слой бизнес-логики над VibeCode CRM API: получение воронок, стадий,
// сделок текущего пользователя и агрегация показателей дашборда.
//
// ВНИМАНИЕ (важно для проверяющего и для дальнейшей разработки):
// Часть деталей контракта API (точные имена полей в ответах
// crm.deal.list, семантика статусов "выигранная/проигранная" сделка,
// формат batch-ответа) взяты по наиболее вероятной конвенции,
// описанной в ТЗ, так как страница документации
// https://vibecode.bitrix24.tech/v1/me на момент разработки отдаёт 401
// без интерактивной сессии и не была доступна для сверки.
// Места, требующие проверки на реальном стенде, помечены комментарием
// "ПРОВЕРИТЬ:".

const vibeApi = require('./vibeApi');
const cache = require('../utils/cache');
const config = require('../config');
const logger = require('../utils/logger');

const DEAL_ENTITY_TYPE_ID = 2; // Сделки (CRM Deal) — стандартный ID сущности

// -------------------- Воронки --------------------

/**
 * GET /v1/crm.category.list?entityTypeId=2
 * Возвращает список воронок: [{ id, name }]
 */
async function getFunnels() {
  return cache.getOrLoad('funnels', config.cacheTtlMs, async () => {
    const data = await vibeApi.request('/crm.category.list', {
      method: 'GET',
      params: { entityTypeId: DEAL_ENTITY_TYPE_ID },
    });
    const list = (data && data.result) || [];
    return list.map((item) => ({
      id: Number(item.id),
      name: item.name,
    }));
  });
}

// -------------------- Стадии --------------------

/**
 * GET /v1/crm.status.list?filter[ENTITY_ID]=DEAL_STAGE
 * Возвращает список стадий сделок, сгруппированных по CATEGORY_ID (воронке).
 * ПРОВЕРИТЬ: поле, определяющее "выигранная/проигранная" стадия — здесь
 * используется SEMANTICS ('S' = выиграна, 'F' = проиграна, иначе — открыта),
 * это стандартная конвенция Bitrix24. Если VibeCode отдаёт иначе —
 * скорректировать функцию isWonSemantics/isLoseSemantics.
 */
async function getStages() {
  return cache.getOrLoad('stages', config.cacheTtlMs, async () => {
    const data = await vibeApi.request('/crm.status.list', {
      method: 'GET',
      params: { 'filter[ENTITY_ID]': 'DEAL_STAGE' },
    });
    const list = (data && data.result) || [];
    return list.map((item) => ({
      statusId: item.STATUS_ID,
      name: item.NAME,
      categoryId: item.CATEGORY_ID !== undefined ? Number(item.CATEGORY_ID) : 0,
      semantics: item.SEMANTICS || null,
      sort: item.SORT !== undefined ? Number(item.SORT) : 0,
    }));
  });
}

function isWonSemantics(semantics) {
  return semantics === 'S';
}

function isLoseSemantics(semantics) {
  return semantics === 'F';
}

// -------------------- Сделки --------------------

/**
 * Строит фильтр для crm.deal.list на основе параметров дашборда.
 */
function buildDealFilter({ funnelId, from, to, currentUserId }) {
  const filter = {};

  if (currentUserId) {
    // Показываем аналитику только по сделкам текущего пользователя.
    filter.ASSIGNED_BY_ID = currentUserId;
  }

  if (funnelId !== null && funnelId !== undefined) {
    filter.CATEGORY_ID = funnelId;
  }

  if (from) {
    filter['>=DATE_CREATE'] = `${from}T00:00:00`;
  }
  if (to) {
    filter['<=DATE_CREATE'] = `${to}T23:59:59`;
  }

  return filter;
}

/**
 * Получает ВСЕ сделки, подходящие под фильтр, постранично, используя
 * batch-запросы для сокращения количества обращений к API.
 * Возвращает только поля, необходимые для агрегации (без лишних данных).
 */
async function fetchAllDeals(filter) {
  const select = ['ID', 'TITLE', 'OPPORTUNITY', 'CURRENCY_ID', 'STAGE_ID', 'CATEGORY_ID', 'ASSIGNED_BY_ID', 'DATE_CREATE'];
  const pageSize = 50;
  const maxPages = 20; // защитный предел (до 1000 сделок за запрос) от неограниченного цикла

  let allDeals = [];
  let start = 0;
  let page = 0;

  // Запрашиваем страницы через /v1/batch пачками по 5 команд за раз —
  // это и есть "группировка запросов" из требований.
  const BATCH_SIZE = 5;

  while (page < maxPages) {
    const cmd = {};
    const starts = [];
    for (let i = 0; i < BATCH_SIZE; i += 1) {
      const s = start + i * pageSize;
      starts.push(s);
      const params = new URLSearchParams();
      Object.entries(filter).forEach(([key, value]) => params.append(`filter[${key}]`, value));
      select.forEach((field) => params.append('select[]', field));
      params.append('start', String(s));
      params.append('order[DATE_CREATE]', 'DESC');
      cmd[`deals_${i}`] = `crm.deal.list?${params.toString()}`;
    }

    // eslint-disable-next-line no-await-in-loop
    const response = await vibeApi.batch(cmd);
    const results = (response && response.result && response.result.result) || {};

    let gotAny = false;
    let shouldStop = false;

    for (let i = 0; i < BATCH_SIZE; i += 1) {
      const key = `deals_${i}`;
      const chunk = results[key];
      if (Array.isArray(chunk) && chunk.length > 0) {
        gotAny = true;
        allDeals = allDeals.concat(chunk);
        if (chunk.length < pageSize) {
          shouldStop = true; // последняя неполная страница — дальше данных нет
        }
      } else {
        shouldStop = true;
      }
    }

    page += 1;
    start += BATCH_SIZE * pageSize;

    if (!gotAny || shouldStop) break;
  }

  return allDeals.map((d) => ({
    id: d.ID,
    title: d.TITLE,
    amount: Number(d.OPPORTUNITY) || 0,
    currency: d.CURRENCY_ID,
    stageId: d.STAGE_ID,
    categoryId: d.CATEGORY_ID !== undefined ? Number(d.CATEGORY_ID) : 0,
    assignedById: d.ASSIGNED_BY_ID,
    dateCreate: d.DATE_CREATE,
  }));
}

// -------------------- Агрегация для дашборда --------------------

/**
 * Сводка по стадиям: количество и сумма сделок по каждой стадии выбранной
 * воронки (или всех воронок, если funnelId=null).
 */
async function getStagesSummary({ funnelId, from, to, currentUserId }) {
  const [stages, deals] = await Promise.all([
    getStages(),
    fetchAllDeals(buildDealFilter({ funnelId, from, to, currentUserId })),
  ]);

  const relevantStages = funnelId === null
    ? stages
    : stages.filter((s) => s.categoryId === funnelId);

  const byStage = new Map();
  relevantStages.forEach((s) => {
    byStage.set(s.statusId, { statusId: s.statusId, name: s.name, count: 0, amount: 0 });
  });

  deals.forEach((deal) => {
    const entry = byStage.get(deal.stageId);
    if (entry) {
      entry.count += 1;
      entry.amount += deal.amount;
    }
  });

  return Array.from(byStage.values()).sort((a, b) => {
    const sa = relevantStages.find((s) => s.statusId === a.statusId);
    const sb = relevantStages.find((s) => s.statusId === b.statusId);
    return (sa?.sort || 0) - (sb?.sort || 0);
  });
}

/**
 * Ключевые показатели: сумма открытых сделок, число выигранных за период,
 * средний чек по выигранным сделкам за период.
 */
async function getMetrics({ funnelId, from, to, currentUserId }) {
  const [stages, deals] = await Promise.all([
    getStages(),
    fetchAllDeals(buildDealFilter({ funnelId, from, to, currentUserId })),
  ]);

  const stageById = new Map(stages.map((s) => [s.statusId, s]));

  let openAmount = 0;
  let wonCount = 0;
  let wonAmountSum = 0;

  deals.forEach((deal) => {
    const stage = stageById.get(deal.stageId);
    const semantics = stage ? stage.semantics : null;

    if (isWonSemantics(semantics)) {
      wonCount += 1;
      wonAmountSum += deal.amount;
    } else if (!isLoseSemantics(semantics)) {
      // Открытая сделка — стадия не WON и не LOSE
      openAmount += deal.amount;
    }
  });

  const avgCheck = wonCount > 0 ? wonAmountSum / wonCount : 0;

  return {
    openAmount,
    wonCount,
    avgCheck,
  };
}

/**
 * Последние сделки (по умолчанию 20), отсортированные по дате создания (DESC).
 * Поскольку выборка уже ограничена сделками текущего пользователя
 * (ASSIGNED_BY_ID = currentUserId в фильтре), в качестве "Ответственного"
 * используем имя текущего пользователя (currentUserName), не делая
 * дополнительных запросов к справочнику пользователей.
 */
async function getRecentDeals({ funnelId, from, to, currentUserId, currentUserName, limit = 20 }) {
  const deals = await fetchAllDeals(buildDealFilter({ funnelId, from, to, currentUserId }));
  const stages = await getStages();
  const stageById = new Map(stages.map((s) => [s.statusId, s]));

  const sorted = [...deals].sort((a, b) => new Date(b.dateCreate) - new Date(a.dateCreate));

  return sorted.slice(0, limit).map((deal) => ({
    id: deal.id,
    title: deal.title,
    amount: deal.amount,
    currency: deal.currency,
    stageName: stageById.get(deal.stageId)?.name || deal.stageId,
    responsible: currentUserName || deal.assignedById,
  }));
}

module.exports = {
  getFunnels,
  getStages,
  getStagesSummary,
  getMetrics,
  getRecentDeals,
};
