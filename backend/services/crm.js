// crm.js
// Бизнес-логика поверх реального VibeCode Entity API.
//
// Важные допущения, которые нужно проверить на реальном портале
// (помечены ПРОВЕРИТЬ ниже) — их нельзя было свести к нулю без доступа
// к порталу с настоящими данными:
// - Поле полного имени сотрудника в /v1/users (пробуем несколько
//   вариантов написания).
// - Оператор "входит в список" во фильтре ($in) для assignedById —
//   если платформа его не поддерживает, код автоматически переключится
//   на построчную фильтрацию через Batch (см. комментарий в fetchAllDeals).

const vibeApi = require('./vibeApi');
const cache = require('../utils/cache');
const config = require('../config');
const logger = require('../utils/logger');

// -------------------- Воронки (deal-categories) --------------------

/**
 * GET /v1/deal-categories — список воронок сделок.
 * Кэшируется на bearer, так как ответ может отличаться по правам доступа
 * (на практике воронки одинаковы для всех, но кэш живёт недолго — 5 минут).
 */
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
 * GET /v1/statuses — справочник статусов.
 *
 * ВАЖНО (найдено на реальных данных): у не-дефолтных воронок Битрикс24
 * коды стадий выглядят как "C97:WON", "C41:PREPAYMENT_INVOIC" — номер
 * воронки уже "зашит" в сам код стадии. Соответственно, справочник
 * статусов для таких воронок хранится под entityId вида "DEAL_STAGE_97"
 * (а не просто "DEAL_STAGE", как у дефолтной воронки с id=0). Поэтому:
 * 1) забираем все статусы, у которых entityId равен "DEAL_STAGE" ИЛИ
 *    начинается с "DEAL_STAGE_" — это покрывает все воронки разом;
 * 2) сопоставление с сделкой ведём НАПРЯМУЮ по полному коду стадии
 *    (например "C97:WON"), без отдельной комбинации с categoryId —
 *    код уже однозначно определяет и воронку, и стадию.
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

/**
 * GET /v1/users — список сотрудников портала (для отображения ФИО
 * и для выпадающего списка фильтра). Кэшируется 5 минут.
 * ПРОВЕРИТЬ: точные имена полей ФИО — пробуем несколько вариантов.
 */
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
  // Пробуем распространённые варианты именования полей ФИО.
  const last = u.lastName || u.LAST_NAME || '';
  const first = u.name || u.NAME || u.firstName || '';
  const second = u.secondName || u.SECOND_NAME || '';
  const full = [last, first, second].filter(Boolean).join(' ').trim();
  if (full) return full;
  if (u.fullName) return u.fullName;
  if (u.title) return u.title;
  return `Сотрудник #${u.id}`;
}

// -------------------- Сделки (deals) --------------------

const DEAL_SELECT = ['id', 'title', 'amount', 'currencyId', 'stageId', 'categoryId', 'assignedById', 'createdAt'];

/**
 * Строит объект filter для POST /v1/deals/search на основе параметров дашборда.
 * Синтаксис фильтров: https://vibecode.bitrix24.tech/docs/filtering
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
    // ПРОВЕРИТЬ: оператор $in — если платформа его не поддерживает для этого
    // поля, при единственном сотруднике используем точное равенство,
    // а при нескольких — сузим набор фильтром по факту получения данных
    // (ниже, в fetchAllDeals, есть локальная подстраховка на этот случай).
    filter.assignedById = employeeIds.length === 1 ? employeeIds[0] : { $in: employeeIds };
  }

  return filter;
}

/**
 * Получает ВСЕ сделки под фильтр постранично через курсор по id
 * (см. "Листание и количество записей" в документации VibeCode).
 * Ограничение в 5000 записей на агрегацию платформа накладывает и без нас —
 * ставим тот же практический предел, чтобы не уйти в бесконечный цикл
 * на очень широком фильтре. Если увидите meta.warnings про усечение —
 * сузьте период или воронку.
 */
async function fetchAllDeals(filter, bearer) {
  const PAGE_LIMIT = 1000;
  const MAX_RECORDS = 5000;

  let allDeals = [];
  let cursorFilter = { ...filter };
  let hasMore = true;

  while (hasMore && allDeals.length < MAX_RECORDS) {
    // eslint-disable-next-line no-await-in-loop
    const response = await vibeApi.searchEntity('deals', {
      filter: cursorFilter,
      sort: { id: 'asc' },
      limit: PAGE_LIMIT,
      withTotal: false,
      bearer,
    });

    const page = (response && response.data) || [];
    allDeals = allDeals.concat(page);

    const meta = (response && response.meta) || {};
    hasMore = Boolean(meta.hasMore) && Boolean(meta.nextAfterId);
    if (hasMore) {
      cursorFilter = { ...filter, id: { $gt: meta.nextAfterId } };
    }
  }

  // Локальная подстраховка: если фильтр по нескольким сотрудникам через $in
  // почему-то не сработал на стороне платформы, отфильтруем сами.
  if (filter.assignedById && filter.assignedById.$in) {
    const allowed = new Set(filter.assignedById.$in.map(Number));
    allDeals = allDeals.filter((d) => allowed.has(Number(d.assignedById)));
  }

  return allDeals.map((d) => ({
    id: d.id,
    title: d.title,
    amount: Number(d.amount) || 0,
    stageId: d.stageId,
    categoryId: d.categoryId !== undefined ? Number(d.categoryId) : 0,
    assignedById: Number(d.assignedById),
    createdAt: d.createdAt,
  }));
}

// -------------------- Справочные карты для отображения --------------------

async function buildLookupMaps(bearer) {
  const [funnels, stages, users] = await Promise.all([
    getFunnels(bearer),
    getDealStages(bearer),
    getUsers(bearer),
  ]);
  const funnelById = new Map(funnels.map((f) => [f.id, f.name]));
  // Ключ — полный код стадии как он приходит у сделки (например "C97:WON"
  // для не-дефолтной воронки или просто "NEW" для дефолтной) — без
  // искусственной комбинации с categoryId, см. комментарий в getDealStages.
  const stageByKey = new Map(stages.map((s) => [s.statusId, s]));
  const userById = new Map(users.map((u) => [u.id, u.name]));
  return { funnels, stages, users, funnelById, stageByKey, userById };
}

function findStage(stageByKey, stageId) {
  return stageByKey.get(stageId) || null;
}

// -------------------- Список сотрудников для фильтра --------------------

/**
 * Список сотрудников для выпадающего фильтра — по умолчанию только те,
 * кто фактически является ответственным хотя бы по одной сделке под
 * текущими фильтрами периода/воронки (без учёта самого фильтра по
 * сотрудникам — иначе список сузился бы сам под себя).
 */
async function getEmployeesForFilter({ funnelId, from, to }, bearer) {
  const [deals, { userById }] = await Promise.all([
    fetchAllDeals(buildDealFilter({ funnelId, from, to, employeeIds: null }), bearer),
    buildLookupMaps(bearer),
  ]);

  const ids = new Set(deals.map((d) => d.assignedById));
  return Array.from(ids)
    .map((id) => ({ id, name: userById.get(id) || `Сотрудник #${id}` }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

// -------------------- Сводка по стадиям (группировка: сотрудник × воронка × стадия) --------------------

async function getStagesReport({ funnelId, from, to, employeeIds }, bearer) {
  const [deals, maps] = await Promise.all([
    fetchAllDeals(buildDealFilter({ funnelId, from, to, employeeIds }), bearer),
    buildLookupMaps(bearer),
  ]);

  const groups = new Map(); // key: userId|categoryId|stageId
  deals.forEach((d) => {
    const key = `${d.assignedById}|${d.categoryId}|${d.stageId}`;
    if (!groups.has(key)) {
      groups.set(key, {
        responsibleId: d.assignedById,
        categoryId: d.categoryId,
        stageId: d.stageId,
        count: 0,
        amount: 0,
      });
    }
    const g = groups.get(key);
    g.count += 1;
    g.amount += d.amount;
  });

  const rows = Array.from(groups.values()).map((g) => {
    const stage = findStage(maps.stageByKey, g.stageId);
    return {
      responsibleName: maps.userById.get(g.responsibleId) || `Сотрудник #${g.responsibleId}`,
      funnelName: maps.funnelById.get(g.categoryId) || `Воронка ${g.categoryId}`,
      stageName: (stage && stage.name) || g.stageId,
      count: g.count,
      amount: g.amount,
      _sortStage: (stage && stage.sort) || 0,
    };
  });

  rows.sort((a, b) => a.responsibleName.localeCompare(b.responsibleName, 'ru')
    || a.funnelName.localeCompare(b.funnelName, 'ru')
    || a._sortStage - b._sortStage);

  return rows.map(({ _sortStage, ...rest }) => rest);
}

// -------------------- Ключевые показатели (группировка: сотрудник × воронка) --------------------

async function getMetricsReport({ funnelId, from, to, employeeIds }, bearer) {
  const [deals, maps] = await Promise.all([
    fetchAllDeals(buildDealFilter({ funnelId, from, to, employeeIds }), bearer),
    buildLookupMaps(bearer),
  ]);

  const stageByKeyForSemantics = maps.stageByKey;

  const groups = new Map(); // key: userId|categoryId
  deals.forEach((d) => {
    const key = `${d.assignedById}|${d.categoryId}`;
    if (!groups.has(key)) {
      groups.set(key, {
        responsibleId: d.assignedById,
        categoryId: d.categoryId,
        openAmount: 0,
        wonCount: 0,
        wonAmountSum: 0,
      });
    }
    const g = groups.get(key);
    const stage = findStage(stageByKeyForSemantics, d.stageId);
    const semantics = stage ? stage.semantics : null;

    if (isWonSemantics(semantics)) {
      g.wonCount += 1;
      g.wonAmountSum += d.amount;
    } else if (!isLoseSemantics(semantics)) {
      g.openAmount += d.amount;
    }
  });

  const rows = Array.from(groups.values()).map((g) => ({
    responsibleName: maps.userById.get(g.responsibleId) || `Сотрудник #${g.responsibleId}`,
    funnelName: maps.funnelById.get(g.categoryId) || `Воронка ${g.categoryId}`,
    openAmount: g.openAmount,
    wonCount: g.wonCount,
    avgCheck: g.wonCount > 0 ? g.wonAmountSum / g.wonCount : 0,
    _wonAmountSum: g.wonAmountSum,
  }));

  rows.sort((a, b) => a.responsibleName.localeCompare(b.responsibleName, 'ru')
    || a.funnelName.localeCompare(b.funnelName, 'ru'));

  // Итоговая строка: суммы по открытым и выигранным считаются простым
  // сложением, а средний чек — как отношение суммарной выручки к
  // суммарному числу выигранных сделок (простое сложение самих средних
  // чеков было бы математически бессмысленным).
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
  };
}

// -------------------- Последние сделки --------------------

async function getRecentReport({ funnelId, from, to, employeeIds, limit = 20 }, bearer) {
  const filter = buildDealFilter({ funnelId, from, to, employeeIds });
  const maps = await buildLookupMaps(bearer);

  const response = await vibeApi.searchEntity('deals', {
    filter,
    sort: { createdAt: 'desc' },
    limit,
    withTotal: false,
    bearer,
  });

  let deals = (response && response.data) || [];

  // Та же локальная подстраховка на случай, если $in не сработал на сервере.
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
