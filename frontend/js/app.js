// app.js
// Клиентская логика дашборда. Фронтенд ходит только к своему бэкенду
// (/api/dashboard/*) — ключей и токенов здесь нет и быть не может.

(function () {
  const state = {
    period: 'all',
    from: '',
    to: '',
    funnel: 'all',
    selectedEmployees: null, // null = все сотрудники; иначе Set(id)
  };

  const el = {
    periodSelect: document.getElementById('periodSelect'),
    funnelSelect: document.getElementById('funnelSelect'),
    customDates: document.getElementById('customDates'),
    dateFrom: document.getElementById('dateFrom'),
    dateTo: document.getElementById('dateTo'),
    employeeToggle: document.getElementById('employeeToggle'),
    employeeDropdown: document.getElementById('employeeDropdown'),
    employeeList: document.getElementById('employeeList'),
    employeeSelectAll: document.getElementById('employeeSelectAll'),
    employeeClearAll: document.getElementById('employeeClearAll'),
    globalError: document.getElementById('globalError'),
    metricsContainer: document.getElementById('metricsContainer'),
    metricsTruncatedNote: document.getElementById('metricsTruncatedNote'),
    stagesContainer: document.getElementById('stagesContainer'),
    stagesTruncatedNote: document.getElementById('stagesTruncatedNote'),
    recentContainer: document.getElementById('recentContainer'),
  };

  let allEmployees = [];

  function formatMoney(value) {
    if (value === null || value === undefined) return '—';
    return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(value) + ' ₽';
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
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
    if (state.selectedEmployees && state.selectedEmployees.size > 0) {
      params.set('employees', Array.from(state.selectedEmployees).join(','));
    }
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

  // ---------- Воронки ----------

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
      console.error('Не удалось загрузить список воронок', err.message);
    }
  }

  // ---------- Сотрудники ----------

  function updateEmployeeToggleLabel() {
    if (!state.selectedEmployees || state.selectedEmployees.size === 0) {
      el.employeeToggle.textContent = 'Все сотрудники';
    } else if (state.selectedEmployees.size === 1) {
      const id = Array.from(state.selectedEmployees)[0];
      const emp = allEmployees.find((e) => e.id === id);
      el.employeeToggle.textContent = emp ? emp.name : '1 сотрудник';
    } else {
      el.employeeToggle.textContent = `Выбрано: ${state.selectedEmployees.size}`;
    }
  }

  function renderEmployeeList() {
    if (allEmployees.length === 0) {
      el.employeeList.innerHTML = '<div class="empty-state">Нет сотрудников с сделками</div>';
      return;
    }
    el.employeeList.innerHTML = allEmployees.map((emp) => {
      const checked = state.selectedEmployees && state.selectedEmployees.has(emp.id) ? 'checked' : '';
      return `
        <label class="employee-item">
          <input type="checkbox" data-employee-id="${emp.id}" ${checked} />
          <span>${escapeHtml(emp.name)}</span>
        </label>
      `;
    }).join('');

    el.employeeList.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const id = Number(cb.dataset.employeeId);
        if (!state.selectedEmployees) state.selectedEmployees = new Set();
        if (cb.checked) {
          state.selectedEmployees.add(id);
        } else {
          state.selectedEmployees.delete(id);
        }
        if (state.selectedEmployees.size === 0) state.selectedEmployees = null;
        updateEmployeeToggleLabel();
        reloadAll();
      });
    });
  }

  async function loadEmployees() {
    el.employeeList.innerHTML = '<div class="loader">Загрузка...</div>';
    try {
      const params = new URLSearchParams();
      params.set('period', state.period);
      if (state.period === 'custom') {
        if (state.from) params.set('from', state.from);
        if (state.to) params.set('to', state.to);
      }
      params.set('funnel', state.funnel);

      const data = await fetchJson(`/api/dashboard/employees?${params.toString()}`);
      allEmployees = data.items || [];
      renderEmployeeList();
    } catch (err) {
      el.employeeList.innerHTML = '<div class="empty-state">Не удалось загрузить список</div>';
    }
  }

  el.employeeToggle.addEventListener('click', () => {
    const willOpen = el.employeeDropdown.hidden;
    el.employeeDropdown.hidden = !willOpen;
  });

  document.addEventListener('click', (e) => {
    if (!el.employeeDropdown.hidden
      && !el.employeeDropdown.contains(e.target)
      && e.target !== el.employeeToggle) {
      el.employeeDropdown.hidden = true;
    }
  });

  el.employeeSelectAll.addEventListener('click', () => {
    state.selectedEmployees = new Set(allEmployees.map((e) => e.id));
    renderEmployeeList();
    updateEmployeeToggleLabel();
    reloadAll();
  });

  el.employeeClearAll.addEventListener('click', () => {
    state.selectedEmployees = null;
    renderEmployeeList();
    updateEmployeeToggleLabel();
    reloadAll();
  });

  // ---------- Ключевые показатели ----------

  function renderMetrics(rows, total) {
    if (!rows || rows.length === 0) {
      el.metricsContainer.innerHTML = '<div class="empty-state">Нет данных</div>';
      return;
    }
    const body = rows.map((r) => `
      <tr>
        <td>${escapeHtml(r.responsibleName)}</td>
        <td>${escapeHtml(r.funnelName)}</td>
        <td class="amount">${formatMoney(r.openAmount)}</td>
        <td class="amount">${r.wonCount}</td>
        <td class="amount">${formatMoney(r.avgCheck)}</td>
      </tr>
    `).join('');

    const totalRow = total ? `
      <tr class="total-row">
        <td>${escapeHtml(total.responsibleName)}</td>
        <td></td>
        <td class="amount">${formatMoney(total.openAmount)}</td>
        <td class="amount">${total.wonCount}</td>
        <td class="amount">${formatMoney(total.avgCheck)}</td>
      </tr>
    ` : '';

    el.metricsContainer.innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>Ответственный</th>
            <th>Воронка</th>
            <th class="amount">Сумма открытых сделок</th>
            <th class="amount">Выиграно за период</th>
            <th class="amount">Средний чек</th>
          </tr>
        </thead>
        <tbody>${body}${totalRow}</tbody>
      </table>
    `;
  }

  async function loadMetrics() {
    el.metricsContainer.innerHTML = '<div class="loader">Загрузка...</div>';
    el.metricsTruncatedNote.hidden = true;
    try {
      const data = await fetchJson(`/api/dashboard/metrics?${buildQuery()}`);
      renderMetrics(data.rows, data.total);
      el.metricsTruncatedNote.hidden = !data.truncated;
    } catch (err) {
      el.metricsContainer.innerHTML = '<div class="empty-state">Нет данных</div>';
      throw err;
    }
  }

  // ---------- Сводка по стадиям ----------

  function renderStages(items) {
    if (!items || items.length === 0) {
      el.stagesContainer.innerHTML = '<div class="empty-state">Нет данных</div>';
      return;
    }
    const rows = items.map((s) => `
      <tr>
        <td>${escapeHtml(s.responsibleName)}</td>
        <td>${escapeHtml(s.funnelName)}</td>
        <td class="amount">${s.count}</td>
        <td><span class="stage-badge">${escapeHtml(s.stageName)}</span></td>
        <td class="amount">${formatMoney(s.amount)}</td>
      </tr>
    `).join('');

    el.stagesContainer.innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>Ответственный</th>
            <th>Воронка</th>
            <th class="amount">Кол-во сделок</th>
            <th>Стадия</th>
            <th class="amount">Сумма</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  async function loadStages() {
    el.stagesContainer.innerHTML = '<div class="loader">Загрузка...</div>';
    el.stagesTruncatedNote.hidden = true;
    try {
      const data = await fetchJson(`/api/dashboard/stages?${buildQuery()}`);
      renderStages(data.items);
      el.stagesTruncatedNote.hidden = !data.truncated;
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
        <td>${escapeHtml(d.responsibleName)}</td>
        <td>${escapeHtml(d.funnelName)}</td>
        <td>${escapeHtml(d.title || '—')}</td>
        <td class="amount">${formatMoney(d.amount)}</td>
        <td><span class="stage-badge">${escapeHtml(d.stageName || '—')}</span></td>
      </tr>
    `).join('');

    el.recentContainer.innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>Ответственный</th>
            <th>Воронка</th>
            <th>Название сделки</th>
            <th class="amount">Сумма</th>
            <th>Стадия</th>
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

  // ---------- Общая перезагрузка ----------

  async function reloadAll() {
    clearError();
    const results = await Promise.allSettled([loadMetrics(), loadStages(), loadRecent()]);
    const firstError = results.find((r) => r.status === 'rejected');
    if (firstError) {
      showError(firstError.reason.message || 'Произошла ошибка при получении данных');
    }
  }

  async function reloadEverything() {
    await loadEmployees();
    updateEmployeeToggleLabel();
    await reloadAll();
  }

  // ---------- Обработчики фильтров ----------

  el.periodSelect.addEventListener('change', () => {
    state.period = el.periodSelect.value;
    el.customDates.hidden = state.period !== 'custom';
    state.selectedEmployees = null;
    if (state.period !== 'custom') {
      reloadEverything();
    }
  });

  el.dateFrom.addEventListener('change', () => {
    state.from = el.dateFrom.value;
    if (state.period === 'custom' && state.from && state.to) reloadEverything();
  });

  el.dateTo.addEventListener('change', () => {
    state.to = el.dateTo.value;
    if (state.period === 'custom' && state.from && state.to) reloadEverything();
  });

  el.funnelSelect.addEventListener('change', () => {
    state.funnel = el.funnelSelect.value;
    state.selectedEmployees = null;
    reloadEverything();
  });

  // ---------- Инициализация ----------

  (async function init() {
    await loadFunnels();
    await reloadEverything();
  })();
})();
