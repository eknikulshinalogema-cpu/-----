// app.js
// Клиентская логика дашборда. Фронтенд ходит ТОЛЬКО к своему бэкенду
// (эндпоинты /api/dashboard/*) — никаких прямых обращений к VibeCode API
// и никаких ключей на клиенте.

(function () {
  const state = {
    period: 'all',
    from: '',
    to: '',
    funnel: 'all',
  };

  const el = {
    periodSelect: document.getElementById('periodSelect'),
    funnelSelect: document.getElementById('funnelSelect'),
    customDates: document.getElementById('customDates'),
    dateFrom: document.getElementById('dateFrom'),
    dateTo: document.getElementById('dateTo'),
    globalError: document.getElementById('globalError'),
    metricOpenAmount: document.getElementById('metricOpenAmount'),
    metricWonCount: document.getElementById('metricWonCount'),
    metricAvgCheck: document.getElementById('metricAvgCheck'),
    stagesContainer: document.getElementById('stagesContainer'),
    recentContainer: document.getElementById('recentContainer'),
  };

  function formatMoney(value) {
    if (value === null || value === undefined) return '—';
    return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(value) + ' ₽';
  }

  function showError(message) {
    el.globalError.textContent = message;
    el.globalError.hidden = false;
  }

  function clearError() {
    el.globalError.hidden = true;
    el.globalError.textContent = '';
  }

  function buildQuery(extra) {
    const params = new URLSearchParams();
    params.set('period', state.period);
    if (state.period === 'custom') {
      if (state.from) params.set('from', state.from);
      if (state.to) params.set('to', state.to);
    }
    params.set('funnel', state.funnel);
    if (extra) {
      Object.entries(extra).forEach(([k, v]) => params.set(k, v));
    }
    return params.toString();
  }

  async function fetchJson(url) {
    const response = await fetch(url);
    let body;
    try {
      body = await response.json();
    } catch (e) {
      body = null;
    }
    if (!response.ok) {
      const message = (body && body.error) || 'Произошла ошибка при получении данных';
      const err = new Error(message);
      err.status = response.status;
      throw err;
    }
    return body;
  }

  // ---------- Загрузка справочника воронок ----------

  async function loadFunnels() {
    try {
      const data = await fetchJson('/api/dashboard/funnels');
      const items = data.items || [];
      el.funnelSelect.innerHTML = '';
      items.forEach((item) => {
        const opt = document.createElement('option');
        opt.value = item.id === null ? 'all' : String(item.id);
        opt.textContent = item.name;
        el.funnelSelect.appendChild(opt);
      });
    } catch (err) {
      // Справочник воронок не критичен для остального интерфейса —
      // просто оставляем дефолтную опцию "Все воронки".
      console.error('Не удалось загрузить список воронок', err.message);
    }
  }

  // ---------- Метрики ----------

  function renderMetricsLoading() {
    el.metricOpenAmount.textContent = '…';
    el.metricWonCount.textContent = '…';
    el.metricAvgCheck.textContent = '…';
  }

  async function loadMetrics() {
    renderMetricsLoading();
    try {
      const data = await fetchJson(`/api/dashboard/metrics?${buildQuery()}`);
      el.metricOpenAmount.textContent = formatMoney(data.openAmount);
      el.metricWonCount.textContent = data.wonCount ?? 0;
      el.metricAvgCheck.textContent = formatMoney(data.avgCheck);
    } catch (err) {
      el.metricOpenAmount.textContent = '—';
      el.metricWonCount.textContent = '—';
      el.metricAvgCheck.textContent = '—';
      throw err;
    }
  }

  // ---------- Стадии ----------

  function renderStages(items) {
    if (!items || items.length === 0) {
      el.stagesContainer.innerHTML = '<div class="empty-state">Нет данных</div>';
      return;
    }
    const rows = items.map((s) => `
      <tr>
        <td><span class="stage-badge">${escapeHtml(s.name)}</span></td>
        <td class="amount">${s.count}</td>
        <td class="amount">${formatMoney(s.amount)}</td>
      </tr>
    `).join('');

    el.stagesContainer.innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>Стадия</th>
            <th class="amount">Кол-во сделок</th>
            <th class="amount">Сумма</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  async function loadStages() {
    el.stagesContainer.innerHTML = '<div class="loader">Загрузка...</div>';
    try {
      const data = await fetchJson(`/api/dashboard/stages?${buildQuery()}`);
      renderStages(data.items);
    } catch (err) {
      el.stagesContainer.innerHTML = '<div class="empty-state">Нет данных</div>';
      throw err;
    }
  }

  // ---------- Последние сделки ----------

  function renderRecent(items) {
    if (!items || items.length === 0) {
      el.recentContainer.innerHTML = '<div class="empty-state">Нет данных</div>';
      return;
    }
    const rows = items.map((d) => `
      <tr>
        <td>${escapeHtml(d.title || '—')}</td>
        <td class="amount">${formatMoney(d.amount)}</td>
        <td><span class="stage-badge">${escapeHtml(d.stageName || '—')}</span></td>
        <td>${escapeHtml(String(d.responsible ?? '—'))}</td>
      </tr>
    `).join('');

    el.recentContainer.innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>Название сделки</th>
            <th class="amount">Сумма</th>
            <th>Стадия</th>
            <th>Ответственный</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  async function loadRecent() {
    el.recentContainer.innerHTML = '<div class="loader">Загрузка...</div>';
    try {
      const data = await fetchJson(`/api/dashboard/recent?${buildQuery({ limit: 20 })}`);
      renderRecent(data.items);
    } catch (err) {
      el.recentContainer.innerHTML = '<div class="empty-state">Нет данных</div>';
      throw err;
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ---------- Общая перезагрузка данных ----------

  async function reloadAll() {
    clearError();
    const results = await Promise.allSettled([loadMetrics(), loadStages(), loadRecent()]);
    const firstError = results.find((r) => r.status === 'rejected');
    if (firstError) {
      showError(firstError.reason.message || 'Произошла ошибка при получении данных');
    }
  }

  // ---------- Обработчики фильтров ----------

  el.periodSelect.addEventListener('change', () => {
    state.period = el.periodSelect.value;
    el.customDates.hidden = state.period !== 'custom';
    if (state.period !== 'custom') {
      reloadAll();
    }
  });

  el.dateFrom.addEventListener('change', () => {
    state.from = el.dateFrom.value;
    if (state.period === 'custom' && state.from && state.to) reloadAll();
  });

  el.dateTo.addEventListener('change', () => {
    state.to = el.dateTo.value;
    if (state.period === 'custom' && state.from && state.to) reloadAll();
  });

  el.funnelSelect.addEventListener('change', () => {
    state.funnel = el.funnelSelect.value;
    reloadAll();
  });

  // ---------- Инициализация ----------

  (async function init() {
    await loadFunnels();
    await reloadAll();
  })();
})();
