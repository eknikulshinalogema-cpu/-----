// crm.js
// Бизнес-логика поверх реального VibeCode Entity API.
//
// АРХИТЕКТУРНОЕ РЕШЕНИЕ (по итогам ревью): сводка по стадиям, ключевые
// показатели и список сотрудников для фильтра строятся ЧЕРЕЗ
// POST /v1/deals/aggregate с groupBy — платформа сама считает count/sum
// по нужным разрезам, без построчной выгрузки сделок на наш бэкенд.
// Единственное место, где мы по-прежнему читаем сами строки сделок —
// «Последние сделки»: там нужен не агрегат, а конкретный список из
// не более чем 20 записей, поэтому там используется POST /v1/deals/search
// с explicit select и limit: 20.
//
// Агрегация по числовым функциям (sum) ограничена платформой 5000
// записями на один запрос — при усечении ответ несёт data.meta.truncated.
// Мы пробрасываем этот флаг наружу (поле truncated в ответах эндпоинтов),
// чтобы интерфейс мог показать предупреждение и предложить сузить фильтр.
// Счётчик (count-only, без числовых агрегатов) платформа считает точно
// при любом объёме данных — усечению не подвержен.
//
// Важные допущения, которые стоит проверить на реальном портале при
// расхождениях (помечены ПРОВЕРИТЬ):
// - Точная форма объекта группы в ответе aggregate (какие поля группировки
//   лежат прямо в группе, где именно вложены count/sum) — код разбирает
//   несколько вероятных вариантов защитным образом.
// - Поле полного имени сотрудника в /v1/users.

const vibeApi = require('./vibeApi');
const cache = require('../utils/cache');
const config = require('../config');
const logger = require('../utils/logger');

// -------------------- Воронки (deal-categories) --------------------

async function getFunnels(bearer) {
  return cache.getOrLoad(`funnels:${bearer || 'anon'}`, config.cacheTtlMs, async () => {
    const data = await vibeApi.listEntity('deal-categories', { limit: 100, bearer });
    const list = (data && data.data) || [];
    return list.map((item) => ({
      id: Number(item.id),
      name: item.name || item.title || `Воронка ${item.id}`,
    }));
  });
}

// -------------------- Стадии (statuses) --------------------

/**
 * GET /v1/statuses.
 * У не-дефолтных воронок Битрикс24 код стадии выглядит как "C97:WON" —
 * номер воронки уже "зашит" в сам код. Справочник таких стадий хранится
 * под entityId вида "DEAL_STAGE_97", поэтому забираем всё, что начинается
 * с "DEAL_STAGE", и сопоставляем со сделкой напрямую по полному коду
 * стадии, без отдельной комбинации с categoryId.
 */
async function getDealStages(bearer) {
  return cache.getOrLoad(`stages:${bearer || 'anon'}`, config.cacheTtlMs, async () => {
    const data = await vibeApi.listEntity('statuses', { limit: 500, bearer });
    const list = (data && data.data) || [];
    return list
      .filter((item) => item.entityId === 'DEAL_STAGE' || (item.entityId && String(item.entityId).startsWith('DEAL_STAGE_')))
      .map((item) => ({
        statusId: item.statusId || item.id,
        name: item.name || item.title,
        categoryId: item.categoryId !== undefined ? Number(item.categoryId) : 0,
        semantics: item.semanticsId || item.semantics || null,
        sort: item.sort !== undefined ? Number(item.sort) : 0,
      }));
  });
}

function isWonSemantics(semantics) {
  return semantics === 'S';
}
function isLoseSemantics(semantics) {
  return semantics === 'F';
}

// -------------------- Сотрудники (users) --------------------

async function getUsers(bearer) {
  return cache.getOrLoad(`users:${bearer || 'anon'}`, config.cacheTtlMs, async () => {
    const data = await vibeApi.listEntity('users', { limit: 1000, bearer });
    const list = (data && data.data) || [];
    return list.map((u) => ({
      id: Number(u.id),
      name: buildFullName(u),
      active: u.active !== undefined ? u.active : true,
    }));
  });
}

function buildFullName(u) {
  const last = u.lastName || u.LAST_NAME || '';
  const first = u.name || u.NAME || u.firstName || '';
  const second = u.secondName || u.SECOND_NAME || '';
  const full = [last, first, second].filter(Boolean).join(' ').trim();
  if (full) return full;
  if (u.fullName) return u.fullName;
  if (u.title) return u.title;
  return `Сотрудник #${u.id}`;
}

// -------------------- Справочные карты --------------------

async function buildLookupMaps(bearer) {
  const [funnels, stages, users] = await Promise.all([
    getFunnels(bearer),
    getDealStages(bearer),
    getUsers(bearer),
  ]);
  const funnelById = new Map(funnels.map((f) => [f.id, f.name]));
  const stageByKey = new Map(stages.map((s) => [s.statusId, s]));
  const userById = new Map(users.map((u) => [u.id, u.name]));
  return { funnels, stages, users, funnelById, stageByKey, userById };
}

function findStage(stageByKey, stageId) {
  return stageByKey.get(stageId) || null;
}

// -------------------- Фильтр по сделкам --------------------

/**
 * Строит объект filter для POST /v1/deals/search и /v1/deals/aggregate.
 * Синтаксис: https://vibecode.bitrix24.tech/docs/filtering
 */
function buildDealFilter({ funnelId, from, to, employeeIds }) {
  const filter = {};

  if (funnelId !== null && funnelId !== undefined) {
    filter.categoryId = funnelId;
  }

  if (from || to) {
    const createdAt = {};
    if (from) createdAt.$gte = `${from}T00:00:00`;
    if (to) createdAt.$lte = `${to}T23:59:59`;
    filter.createdAt = createdAt;
  }

  if (employeeIds && employeeIds.length > 0) {
    filter.assignedById = employeeIds.length === 1 ? employeeIds[0] : { $in: employeeIds };
  }

  return filter;
}

// -------------------- Разбор ответа aggregate --------------------

/**
 * Достаёт массив групп и признак усечения из ответа POST /v1/{entity}/aggregate.
 */
function extractAggregateGroups(response) {
  const data = (response && response.data) || {};
  const groups = data.groups || [];
  const truncated = Boolean(data.meta && data.meta.truncated);
  return { groups, truncated };
}

/**
 * Достаёт значение count из объекта группы — платформа может отдавать его
 * как group.count напрямую, либо вложенным в group.aggregates под именем
 * поля агрегата (например "*"). Разбираем защитным образом.
 */
function extractGroupCount(group) {
  if (typeof group.count === 'number') return group.count;
  if (group.aggregates) {
    const entries = Object.values(group.aggregates);
    const withCount = entries.find((e) => e && typeof e.count === 'number');
    if (withCount) return withCount.count;
  }
  return 0;
}

/** Достаёт сумму по конкретному полю (например "amount") из группы. */
function extractGroupSum(group, field) {
  if (group.aggregates && group.aggregates[field] && typeof group.aggregates[field].sum === 'number') {
    return group.aggregates[field].sum;
  }
  if (typeof group[`${field}Sum`] === 'number') return group[`${field}Sum`];
  return 0;
}

// -------------------- Список сотрудников для фильтра --------------------

/**
 * Список сотрудников для выпадающего фильтра — построен через
 * POST /v1/deals/aggregate { aggregate: [{field:"*",function:"count"}],
 * groupBy: ["assignedById"] } — платформа сама отдаёт различные
 * assignedById без выгрузки самих сделок на бэкенд. Count-only агрегат
 * точен при любом объёме данных, усечению не подвержен.
 */
async function getEmployeesForFilter({ funnelId, from, to }, bearer) {
  const filter = buildDealFilter({ funnelId, from, to, employeeIds: null });

  // Этому эндпоинту нужны только имена сотрудников — воронки и стадии
  // ему не требуются, поэтому здесь используется лёгкий getUsers(),
  // а не buildLookupMaps(). Это заметно ускоряет ответ в момент, когда
  // фронтенд одновременно запрашивает employees/stages/metrics при
  // холодном кэше (сразу после деплоя) — раньше все три запроса
  // параллельно и избыточно тянули один и тот же набор справочников.
  const [aggResponse, users] = await Promise.all([
    vibeApi.aggregateEntity('deals', {
      aggregate: [{ field: '*', function: 'count' }],
      groupBy: ['assignedById'],
      filter,
      bearer,
    }),
    getUsers(bearer),
  ]);

  const userById = new Map(users.map((u) => [u.id, u.name]));

  const { groups } = extractAggregateGroups(aggResponse);
  const ids = groups
    .map((g) => Number(g.assignedById))
    .filter((id) => Number.isFinite(id) && id > 0);

  return ids
    .map((id) => ({ id, name: userById.get(id) || `Сотрудник #${id}` }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

// -------------------- Сводка по стадиям --------------------

/**
 * POST /v1/deals/aggregate, groupBy: сотрудник × воронка × стадия,
 * aggregate: count + sum(amount) — один запрос вместо постраничной
 * выгрузки всех сделок.
 */
async function getStagesReport({ funnelId, from, to, employeeIds }, bearer) {
  const filter = buildDealFilter({ funnelId, from, to, employeeIds });

  const [aggResponse, maps] = await Promise.all([
    vibeApi.aggregateEntity('deals', {
      aggregate: [{ field: '*', function: 'count' }, { field: 'amount', function: 'sum' }],
      groupBy: ['assignedById', 'categoryId', 'stageId'],
      filter,
      bearer,
    }),
    buildLookupMaps(bearer),
  ]);

  const { groups, truncated } = extractAggregateGroups(aggResponse);

  const rows = groups.map((g) => {
    const categoryId = g.categoryId !== undefined ? Number(g.categoryId) : 0;
    const responsibleId = Number(g.assignedById);
    const stage = findStage(maps.stageByKey, g.stageId);
    return {
      responsibleName: maps.userById.get(responsibleId) || `Сотрудник #${responsibleId}`,
      funnelName: maps.funnelById.get(categoryId) || `Воронка ${categoryId}`,
      stageName: (stage && stage.name) || g.stageId,
      count: extractGroupCount(g),
      amount: extractGroupSum(g, 'amount'),
      _sortStage: (stage && stage.sort) || 0,
    };
  });

  rows.sort((a, b) => a.responsibleName.localeCompare(b.responsibleName, 'ru')
    || a.funnelName.localeCompare(b.funnelName, 'ru')
    || a._sortStage - b._sortStage);

  return {
    items: rows.map(({ _sortStage, ...rest }) => rest),
    truncated,
  };
}

// -------------------- Ключевые показатели --------------------

/**
 * Ключевые показатели тоже строятся через aggregate, но в два запроса,
 * так как "открытые" и "выигранные" сделки — это фильтр по НАБОРУ кодов
 * стадий (стадии с семантикой "не выигрыш и не проигрыш" / "выигрыш"),
 * а не поле, которое можно агрегировать напрямую:
 *  1) сумма открытых — aggregate по сделкам с stageId в списке "открытых" кодов;
 *  2) количество и сумма выигранных — aggregate по сделкам с stageId
 *     в списке "выигранных" кодов.
 * Оба сгруппированы по (сотрудник × воронка) и объединяются в одну таблицу.
 */
async function getMetricsReport({ funnelId, from, to, employeeIds }, bearer) {
  const maps = await buildLookupMaps(bearer);

  const relevantStages = funnelId === null
    ? maps.stages
    : maps.stages.filter((s) => s.categoryId === funnelId);

  const wonStageIds = relevantStages.filter((s) => isWonSemantics(s.semantics)).map((s) => s.statusId);
  const openStageIds = relevantStages
    .filter((s) => !isWonSemantics(s.semantics) && !isLoseSemantics(s.semantics))
    .map((s) => s.statusId);

  const baseFilter = buildDealFilter({ funnelId, from, to, employeeIds });

  const openCallPromise = openStageIds.length > 0
    ? vibeApi.aggregateEntity('deals', {
      aggregate: [{ field: 'amount', function: 'sum' }],
      groupBy: ['assignedById', 'categoryId'],
      filter: { ...baseFilter, stageId: { $in: openStageIds } },
      bearer,
    })
    : Promise.resolve(null);

  const wonCallPromise = wonStageIds.length > 0
    ? vibeApi.aggregateEntity('deals', {
      aggregate: [{ field: '*', function: 'count' }, { field: 'amount', function: 'sum' }],
      groupBy: ['assignedById', 'categoryId'],
      filter: { ...baseFilter, stageId: { $in: wonStageIds } },
      bearer,
    })
    : Promise.resolve(null);

  const [openResponse, wonResponse] = await Promise.all([openCallPromise, wonCallPromise]);

  const openParsed = openResponse ? extractAggregateGroups(openResponse) : { groups: [], truncated: false };
  const wonParsed = wonResponse ? extractAggregateGroups(wonResponse) : { groups: [], truncated: false };

  const rowsByKey = new Map();
  const keyOf = (assignedById, categoryId) => `${assignedById}|${categoryId}`;

  openParsed.groups.forEach((g) => {
    const key = keyOf(g.assignedById, g.categoryId);
    const row = rowsByKey.get(key) || {
      assignedById: Number(g.assignedById),
      categoryId: g.categoryId !== undefined ? Number(g.categoryId) : 0,
      openAmount: 0,
      wonCount: 0,
      wonAmountSum: 0,
    };
    row.openAmount = extractGroupSum(g, 'amount');
    rowsByKey.set(key, row);
  });

  wonParsed.groups.forEach((g) => {
    const key = keyOf(g.assignedById, g.categoryId);
    const row = rowsByKey.get(key) || {
      assignedById: Number(g.assignedById),
      categoryId: g.categoryId !== undefined ? Number(g.categoryId) : 0,
      openAmount: 0,
      wonCount: 0,
      wonAmountSum: 0,
    };
    row.wonCount = extractGroupCount(g);
    row.wonAmountSum = extractGroupSum(g, 'amount');
    rowsByKey.set(key, row);
  });

  const rows = Array.from(rowsByKey.values()).map((r) => ({
    responsibleName: maps.userById.get(r.assignedById) || `Сотрудник #${r.assignedById}`,
    funnelName: maps.funnelById.get(r.categoryId) || `Воронка ${r.categoryId}`,
    openAmount: r.openAmount,
    wonCount: r.wonCount,
    avgCheck: r.wonCount > 0 ? r.wonAmountSum / r.wonCount : 0,
    _wonAmountSum: r.wonAmountSum,
  }));

  rows.sort((a, b) => a.responsibleName.localeCompare(b.responsibleName, 'ru')
    || a.funnelName.localeCompare(b.funnelName, 'ru'));

  // Итоговая строка: суммы по открытым и выигранным — простое сложение,
  // средний чек — отношение суммарной выручки к суммарному числу
  // выигранных сделок (а не сумма самих средних чеков).
  const totals = rows.reduce((acc, r) => {
    acc.openAmount += r.openAmount;
    acc.wonCount += r.wonCount;
    acc.wonAmountSum += r._wonAmountSum;
    return acc;
  }, { openAmount: 0, wonCount: 0, wonAmountSum: 0 });

  const totalRow = {
    responsibleName: 'Итого',
    funnelName: '',
    openAmount: totals.openAmount,
    wonCount: totals.wonCount,
    avgCheck: totals.wonCount > 0 ? totals.wonAmountSum / totals.wonCount : 0,
  };

  return {
    rows: rows.map(({ _wonAmountSum, ...rest }) => rest),
    total: totalRow,
    truncated: openParsed.truncated || wonParsed.truncated,
  };
}

// -------------------- Последние сделки --------------------

/**
 * Единственное место, где мы по-прежнему читаем строки сделок напрямую:
 * POST /v1/deals/search с явным select и limit: 20 — здесь нужен не
 * агрегат, а конкретный список последних сделок.
 */
async function getRecentReport({ funnelId, from, to, employeeIds, limit = 20 }, bearer) {
  const filter = buildDealFilter({ funnelId, from, to, employeeIds });
  const maps = await buildLookupMaps(bearer);

  const response = await vibeApi.searchEntity('deals', {
    filter,
    sort: { createdAt: 'desc' },
    select: ['id', 'title', 'amount', 'stageId', 'categoryId', 'assignedById', 'createdAt'],
    limit,
    withTotal: false,
    bearer,
  });

  let deals = (response && response.data) || [];

  // Локальная подстраховка на случай, если $in по нескольким сотрудникам
  // почему-то не применился на стороне платформы.
  if (filter.assignedById && filter.assignedById.$in) {
    const allowed = new Set(filter.assignedById.$in.map(Number));
    deals = deals.filter((d) => allowed.has(Number(d.assignedById)));
  }

  return deals.map((d) => {
    const categoryId = d.categoryId !== undefined ? Number(d.categoryId) : 0;
    const stage = findStage(maps.stageByKey, d.stageId);
    return {
      responsibleName: maps.userById.get(Number(d.assignedById)) || `Сотрудник #${d.assignedById}`,
      funnelName: maps.funnelById.get(categoryId) || `Воронка ${categoryId}`,
      title: d.title,
      amount: Number(d.amount) || 0,
      stageName: (stage && stage.name) || d.stageId,
    };
  });
}

module.exports = {
  getFunnels,
  getDealStages,
  getUsers,
  getEmployeesForFilter,
  getStagesReport,
  getMetricsReport,
  getRecentReport,
};
