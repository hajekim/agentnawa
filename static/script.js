let allAgents = [];
let providersHealth = [];
let serviceAccount = '';    // runtime SA email (from /api/agents), shown in the VPC-SC guide
let connections = [];       // configured Gemini connections (Sources view)
let editingId = null;       // connection currently being edited (drives the shared form)
let flyoutTrigger = null;   // element focus is returned to when the flyout closes

const state = {
    view: 'agents',
    source: '', type: '', state: '', q: '',
    sortKey: 'created_at', sortDir: 'desc',
    layout: 'table',
    ovState: '',  // overview: which state the type-breakdown is filtered to ('' = all)
};

// Licenses view: lazy-loaded from /api/licenses. `project` drives the integrated
// (전체) vs per-project (구분) scope; status/q filter only the table.
const licState = {
    data: null, project: '', status: '', q: '',
    sortKey: 'utilization_rate', sortDir: 'desc',
};

// Usage view (Antigravity): lazy-loaded from /api/antigravity/metrics. `days` refetches;
// `project` scopes the KPIs/chart/table; `metric` toggles chart series; q filters the table.
const usageState = {
    data: null, days: 30, project: '', metric: 'tokens', q: '',
    sortKey: 'total_tokens', sortDir: 'desc',
};
let usageChart = null;  // singleton Chart.js instance; destroyed + recreated on every render
let overviewChart = null;  // Overview's own Chart.js instance, SEPARATE from usageChart (own canvas #ov-chart)

async function loadAgents() {
    const res = await fetch('/api/agents');
    const data = await res.json();
    allAgents = data.agents || [];
    providersHealth = data.providers || [];
    serviceAccount = data.service_account || '';
}

document.addEventListener('DOMContentLoaded', async () => {
    bindFlyoutClose();
    loadUser();
    window.addEventListener('hashchange', route);
    try {
        await loadAgents();
    } catch (error) {
        document.getElementById('view-root').innerHTML =
            `<div class="loading">데이터를 불러오지 못했습니다: ${escapeHtml(error.message)}</div>`;
        return;
    }
    route();
});

// Show signed-in email + logout in the sidebar. No-op when login is disabled
// (auth_enabled false) so the local no-auth build looks unchanged.
async function loadUser() {
    try {
        const me = await (await fetch('/api/me')).json();
        if (!me.auth_enabled || !me.email) return;
        const el = document.getElementById('sidebar-user');
        el.innerHTML = `<span class="sidebar-user-email" title="${escapeHtml(me.email)}">${escapeHtml(me.email)}</span>
            <a class="sidebar-logout" href="/logout"><i class="fas fa-right-from-bracket"></i> 로그아웃</a>`;
        el.hidden = false;
    } catch (e) { /* login disabled or offline: leave the block hidden */ }
}

/* ---------- helpers ---------- */
function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

// Only allow http(s) deep links to become clickable; drop anything else.
function safeUrl(u) {
    return (typeof u === 'string' && /^https?:\/\//i.test(u)) ? u : null;
}

function getIcon(type) {
    switch (type) {
        case 'High Code': return '<i class="fas fa-code"></i>';
        case 'Low/No Code': return '<i class="fas fa-pen-nib"></i>';
        case 'A2A': return '<i class="fas fa-network-wired"></i>';
        case 'Workflow': return '<i class="fas fa-diagram-project"></i>';
        case 'Skill': return '<i class="fas fa-screwdriver-wrench"></i>';
        case 'Managed': return '<i class="fas fa-shield-halved"></i>';
        case 'Reasoning Engine': return '<i class="fas fa-brain"></i>';
        default: return '<i class="fas fa-robot"></i>';
    }
}

function typeClass(type) {
    return (type || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function fmtDate(d) {
    return d ? new Date(d).toLocaleDateString() : '—';
}

function providerLabelOf(a) {
    return a.provider_label || a.provider || '';
}

function distinct(mapFn) {
    return [...new Set(allAgents.map(mapFn).filter(Boolean))].sort();
}

function countBy(mapFn) {
    const m = {};
    for (const a of allAgents) {
        const k = mapFn(a);
        m[k] = (m[k] || 0) + 1;
    }
    return m;
}

function opts(arr) {
    return arr.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
}

// Wrap a click handler so Enter/Space activate it too (Space preventDefault: no scroll).
function keyActivate(handler) {
    return e => {
        if (e.key === 'Enter' || e.key === ' ') {
            if (e.key === ' ') e.preventDefault();
            handler(e);
        }
    };
}

/* ---------- router ---------- */
function route() {
    closeFlyout();  // flyout lives outside #view-root; dismiss it when switching views
    const hash = (location.hash || '#/overview').replace('#/', '');
    state.view = ['overview', 'agents', 'licenses', 'usage', 'sources'].includes(hash) ? hash : 'overview';
    document.querySelectorAll('.nav-item').forEach(el => {
        const active = el.dataset.view === state.view;
        el.classList.toggle('active', active);
        if (active) el.setAttribute('aria-current', 'page');
        else el.removeAttribute('aria-current');
    });
    // The Chart.js instance sits on a canvas inside #view-root; leaving usage
    // detaches that canvas, so destroy it here or it leaks until we return.
    if (state.view !== 'usage' && usageChart) { usageChart.destroy(); usageChart = null; }
    if (state.view !== 'overview' && overviewChart) { overviewChart.destroy(); overviewChart = null; }
    if (state.view === 'overview') renderOverview();
    else if (state.view === 'licenses') renderLicenses();
    else if (state.view === 'usage') renderUsage();
    else if (state.view === 'sources') renderSources();
    else renderAgents();
}

/* ---------- agents view ---------- */
function renderAgents() {
    const root = document.getElementById('view-root');
    root.innerHTML = `
        <div class="view-header view-header--row">
            <div>
                <h1>Agents</h1>
                <p>조직에 등록된 모든 에이전트를 검색·필터·관리합니다.</p>
            </div>
            <div class="header-actions">
                <button id="refresh-btn" class="hbtn" aria-label="새로고침"><i class="fas fa-rotate-right"></i></button>
                <button id="export-csv" class="hbtn" aria-label="CSV로 내보내기">CSV</button>
                <button id="export-json" class="hbtn" aria-label="JSON으로 내보내기">JSON</button>
            </div>
        </div>
        <div id="tiles"></div>
        <div class="filter-bar">
            <select id="f-source" class="filter-select" aria-label="Source 필터"><option value="">모든 Source</option>${opts(distinct(providerLabelOf))}</select>
            <select id="f-type" class="filter-select" aria-label="Type 필터"><option value="">모든 Type</option>${opts(distinct(a => a.type))}</select>
            <select id="f-state" class="filter-select" aria-label="State 필터"><option value="">모든 State</option>${opts(distinct(a => a.state))}</select>
            <input id="search" class="search-input" type="search" placeholder="이름·설명·타입 검색" aria-label="에이전트 검색">
            <span class="spacer"></span>
            <div class="view-toggle">
                <button id="v-table" title="테이블 보기" aria-label="테이블 보기"><i class="fas fa-table-list"></i></button>
                <button id="v-cards" title="카드 보기" aria-label="카드 보기"><i class="fas fa-table-cells-large"></i></button>
            </div>
        </div>
        <div class="result-count" id="result-count"></div>
        <div id="agent-list"></div>`;

    const src = root.querySelector('#f-source');
    const typ = root.querySelector('#f-type');
    const stt = root.querySelector('#f-state');
    const srch = root.querySelector('#search');
    src.value = state.source; typ.value = state.type; stt.value = state.state; srch.value = state.q;

    src.addEventListener('change', () => { state.source = src.value; updateList(); updateTiles(); });
    typ.addEventListener('change', () => { state.type = typ.value; updateList(); updateTiles(); });
    stt.addEventListener('change', () => { state.state = stt.value; updateList(); updateTiles(); });
    srch.addEventListener('input', () => { state.q = srch.value; updateList(); updateTiles(); });
    root.querySelector('#v-table').addEventListener('click', () => { state.layout = 'table'; updateList(); });
    root.querySelector('#v-cards').addEventListener('click', () => { state.layout = 'cards'; updateList(); });
    root.querySelector('#refresh-btn').addEventListener('click', onRefresh);
    root.querySelector('#export-csv').addEventListener('click', exportCSV);
    root.querySelector('#export-json').addEventListener('click', exportJSON);

    const tiles = document.getElementById('tiles');
    const listEl = document.getElementById('agent-list');
    tiles.addEventListener('click', onTileClick);
    tiles.addEventListener('keydown', keyActivate(onTileClick));
    listEl.addEventListener('click', onListClick);
    listEl.addEventListener('keydown', keyActivate(onListClick));

    updateTiles();
    updateList();
}

async function onRefresh() {
    const btn = document.getElementById('refresh-btn');
    btn.disabled = true;
    btn.classList.add('loading');
    try { await loadAgents(); } catch (e) { /* keep current data on failure */ }
    renderAgents();  // rebuilds tiles + list + filters with the refreshed data
}

function updateTiles() {
    const byState = countBy(a => a.state || 'UNKNOWN');
    const byProv = countBy(providerLabelOf);
    let html = '';
    html += tile('total', '', 'Total', allAgents.length, !state.source && !state.state && !state.type && !state.q);
    for (const s of ['ENABLED', 'PRIVATE']) {
        if (byState[s] != null) html += tile('state', s, s, byState[s], state.state === s);
    }
    for (const [p, c] of Object.entries(byProv)) {
        html += tile('source', p, p, c, state.source === p);
    }
    document.getElementById('tiles').innerHTML = `<div class="tiles">${html}</div>`;
}

function tile(kind, val, label, value, active) {
    return `<div class="tile ${active ? 'active' : ''}" role="button" tabindex="0" data-tilekind="${kind}" data-tileval="${escapeHtml(val)}">
        <div class="tile-value">${value}</div>
        <div class="tile-label">${escapeHtml(label)}</div>
    </div>`;
}

function onTileClick(e) {
    const el = e.target.closest('.tile');
    if (!el) return;
    const kind = el.dataset.tilekind;
    const val = el.dataset.tileval;
    if (kind === 'total') { state.source = ''; state.state = ''; state.type = ''; state.q = ''; }
    else if (kind === 'state') { state.state = state.state === val ? '' : val; }
    else if (kind === 'source') { state.source = state.source === val ? '' : val; }
    syncControls();
    updateList();
    updateTiles();
}

function syncControls() {
    const root = document.getElementById('view-root');
    const map = { '#f-source': 'source', '#f-type': 'type', '#f-state': 'state', '#search': 'q' };
    for (const [sel, key] of Object.entries(map)) {
        const el = root.querySelector(sel);
        if (el) el.value = state[key];
    }
}

function filteredAgents() {
    const q = state.q.trim().toLowerCase();
    const list = allAgents.filter(a =>
        (!state.source || providerLabelOf(a) === state.source) &&
        (!state.type || (a.type || '') === state.type) &&
        (!state.state || (a.state || '') === state.state) &&
        (!q ||
            (a.display_name || '').toLowerCase().includes(q) ||
            (a.description || '').toLowerCase().includes(q) ||
            (a.type || '').toLowerCase().includes(q) ||
            (a.state || '').toLowerCase().includes(q))
    );
    const k = state.sortKey;
    const dir = state.sortDir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
        const va = k === 'provider' ? providerLabelOf(a) : (a[k] || '');
        const vb = k === 'provider' ? providerLabelOf(b) : (b[k] || '');
        return String(va).localeCompare(String(vb), undefined, { numeric: true }) * dir;
    });
    return list;
}

function updateList() {
    const t = document.getElementById('v-table');
    const c = document.getElementById('v-cards');
    if (t && c) {
        t.classList.toggle('active', state.layout === 'table');
        c.classList.toggle('active', state.layout === 'cards');
        t.setAttribute('aria-pressed', String(state.layout === 'table'));
        c.setAttribute('aria-pressed', String(state.layout === 'cards'));
    }
    const list = filteredAgents();
    document.getElementById('result-count').textContent = `${list.length}개 에이전트`;
    document.getElementById('agent-list').innerHTML =
        state.layout === 'cards' ? cardsHTML(list) : tableHTML(list);
}

function toggleSort(k) {
    if (state.sortKey === k) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    else { state.sortKey = k; state.sortDir = 'asc'; }
    updateList();
}

/* ---------- export (current filtered+sorted list) ---------- */
// visible columns + id/provider; provider_label surfaces the "Source" column value
const EXPORT_COLS = ['id', 'provider', 'provider_label', 'display_name', 'type', 'state', 'created_at'];

function csvCell(v) {
    return `"${String(v ?? '').replace(/"/g, '""')}"`;
}

function download(content, filename, mime) {
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

function exportCSV() {
    const rows = filteredAgents().map(a => EXPORT_COLS.map(k => csvCell(a[k])).join(','));
    download([EXPORT_COLS.join(','), ...rows].join('\r\n'), 'agents.csv', 'text/csv');
}

function exportJSON() {
    const list = filteredAgents().map(a =>
        Object.fromEntries(EXPORT_COLS.map(k => [k, a[k] ?? null])));
    download(JSON.stringify(list, null, 2), 'agents.json', 'application/json');
}

function onListClick(e) {
    if (e.target.closest('a')) return;              // open link handles itself
    const th = e.target.closest('th[data-sort]');
    if (th) { toggleSort(th.dataset.sort); return; }
    const row = e.target.closest('[data-id]');
    if (row) openFlyout(row.dataset.id);
}

const TABLE_COLS = [
    { k: 'display_name', label: 'Name' },
    { k: 'provider', label: 'Source' },
    { k: 'type', label: 'Type' },
    { k: 'state', label: 'State' },
    { k: 'created_at', label: 'Created' },
    { k: null, label: '' },
];

function tableHTML(list) {
    if (!list.length) return `<div class="loading">조건에 맞는 에이전트가 없습니다.</div>`;
    const head = TABLE_COLS.map(col => col.k
        ? `<th data-sort="${col.k}" role="button" tabindex="0" aria-sort="${state.sortKey === col.k ? (state.sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}">${col.label} <span class="sort-ind">${state.sortKey === col.k ? (state.sortDir === 'asc' ? '▲' : '▼') : ''}</span></th>`
        : `<th></th>`).join('');
    const rows = list.map(a => {
        const url = safeUrl(a.open_url);
        const type = a.type || 'Unknown';
        const st = a.state || 'UNKNOWN';
        return `<tr data-id="${escapeHtml(a.id)}" role="button" tabindex="0">
            <td class="name-cell"><span class="cell-icon">${getIcon(type)}</span>${escapeHtml(a.display_name) || 'Unnamed Agent'}</td>
            <td>${escapeHtml(providerLabelOf(a))}</td>
            <td><span class="badge badge-${typeClass(type)}">${escapeHtml(type)}</span></td>
            <td><span class="state-badge state-${typeClass(st)}">${escapeHtml(st)}</span></td>
            <td>${fmtDate(a.created_at)}</td>
            <td>${url
                ? `<a class="action-btn open-btn" href="${escapeHtml(url)}" target="_blank" rel="noopener" title="열기"><i class="fas fa-up-right-from-square"></i></a>`
                : `<span class="action-btn disabled" title="열기 링크 없음"><i class="fas fa-ban"></i></span>`}</td>
        </tr>`;
    }).join('');
    return `<table class="agent-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

function cardsHTML(list) {
    if (!list.length) return `<div class="loading">조건에 맞는 에이전트가 없습니다.</div>`;
    const cards = list.map(a => {
        const url = safeUrl(a.open_url);
        const type = a.type || 'Unknown';
        const st = a.state || 'UNKNOWN';
        return `<div class="card" role="button" tabindex="0" data-id="${escapeHtml(a.id)}">
            <div class="card-header">
                <div class="icon-wrapper">${getIcon(type)}</div>
                <div class="badges">
                    <span class="state-badge state-${typeClass(st)}">${escapeHtml(st)}</span>
                    <span class="badge badge-${typeClass(type)}">${escapeHtml(type)}</span>
                </div>
            </div>
            <div class="card-body">
                <h2 title="${escapeHtml(a.display_name)}">${escapeHtml(a.display_name) || 'Unnamed Agent'}</h2>
                <p>${escapeHtml(a.description) || 'No description available.'}</p>
            </div>
            <div class="card-footer">
                <div class="footer-left">
                    <span>Source: ${escapeHtml(providerLabelOf(a))}</span><br/>
                    <span>Created: ${fmtDate(a.created_at)}</span>
                </div>
                <div class="footer-right">
                    ${url
                        ? `<a class="action-btn open-btn" href="${escapeHtml(url)}" target="_blank" rel="noopener"><i class="fas fa-up-right-from-square"></i> 열기</a>`
                        : `<span class="action-btn disabled" title="열기 링크 없음"><i class="fas fa-ban"></i></span>`}
                </div>
            </div>
        </div>`;
    }).join('');
    return `<div class="grid">${cards}</div>`;
}

/* ---------- detail flyout ---------- */
// fields already surfaced above; anything else on the agent goes in the raw-fields section
const SHOWN_KEYS = ['id', 'provider', 'provider_label', 'display_name', 'description', 'type', 'state', 'created_at', 'open_url'];

function extraFieldsHTML(a) {
    const items = Object.keys(a)
        .filter(k => !SHOWN_KEYS.includes(k) && a[k] != null && a[k] !== '')
        .map(k => `<li><span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(String(a[k]))}</span></li>`)
        .join('');
    if (!items) return '';
    return `<details class="raw-fields"><summary>추가 필드</summary><ul class="meta-list">${items}</ul></details>`;
}

// Fill and reveal the shared #flyout; caller supplies inner HTML that must
// include a .flyout-close button. Focus capture/restore + trap live here.
function showFlyout(html) {
    flyoutTrigger = document.activeElement;  // restore focus here on close
    const fly = document.getElementById('flyout');
    fly.innerHTML = html;
    fly.querySelector('.flyout-close').addEventListener('click', closeFlyout);
    document.getElementById('flyout-backdrop').hidden = false;
    fly.hidden = false;
    fly.setAttribute('aria-hidden', 'false');
    fly.querySelector('.flyout-close').focus();
}

function openFlyout(id) {
    const a = allAgents.find(x => x.id === id);
    if (!a) return;
    const url = safeUrl(a.open_url);
    const type = a.type || 'Unknown';
    const st = a.state || 'UNKNOWN';
    showFlyout(`
        <button class="flyout-close" aria-label="닫기">&times;</button>
        <h2>${escapeHtml(a.display_name) || 'Unnamed Agent'}</h2>
        <div class="flyout-badges">
            <span class="state-badge state-${typeClass(st)}">${escapeHtml(st)}</span>
            <span class="badge badge-${typeClass(type)}">${escapeHtml(type)}</span>
        </div>
        <p class="fly-desc">${escapeHtml(a.description) || '설명이 없습니다.'}</p>
        <ul class="meta-list">
            <li><span class="k">Source</span><span class="v">${escapeHtml(providerLabelOf(a))}</span></li>
            <li><span class="k">Type</span><span class="v">${escapeHtml(type)}</span></li>
            <li><span class="k">State</span><span class="v">${escapeHtml(st)}</span></li>
            <li><span class="k">Created</span><span class="v">${fmtDate(a.created_at)}</span></li>
            <li><span class="k">Provider</span><span class="v">${escapeHtml(a.provider)}</span></li>
            <li><span class="k">ID</span><span class="v">${escapeHtml(a.id)}</span></li>
        </ul>
        ${extraFieldsHTML(a)}
        ${url
            ? `<a class="open-primary" href="${escapeHtml(url)}" target="_blank" rel="noopener"><i class="fas fa-up-right-from-square"></i> 열기</a>`
            : `<span class="open-primary disabled"><i class="fas fa-ban"></i> 열기 링크 없음</span>`}`);
}

function closeFlyout() {
    const fly = document.getElementById('flyout');
    if (fly.hidden) return;  // already closed: don't steal focus (called on every route())
    fly.hidden = true;
    fly.setAttribute('aria-hidden', 'true');
    document.getElementById('flyout-backdrop').hidden = true;
    if (flyoutTrigger && flyoutTrigger.focus) flyoutTrigger.focus();
    flyoutTrigger = null;
}

function bindFlyoutClose() {
    document.getElementById('flyout-backdrop').addEventListener('click', closeFlyout);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeFlyout(); });
    document.getElementById('flyout').addEventListener('keydown', trapFocus);
}

// Keep Tab focus inside the flyout while it is open.
function trapFocus(e) {
    if (e.key !== 'Tab') return;
    const fly = document.getElementById('flyout');
    const f = fly.querySelectorAll('button, a[href], summary, [tabindex="0"]');
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

/* ---------- overview view ---------- */
function renderOverview() {
    const root = document.getElementById('view-root');
    const byState = countBy(a => a.state || 'UNKNOWN');
    // Total/ENABLED/PRIVATE tiles filter the breakdown below in place; Sources jumps to the Sources view.
    const scope = state.ovState ? allAgents.filter(a => (a.state || 'UNKNOWN') === state.ovState) : allAgents;
    const byType = {};
    for (const a of scope) { const t = a.type || 'Unknown'; byType[t] = (byType[t] || 0) + 1; }
    const stat = (kind, val, label, value) => {
        const active = kind === 'ovtotal' ? !state.ovState : (kind === 'ovstate' && state.ovState === val);
        return `<div class="tile ${active ? 'active' : ''}" role="button" tabindex="0" data-ovkind="${kind}" data-ovval="${escapeHtml(val)}">
            <div class="tile-value">${value}</div>
            <div class="tile-label">${escapeHtml(label)}</div>
        </div>`;
    };
    root.innerHTML = `
        <div class="view-header">
            <h1>Overview</h1>
            <p>등록된 에이전트 현황 요약입니다.</p>
        </div>
        ${providersHealth.length ? '' : onboardBanner()}
        <div class="dash-grid">
            ${stat('ovtotal', '', 'Total agents', allAgents.length)}
            ${stat('ovstate', 'ENABLED', 'ENABLED', byState['ENABLED'] || 0)}
            ${stat('ovstate', 'PRIVATE', 'PRIVATE', byState['PRIVATE'] || 0)}
            ${stat('ovsources', '', 'Sources', providersHealth.length)}
        </div>
        ${healthHTML()}
        ${vpcScGuideHTML()}
        <div class="breakdown">
            <h3>타입별 분포${state.ovState ? ` · <span class="bk-filter">${escapeHtml(state.ovState)}</span>` : ''}</h3>
            ${barsHTML(byType)}
        </div>
        <h3 class="section-title">라이선스</h3>
        <div id="ov-lic"><div class="result-count">라이선스를 불러오는 중…</div></div>
        <h3 class="section-title">사용량 (Antigravity)</h3>
        <div id="ov-usage"><div class="result-count">사용량을 불러오는 중…</div></div>`;
    const grid = root.querySelector('.dash-grid');
    grid.addEventListener('click', onOverviewTile);
    grid.addEventListener('keydown', keyActivate(onOverviewTile));
    // Progressive fill: license + usage each fetch independently (cached into
    // licState/usageState); a slow/unconfigured usage never blocks the rest.
    fillOverviewLic();
    fillOverviewUsage();
}

// Integrated license summary (KPI + per-project utilization bars). Reads
// licState.data.projects directly so a sticky detail-view selection can't scope it.
async function fillOverviewLic() {
    if (!licState.data) {
        try { await loadLicenses(); }
        catch (error) {
            const host = document.getElementById('ov-lic');
            if (host) host.innerHTML = `<div class="result-count">라이선스를 불러오지 못했습니다: ${escapeHtml(error.message)}</div>`;
            return;
        }
    }
    const host = document.getElementById('ov-lic');
    if (!host) return;  // tile re-render or nav-away detached the container
    const s = licSummary(licState.data.projects);
    host.innerHTML = licHealthHTML() + kpiHTML([
        ['총 라이선스', s.total.toLocaleString()],
        ['배정', s.assigned.toLocaleString()],
        ['잔여', s.available.toLocaleString()],
        ['사용률', s.util + '%'],
    ]) + `<div class="breakdown"><h3>프로젝트별 사용률</h3>${
        licBarsHTML(licState.data.projects) || '<div class="result-count">표시할 활성 라이선스가 없습니다.</div>'
    }</div>`;
}

// Integrated usage summary (KPI + daily-trend chart + per-project token bars).
// Reads usageState.data.summary directly (always 통합); degrades to the message
// banner with no chart when unconfigured / no logs.
async function fillOverviewUsage() {
    if (!usageState.data) {
        try { await loadUsage(); }
        catch (error) {
            const host = document.getElementById('ov-usage');
            if (host) host.innerHTML = `<div class="result-count">사용량을 불러오지 못했습니다: ${escapeHtml(error.message)}</div>`;
            return;
        }
    }
    const host = document.getElementById('ov-usage');
    if (!host) return;
    const s = usageState.data.summary;
    const hasDaily = (usageState.data.daily || []).length > 0;
    host.innerHTML = usageMessageHTML() + usageHealthHTML() + kpiHTML([
        ['총 추론', s.total_inferences.toLocaleString()],
        ['총 토큰', fmtNum(s.total_tokens)],
        ['활성 사용자', s.active_users.toLocaleString()],
        ['모니터링 프로젝트', s.monitored_projects.toLocaleString()],
    ]) + (hasDaily ? `<div class="chart-card"><h3>일별 추세 (토큰)</h3>
        <div class="chart-wrap"><canvas id="ov-chart"></canvas></div></div>
        <div class="breakdown"><h3>프로젝트별 토큰 사용량</h3>${
            usageBarsHTML(usageState.data.projects) || '<div class="result-count">표시할 사용량이 없습니다.</div>'
        }</div>` : '');
    if (hasDaily) renderOverviewChart();
}

// Integrated daily-token area chart on its own canvas/instance (never #ag-chart/usageChart).
function renderOverviewChart() {
    const canvas = document.getElementById('ov-chart');
    if (!canvas || typeof Chart === 'undefined') return;  // CDN unreachable → skip chart, rest works
    if (overviewChart) { overviewChart.destroy(); overviewChart = null; }
    const daily = usageState.data.daily || [];
    if (!daily.length) return;
    const color = USAGE_COLORS[0];
    overviewChart = new Chart(canvas, {
        type: 'line',
        data: {
            labels: daily.map(d => d.date),
            datasets: [{
                label: '토큰', data: daily.map(d => d.tokens || 0),
                backgroundColor: color + '33', borderColor: color, borderWidth: 2,
                fill: true, tension: 0.3, pointRadius: 0,
            }],
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { callback: v => fmtNum(v) } } },
            plugins: { legend: { display: false } },
        },
    });
}

function onOverviewTile(e) {
    const el = e.target.closest('.tile');
    if (!el) return;
    const kind = el.dataset.ovkind;
    if (kind === 'ovsources') { location.hash = '#/sources'; return; }
    if (kind === 'ovtotal') state.ovState = '';
    else if (kind === 'ovstate') state.ovState = state.ovState === el.dataset.ovval ? '' : el.dataset.ovval;
    renderOverview();
}

function barsHTML(counts) {
    const max = Math.max(1, ...Object.values(counts));
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `
        <div class="bar-row">
            <span class="bar-label">${escapeHtml(k)}</span>
            <span class="bar-track"><span class="bar-fill" style="width:${Math.round(v / max * 100)}%"></span></span>
            <span class="bar-count">${v}</span>
        </div>`).join('');
}

// One health chip. VPC-SC denials render amber (an expected onboarding state, not
// a red outage) with the actionable hint + copyable uid; everything else is the
// generic red error. `verb` is the view-specific failure phrase.
function healthRow(p, verb) {
    if (p.error_type === 'vpc_sc') {
        const v = p.vpc_sc || {};
        const svc = v.service ? ` (${escapeHtml(v.service)})` : '';
        const uid = v.unique_id ? `<code>uid: ${escapeHtml(v.unique_id)}</code>` : '';
        return `<span class="health-vpcsc">🔒 ${escapeHtml(p.label || p.name)} — VPC-SC 온보딩 대기${svc}`
            + `<span class="health-hint">${escapeHtml(p.hint || '')} ${uid}</span></span>`;
    }
    return `<span class="health-error">⚠ ${escapeHtml(p.label || p.name)} ${verb}: ${escapeHtml(p.error || '')}</span>`;
}

function healthHTML() {
    const problems = providersHealth.filter(p => p.status !== 'ok');
    if (!problems.length) return '';
    return `<div class="provider-health">${problems.map(p => healthRow(p, '사용 불가')).join('')}</div>`;
}

// VPC-SC onboarding guide, shown on Overview ONLY when >=1 connection is blocked
// by a perimeter. Names the exact identity (runtime SA) the customer's org admin
// must allow through ingress, plus the concise steps. Full doc: docs/vpc-sc-onboarding.md.
function vpcScGuideHTML() {
    const blocked = providersHealth.filter(p => p.error_type === 'vpc_sc');
    if (!blocked.length) return '';
    const rows = blocked.map(p => {
        const v = p.vpc_sc || {};
        const svc = v.service ? ` · ${escapeHtml(v.service)}` : '';
        const uid = v.unique_id ? ` · <code>uid: ${escapeHtml(v.unique_id)}</code>` : '';
        return `<li>${escapeHtml(p.label || p.name)}${svc}${uid}</li>`;
    }).join('');
    const sa = serviceAccount
        ? `<code>${escapeHtml(serviceAccount)}</code>`
        : '<span class="vpcsc-guide-muted">(관리자에게 문의 — 이 인스턴스의 서비스 계정)</span>';
    return `<div class="vpcsc-guide">
        <h3 class="vpcsc-guide-title">🔒 VPC Service Controls 온보딩 가이드</h3>
        <p>아래 연결은 대상 프로젝트가 VPC-SC 경계 안에 있어 차단됐습니다. Agent Nawa는 경계 밖에서 읽기 때문에, 고객사 조직 관리자가 <strong>우리 서비스 계정을 인그레스 규칙에 허용</strong>해야 정상화됩니다.</p>
        <ul class="vpcsc-guide-list">${rows}</ul>
        <p class="vpcsc-guide-sa">허용할 신원(서비스 계정): ${sa}</p>
        <ol class="vpcsc-guide-steps">
            <li>위 서비스 계정을 고객사 조직/보안 관리자에게 전달합니다.</li>
            <li>관리자가 경계 인그레스 규칙에 이 계정을 허용합니다 — <code>sources: accessLevel:"*"</code>, <code>resources: projects/&lt;프로젝트번호&gt;</code>, 대상 서비스는 <code>discoveryengine</code>·<code>aiplatform</code>.</li>
            <li>대상 프로젝트에 읽기 전용 IAM을 부여합니다 (<code>discoveryengine.viewer</code>·<code>aiplatform.viewer</code>; 에이전트 목록엔 <code>discoveryengine.editor</code>가 필요할 수 있음).</li>
            <li>dry-run으로 검증 후 enforce로 승격합니다. 완료되면 위 연결이 자동으로 정상 표시됩니다.</li>
        </ol>
        <details class="vpcsc-guide-more">
            <summary>자세히 / 트러블슈팅</summary>
            <p>인그레스 규칙은 IAM 역할이 아니라 <strong>메서드</strong>로 지정하고, <code>sources</code>에는 <code>resource:</code> 대신 <code>accessLevel:"*"</code>를 씁니다(우리 egress IP는 마스킹됨). 콘솔의 <strong>위반 분석기</strong>에서 위 <code>uid</code>로 원인을 조회할 수 있습니다. 전체 절차는 저장소의 <code>docs/vpc-sc-onboarding.md</code>를 참고하세요.</p>
        </details>
    </div>`;
}

/* ---------- licenses view ---------- */
// non-interactive KPI tiles (shared shape with the agents tiles, no click)
function kpiHTML(pairs) {
    return `<div class="tiles">` + pairs.map(([label, val]) =>
        `<div class="tile tile--static"><div class="tile-value">${escapeHtml(String(val))}</div><div class="tile-label">${escapeHtml(label)}</div></div>`
    ).join('') + `</div>`;
}

async function loadLicenses() {
    const res = await fetch('/api/licenses');
    licState.data = await res.json();
}

async function renderLicenses() {
    const root = document.getElementById('view-root');
    if (!licState.data) {
        root.innerHTML = `<div class="loading">라이선스를 불러오는 중…</div>`;
        try { await loadLicenses(); }
        catch (error) {
            root.innerHTML = `<div class="loading">라이선스를 불러오지 못했습니다: ${escapeHtml(error.message)}</div>`;
            return;
        }
    }
    const projectIds = [...new Set(licState.data.projects.map(p => p.project_id))].sort();
    if (licState.project && !projectIds.includes(licState.project)) licState.project = '';  // stale selection
    const statuses = [...new Set(licState.data.projects.map(p => p.status))].sort();
    if (licState.status && !statuses.includes(licState.status)) licState.status = '';  // stale selection
    root.innerHTML = `
        <div class="view-header view-header--row">
            <div>
                <h1>Licenses</h1>
                <p>등록된 Gemini Enterprise 프로젝트의 라이선스 좌석 할당·사용률입니다.</p>
            </div>
            <div class="header-actions">
                <button id="lic-refresh" class="hbtn" aria-label="새로고침"><i class="fas fa-rotate-right"></i></button>
                <button id="lic-csv" class="hbtn" aria-label="CSV로 내보내기">CSV</button>
            </div>
        </div>
        ${licHealthHTML()}
        <div id="lic-tiles"></div>
        <div class="filter-bar">
            <select id="lic-project" class="filter-select" aria-label="프로젝트 필터">
                <option value="">전체 (통합)</option>${opts(projectIds)}
            </select>
            <select id="lic-status" class="filter-select" aria-label="상태 필터">
                <option value="">모든 상태</option>${opts(statuses)}
            </select>
            <input id="lic-search" class="search-input" type="search" placeholder="프로젝트·구성 검색" aria-label="라이선스 검색">
        </div>
        <div class="breakdown"><h3>프로젝트별 사용률</h3><div id="lic-bars"></div></div>
        <div class="result-count" id="lic-count"></div>
        <div id="lic-table"></div>`;

    const proj = root.querySelector('#lic-project');
    const stt = root.querySelector('#lic-status');
    const srch = root.querySelector('#lic-search');
    proj.value = licState.project; stt.value = licState.status; srch.value = licState.q;
    proj.addEventListener('change', () => { licState.project = proj.value; updateLicView(); });
    stt.addEventListener('change', () => { licState.status = stt.value; updateLicView(); });
    srch.addEventListener('input', () => { licState.q = srch.value; updateLicView(); });
    root.querySelector('#lic-refresh').addEventListener('click', onLicRefresh);
    root.querySelector('#lic-csv').addEventListener('click', exportLicensesCSV);
    const tableEl = root.querySelector('#lic-table');
    tableEl.addEventListener('click', onLicTableClick);
    tableEl.addEventListener('keydown', keyActivate(onLicTableClick));

    updateLicView();
}

function licHealthHTML() {
    const probs = (licState.data.providers || []).filter(p => p.status !== 'ok');
    if (!probs.length) return '';
    return `<div class="provider-health">${probs.map(p => healthRow(p, '라이선스 조회 실패')).join('')}</div>`;
}

// KPI scope follows the project selector only (전체=통합 / 선택=구분).
function licScope() {
    const all = licState.data.projects;
    return licState.project ? all.filter(p => p.project_id === licState.project) : all;
}

// Totals count usable licenses only; EXPIRED stays in the table but not the KPIs.
function licSummary(rows) {
    const active = rows.filter(p => p.status !== 'EXPIRED');
    const total = active.reduce((a, p) => a + (p.allocated_seats || 0), 0);
    const assigned = active.reduce((a, p) => a + (p.assigned_count || 0), 0);
    return {
        total, assigned,
        available: active.reduce((a, p) => a + (p.available_count || 0), 0),
        util: total ? Math.round(assigned / total * 10000) / 100 : 0,
    };
}

function licFiltered() {
    let rows = licScope();
    if (licState.status) rows = rows.filter(p => p.status === licState.status);
    const q = licState.q.trim().toLowerCase();
    if (q) rows = rows.filter(p =>
        (p.project_id || '').toLowerCase().includes(q) ||
        (p.license_config_id || '').toLowerCase().includes(q) ||
        (p.label || '').toLowerCase().includes(q));
    const k = licState.sortKey, dir = licState.sortDir === 'asc' ? 1 : -1;
    return rows.slice().sort((a, b) => {
        const va = a[k], vb = b[k];
        if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
        return String(va ?? '').localeCompare(String(vb ?? ''), undefined, { numeric: true }) * dir;
    });
}

// Per-project utilization bars over the filtered (non-expired) rows.
function licBarsHTML(rows) {
    const byProj = {};
    for (const p of rows) {
        if (p.status === 'EXPIRED') continue;
        const g = byProj[p.project_id] || (byProj[p.project_id] = { alloc: 0, asg: 0 });
        g.alloc += p.allocated_seats || 0;
        g.asg += p.assigned_count || 0;
    }
    const entries = Object.entries(byProj).filter(([, g]) => g.alloc > 0);
    if (!entries.length) return '';
    return entries.sort((a, b) => (b[1].asg / b[1].alloc) - (a[1].asg / a[1].alloc)).map(([pid, g]) => {
        const util = Math.round(g.asg / g.alloc * 100);
        return `<div class="bar-row">
            <span class="bar-label" title="${escapeHtml(pid)}">${escapeHtml(pid)}</span>
            <span class="bar-track"><span class="bar-fill" style="width:${Math.min(100, util)}%"></span></span>
            <span class="bar-count">${util}%</span>
        </div>`;
    }).join('');
}

function updateLicView() {
    const s = licSummary(licScope());
    document.getElementById('lic-tiles').innerHTML = kpiHTML([
        ['총 라이선스', s.total.toLocaleString()],
        ['배정', s.assigned.toLocaleString()],
        ['잔여', s.available.toLocaleString()],
        ['사용률', s.util + '%'],
    ]);
    const rows = licFiltered();
    document.getElementById('lic-bars').innerHTML =
        licBarsHTML(rows) || `<div class="result-count">표시할 활성 라이선스가 없습니다.</div>`;
    document.getElementById('lic-count').textContent = `${rows.length}개 라이선스 구성`;
    document.getElementById('lic-table').innerHTML = licTableHTML(rows);
}

const LIC_TABLE_COLS = [
    { k: 'project_id', label: 'Project' },
    { k: 'license_config_id', label: 'Config' },
    { k: 'subscription_tier', label: 'Tier' },
    { k: 'allocated_seats', label: 'Allocated' },
    { k: 'assigned_count', label: 'Assigned' },
    { k: 'available_count', label: 'Available' },
    { k: 'utilization_rate', label: 'Util %' },
    { k: 'status', label: 'Status' },
    { k: 'end_date', label: 'End' },
];

function licTier(t) { return (t || '').replace('SUBSCRIPTION_TIER_', '') || '—'; }

function licTableHTML(rows) {
    if (!rows.length) return `<div class="loading">조건에 맞는 라이선스가 없습니다.</div>`;
    const head = LIC_TABLE_COLS.map(col =>
        `<th data-sort="${col.k}" role="button" tabindex="0" aria-sort="${licState.sortKey === col.k ? (licState.sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}">${col.label} <span class="sort-ind">${licState.sortKey === col.k ? (licState.sortDir === 'asc' ? '▲' : '▼') : ''}</span></th>`).join('');
    const body = rows.map((p, i) => `<tr data-ridx="${i}" role="button" tabindex="0">
        <td class="name-cell">${escapeHtml(p.project_id)}</td>
        <td>${escapeHtml(p.license_config_id)}</td>
        <td>${escapeHtml(licTier(p.subscription_tier))}</td>
        <td>${(p.allocated_seats || 0).toLocaleString()}</td>
        <td>${(p.assigned_count || 0).toLocaleString()}</td>
        <td>${(p.available_count || 0).toLocaleString()}</td>
        <td>${p.utilization_rate}%</td>
        <td><span class="state-badge lic-${escapeHtml((p.status || '').toLowerCase())}">${escapeHtml(p.status)}</span></td>
        <td>${escapeHtml(p.end_date || '—')}</td>
    </tr>`).join('');
    return `<table class="agent-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function onLicTableClick(e) {
    const th = e.target.closest('th[data-sort]');
    if (th) {
        const k = th.dataset.sort;
        if (licState.sortKey === k) licState.sortDir = licState.sortDir === 'asc' ? 'desc' : 'asc';
        else { licState.sortKey = k; licState.sortDir = 'asc'; }
        updateLicView();
        return;
    }
    const row = e.target.closest('tr[data-ridx]');
    if (row) openLicenseFlyout(licFiltered()[Number(row.dataset.ridx)]);
}

// License detail flyout: reuses the shared #flyout; surfaces fields the table
// omits (connection label, raw state, start date) plus a utilization bar.
function openLicenseFlyout(p) {
    if (!p) return;
    const util = p.utilization_rate || 0;
    const status = p.status || '';
    showFlyout(`
        <button class="flyout-close" aria-label="닫기">&times;</button>
        <h2>${escapeHtml(p.project_id)}</h2>
        <div class="flyout-badges">
            <span class="state-badge lic-${escapeHtml(status.toLowerCase())}">${escapeHtml(status) || '—'}</span>
            <span class="badge">${escapeHtml(licTier(p.subscription_tier))}</span>
        </div>
        <p class="fly-desc">배정 ${(p.assigned_count || 0).toLocaleString()} / 총 ${(p.allocated_seats || 0).toLocaleString()} · 사용률 ${util}%</p>
        <div class="bar-row">
            <span class="bar-label">사용률</span>
            <span class="bar-track"><span class="bar-fill" style="width:${Math.min(100, Math.round(util))}%"></span></span>
            <span class="bar-count">${util}%</span>
        </div>
        <ul class="meta-list">
            <li><span class="k">Project</span><span class="v">${escapeHtml(p.project_id)}</span></li>
            <li><span class="k">Config</span><span class="v">${escapeHtml(p.license_config_id) || '—'}</span></li>
            <li><span class="k">연결</span><span class="v">${escapeHtml(p.label) || '—'}</span></li>
            <li><span class="k">Tier</span><span class="v">${escapeHtml(licTier(p.subscription_tier))}</span></li>
            <li><span class="k">State</span><span class="v">${escapeHtml(p.state) || '—'}</span></li>
            <li><span class="k">Status</span><span class="v">${escapeHtml(status) || '—'}</span></li>
            <li><span class="k">총 좌석</span><span class="v">${(p.allocated_seats || 0).toLocaleString()}</span></li>
            <li><span class="k">배정</span><span class="v">${(p.assigned_count || 0).toLocaleString()}</span></li>
            <li><span class="k">잔여</span><span class="v">${(p.available_count || 0).toLocaleString()}</span></li>
            <li><span class="k">사용률</span><span class="v">${util}%</span></li>
            <li><span class="k">시작일</span><span class="v">${escapeHtml(p.start_date) || '—'}</span></li>
            <li><span class="k">종료일</span><span class="v">${escapeHtml(p.end_date) || '—'}</span></li>
        </ul>`);
}

async function onLicRefresh() {
    const btn = document.getElementById('lic-refresh');
    btn.disabled = true;
    btn.classList.add('loading');
    try { await loadLicenses(); } catch (e) { /* keep current data on failure */ }
    renderLicenses();
}

const LIC_EXPORT_COLS = ['project_id', 'license_config_id', 'subscription_tier', 'state',
    'allocated_seats', 'assigned_count', 'available_count', 'utilization_rate', 'status', 'start_date', 'end_date'];

function exportLicensesCSV() {
    const rows = licFiltered().map(p => LIC_EXPORT_COLS.map(k => csvCell(p[k])).join(','));
    download([LIC_EXPORT_COLS.join(','), ...rows].join('\r\n'), 'licenses.csv', 'text/csv');
}

/* ---------- usage view: Antigravity inference telemetry ---------- */
// Compact numbers for tiles/bars/chart-axis; the table keeps exact toLocaleString values.
function fmtNum(n) {
    n = n || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(n);
}

// distinct color per stacked project series (cycles if projects > palette)
const USAGE_COLORS = ['#4F46E5', '#0EA5E9', '#22C55E', '#F59E0B', '#EF4444', '#A855F7', '#14B8A6', '#EC4899'];

function agUser(u) { return (u || '').replace(/^user:/, '') || '—'; }

async function loadUsage() {
    const res = await fetch('/api/antigravity/metrics?days=' + usageState.days);
    usageState.data = await res.json();
}

async function renderUsage() {
    const root = document.getElementById('view-root');
    if (!usageState.data) {
        root.innerHTML = `<div class="loading">사용량을 불러오는 중…</div>`;
        try { await loadUsage(); }
        catch (error) {
            root.innerHTML = `<div class="loading">사용량을 불러오지 못했습니다: ${escapeHtml(error.message)}</div>`;
            return;
        }
    }
    const projectIds = usageState.data.projects.map(p => p.project_id).sort();
    if (usageState.project && !projectIds.includes(usageState.project)) usageState.project = '';  // stale selection
    root.innerHTML = `
        <div class="view-header view-header--row">
            <div>
                <h1>Usage</h1>
                <p>등록된 프로젝트의 Antigravity 추론·토큰 사용량입니다.</p>
            </div>
            <div class="header-actions">
                <button id="ag-refresh" class="hbtn" aria-label="새로고침"><i class="fas fa-rotate-right"></i></button>
                <button id="ag-csv" class="hbtn" aria-label="CSV로 내보내기">CSV</button>
            </div>
        </div>
        ${usageMessageHTML()}
        ${usageHealthHTML()}
        <div id="ag-tiles"></div>
        <div class="filter-bar">
            <select id="ag-project" class="filter-select" aria-label="프로젝트 필터">
                <option value="">전체 (통합)</option>${opts(projectIds)}
            </select>
            <select id="ag-range" class="filter-select" aria-label="기간">
                <option value="7">최근 7일</option>
                <option value="30">최근 30일</option>
                <option value="90">최근 90일</option>
            </select>
            <select id="ag-metric" class="filter-select" aria-label="지표">
                <option value="tokens">토큰</option>
                <option value="inferences">추론</option>
            </select>
            <input id="ag-search" class="search-input" type="search" placeholder="사용자·프로젝트 검색" aria-label="사용자 검색">
        </div>
        <div class="chart-card">
            <h3>일별 추세</h3>
            <div class="chart-wrap"><canvas id="ag-chart"></canvas></div>
        </div>
        <div class="breakdown"><h3>프로젝트별 토큰 사용량</h3><div id="ag-bars"></div></div>
        <div class="result-count" id="ag-count"></div>
        <div id="ag-table"></div>`;

    const proj = root.querySelector('#ag-project');
    const rng = root.querySelector('#ag-range');
    const met = root.querySelector('#ag-metric');
    const srch = root.querySelector('#ag-search');
    proj.value = usageState.project; rng.value = String(usageState.days);
    met.value = usageState.metric; srch.value = usageState.q;
    proj.addEventListener('change', () => { usageState.project = proj.value; updateUsageView(); });
    rng.addEventListener('change', () => { usageState.days = Number(rng.value); onUsageRefresh(); });
    met.addEventListener('change', () => { usageState.metric = met.value; updateUsageView(); });
    srch.addEventListener('input', () => { usageState.q = srch.value; updateUsageTable(); });
    root.querySelector('#ag-refresh').addEventListener('click', onUsageRefresh);
    root.querySelector('#ag-csv').addEventListener('click', exportUsageCSV);
    const tableEl = root.querySelector('#ag-table');
    tableEl.addEventListener('click', onUsageTableClick);
    tableEl.addEventListener('keydown', keyActivate(onUsageTableClick));

    updateUsageView();
}

// message is an info banner (not-configured / no-logs); errors surface via usageHealthHTML.
function usageMessageHTML() {
    const m = usageState.data.message;
    return m ? `<div class="result-count">${escapeHtml(m)}</div>` : '';
}

function usageHealthHTML() {
    const probs = (usageState.data.providers || []).filter(p => p.status !== 'ok');
    if (!probs.length) return '';
    return `<div class="provider-health">${probs.map(p =>
        `<span class="health-error">⚠ ${escapeHtml(p.label || p.name)} 사용량 조회 실패: ${escapeHtml(p.error || '')}</span>`
    ).join('')}</div>`;
}

// project rows in scope (전체=all / 선택=one); drives bars + chart series.
function usageScopeProjects() {
    const all = usageState.data.projects;
    return usageState.project ? all.filter(p => p.project_id === usageState.project) : all;
}

// KPI scope: 전체 uses the backend summary (distinct active_users can't be re-derived
// client-side across projects); a selected project uses that project's aggregate row.
function usageSummary() {
    if (!usageState.project) {
        const s = usageState.data.summary;
        return { inferences: s.total_inferences, tokens: s.total_tokens,
                 users: s.active_users, projects: s.monitored_projects };
    }
    const p = usageState.data.projects.find(x => x.project_id === usageState.project);
    return p ? { inferences: p.total_requests, tokens: p.total_tokens, users: p.active_users, projects: 1 }
             : { inferences: 0, tokens: 0, users: 0, projects: 0 };
}

function usageBarsHTML(rows = usageScopeProjects()) {
    const total = rows.reduce((a, p) => a + (p.total_tokens || 0), 0);
    if (!rows.length || total <= 0) return '';
    return rows.slice().sort((a, b) => b.total_tokens - a.total_tokens).map(p => {
        const pct = Math.round(p.total_tokens / total * 100);
        return `<div class="bar-row">
            <span class="bar-label" title="${escapeHtml(p.project_id)}">${escapeHtml(p.project_id)}</span>
            <span class="bar-track"><span class="bar-fill" style="width:${Math.min(100, pct)}%"></span></span>
            <span class="bar-count">${pct}%</span>
        </div>`;
    }).join('');
}

// Stacked daily trend: tokens as area, inferences as bars; one series per project in scope.
function renderUsageChart() {
    const canvas = document.getElementById('ag-chart');
    if (!canvas || typeof Chart === 'undefined') return;  // CDN unreachable → skip chart, rest works
    if (usageChart) { usageChart.destroy(); usageChart = null; }
    const daily = usageState.data.daily || [];
    const labels = daily.map(d => d.date);
    const isTokens = usageState.metric === 'tokens';
    const key = isTokens ? 'tokens' : 'requests';
    const pids = usageScopeProjects().map(p => p.project_id);
    const datasets = (pids.length ? pids : ['(전체)']).map((pid, i) => {
        const color = USAGE_COLORS[i % USAGE_COLORS.length];
        const data = pids.length
            ? daily.map(d => (d.breakdown[pid] || {})[key] || 0)
            : daily.map(d => d[key] || 0);
        return {
            label: pid, data, stack: 'usage',
            backgroundColor: isTokens ? color + '55' : color,
            borderColor: color, borderWidth: isTokens ? 2 : 0,
            fill: isTokens, tension: 0.3, pointRadius: 0,
        };
    });
    usageChart = new Chart(canvas, {
        type: isTokens ? 'line' : 'bar',
        data: { labels, datasets },
        options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            scales: {
                x: { stacked: true, grid: { display: false } },
                y: { stacked: true, beginAtZero: true, ticks: { callback: v => isTokens ? fmtNum(v) : v } },
            },
            plugins: { legend: { display: datasets.length > 1 } },
        },
    });
}

function updateUsageView() {
    const s = usageSummary();
    document.getElementById('ag-tiles').innerHTML = kpiHTML([
        ['총 추론', s.inferences.toLocaleString()],
        ['총 토큰', fmtNum(s.tokens)],
        ['활성 사용자', s.users.toLocaleString()],
        ['모니터링 프로젝트', s.projects.toLocaleString()],
    ]);
    document.getElementById('ag-bars').innerHTML =
        usageBarsHTML() || `<div class="result-count">표시할 사용량이 없습니다.</div>`;
    renderUsageChart();
    updateUsageTable();
}

// Top users, scoped by project + text-filtered + sorted (numeric-aware, mirrors licFiltered).
function usageFilteredUsers() {
    let rows = usageState.data.top_users || [];
    if (usageState.project) rows = rows.filter(u => u.project_id === usageState.project);
    const q = usageState.q.trim().toLowerCase();
    if (q) rows = rows.filter(u =>
        (u.user_id || '').toLowerCase().includes(q) ||
        (u.project_id || '').toLowerCase().includes(q));
    const k = usageState.sortKey, dir = usageState.sortDir === 'asc' ? 1 : -1;
    return rows.slice().sort((a, b) => {
        const va = a[k], vb = b[k];
        if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
        return String(va ?? '').localeCompare(String(vb ?? ''), undefined, { numeric: true }) * dir;
    });
}

function updateUsageTable() {
    const rows = usageFilteredUsers();
    document.getElementById('ag-count').textContent = `${rows.length}명 사용자`;
    document.getElementById('ag-table').innerHTML = usageTableHTML(rows);
}

const AG_TABLE_COLS = [
    { k: 'user_id', label: 'User' },
    { k: 'project_id', label: 'Project' },
    { k: 'total_requests', label: 'Inferences' },
    { k: 'total_tokens', label: 'Tokens' },
    { k: 'primary_model', label: 'Model' },
    { k: 'last_active', label: 'Last active' },
];

function usageTableHTML(rows) {
    if (!rows.length) return `<div class="loading">조건에 맞는 사용자가 없습니다.</div>`;
    const head = AG_TABLE_COLS.map(col =>
        `<th data-sort="${col.k}" role="button" tabindex="0" aria-sort="${usageState.sortKey === col.k ? (usageState.sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}">${col.label} <span class="sort-ind">${usageState.sortKey === col.k ? (usageState.sortDir === 'asc' ? '▲' : '▼') : ''}</span></th>`).join('');
    const body = rows.map(u => `<tr>
        <td class="name-cell">${escapeHtml(agUser(u.user_id))}</td>
        <td>${escapeHtml(u.project_id)}</td>
        <td>${(u.total_requests || 0).toLocaleString()}</td>
        <td>${(u.total_tokens || 0).toLocaleString()}</td>
        <td>${escapeHtml(u.primary_model || '—')}</td>
        <td>${escapeHtml((u.last_active || '').slice(0, 16) || '—')}</td>
    </tr>`).join('');
    return `<table class="agent-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function onUsageTableClick(e) {
    const th = e.target.closest('th[data-sort]');
    if (!th) return;
    const k = th.dataset.sort;
    if (usageState.sortKey === k) usageState.sortDir = usageState.sortDir === 'asc' ? 'desc' : 'asc';
    else { usageState.sortKey = k; usageState.sortDir = 'asc'; }
    updateUsageTable();
}

async function onUsageRefresh() {
    const btn = document.getElementById('ag-refresh');
    if (btn) { btn.disabled = true; btn.classList.add('loading'); }
    try { await loadUsage(); } catch (e) { /* keep current data on failure */ }
    renderUsage();
}

const AG_EXPORT_COLS = ['user_id', 'project_id', 'total_requests', 'total_tokens', 'primary_model', 'last_active'];

function exportUsageCSV() {
    const rows = usageFilteredUsers().map(u => AG_EXPORT_COLS.map(k => csvCell(u[k])).join(','));
    download([AG_EXPORT_COLS.join(','), ...rows].join('\r\n'), 'antigravity-usage.csv', 'text/csv');
}

/* ---------- sources view: connection manager ---------- */
// A "connection" is what's configured; the health table below is the last fetch result.
function onboardBanner() {
    return `<a class="onboard-banner" href="#/sources">
        <i class="fas fa-plug"></i>
        <span>아직 연결된 소스가 없습니다. Sources에서 첫 연결을 추가하세요.</span>
    </a>`;
}

async function loadConnections() {
    const res = await fetch('/api/connections');
    const data = await res.json();
    connections = data.connections || [];
}

async function renderSources() {
    const root = document.getElementById('view-root');
    root.innerHTML = `<div class="loading">연결을 불러오는 중…</div>`;
    try {
        await loadConnections();
    } catch (error) {
        root.innerHTML = `<div class="loading">연결을 불러오지 못했습니다: ${escapeHtml(error.message)}</div>`;
        return;
    }
    const editing = editingId ? connections.find(c => c.id === editingId) : null;
    if (editingId && !editing) editingId = null;  // id went stale (e.g. deleted elsewhere)
    root.innerHTML = `
        <div class="view-header">
            <h1>Sources</h1>
            <p>소스 연결을 관리합니다. 연결은 설정값이고, 상태 표는 마지막 조회 결과입니다.</p>
        </div>
        ${connections.length ? connectionsHTML() : onboardingHTML()}
        ${addFormHTML(editing)}
        ${healthTableHTML()}`;

    const list = root.querySelector('#conn-list');
    if (list) list.addEventListener('click', onConnListClick);
    root.querySelector('#add-conn-form').addEventListener('submit', onAddConnection);
    root.querySelector('#test-conn-btn').addEventListener('click', onTestConnection);
    root.querySelector('#conn-provider').addEventListener('change', () => syncProviderFields(root));
    syncProviderFields(root);  // show only the selected provider's fields
    const cancel = root.querySelector('#cancel-edit-btn');
    if (cancel) cancel.addEventListener('click', () => { editingId = null; renderSources(); });
}

const PROVIDER_LABEL = { gemini: 'Gemini Enterprise', vertex: 'Vertex Agent Engine' };

function connProvider(c) { return c.provider || 'gemini'; }

function connConfig(c) {
    return connProvider(c) === 'vertex'
        ? `region: ${escapeHtml(c.region) || '—'}`
        : `app: ${escapeHtml(c.app_id) || '—'}${c.cid ? ` · cid: ${escapeHtml(c.cid)}` : ''}`;
}

function connectionsHTML() {
    const rows = connections.map(c => {
        const prov = connProvider(c);
        const provLabel = PROVIDER_LABEL[prov] || prov;
        return `
        <tr>
            <td class="name-cell">${escapeHtml(c.label) || provLabel}</td>
            <td>${escapeHtml(provLabel)}</td>
            <td>${escapeHtml(c.project_id)}</td>
            <td>${connConfig(c)}</td>
            <td>
                <button type="button" class="hbtn conn-edit" data-id="${escapeHtml(c.id)}" aria-label="연결 수정">수정</button>
                <button type="button" class="hbtn conn-delete" data-id="${escapeHtml(c.id)}" aria-label="연결 삭제">삭제</button>
            </td>
        </tr>`;
    }).join('');
    return `
        <h3 class="section-title">연결 (${connections.length})</h3>
        <table class="agent-table" id="conn-list">
            <thead><tr><th>Label</th><th>Provider</th><th>Project</th><th>Config</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
        </table>`;
}

function onboardingHTML() {
    return `
        <div class="onboard-card">
            <div class="onboard-icon"><i class="fas fa-plug"></i></div>
            <h2>첫 연결을 추가하세요</h2>
            <p>아직 연결된 소스가 없습니다. 아래 양식에서 Provider를 고르고 소스 정보를 입력해 첫 연결을 만드세요.</p>
        </div>`;
}

function addFormHTML(editing) {
    const prov = editing ? (editing.provider || 'gemini') : 'gemini';
    const v = k => editing ? (editing[k] || '') : '';
    // group ties a field to one provider so syncProviderFields() can hide the rest
    const f = (name, label, req, group) => `
        <label class="field${group ? ' prov-field' : ''}"${group ? ` data-prov="${group}"` : ''}>
            <span>${label}${req ? ' <span class="req">*</span>' : ''}</span>
            <input name="${name}" value="${escapeHtml(v(name))}" aria-label="${escapeHtml(label)}">
        </label>`;
    return `
        <form id="add-conn-form" class="conn-form" novalidate>
            <h3 class="section-title">${editing ? '연결 수정' : '연결 추가'}</h3>
            <div class="conn-fields">
                <label class="field">
                    <span>Provider</span>
                    <select name="provider" id="conn-provider" aria-label="Provider">
                        <option value="gemini"${prov === 'gemini' ? ' selected' : ''}>Gemini Enterprise</option>
                        <option value="vertex"${prov === 'vertex' ? ' selected' : ''}>Vertex Agent Engine</option>
                    </select>
                </label>
                ${f('project_id', 'Project ID', true)}
                ${f('app_id', 'App ID', true, 'gemini')}
                ${f('cid', 'CID', false, 'gemini')}
                ${f('region', 'Region', true, 'vertex')}
                ${f('label', 'Label', false)}
            </div>
            <div class="conn-actions">
                <button type="submit" class="hbtn hbtn-primary">${editing ? '저장' : '연결 추가'}</button>
                <button type="button" id="test-conn-btn" class="hbtn">연결 테스트</button>
                ${editing ? '<button type="button" id="cancel-edit-btn" class="hbtn">취소</button>' : ''}
            </div>
            <div id="conn-msg" class="conn-msg" role="status" aria-live="polite"></div>
        </form>`;
}

// Show only the selected provider's fields; build the request body to match.
function syncProviderFields(root) {
    const sel = root.querySelector('#conn-provider');
    if (!sel) return;
    root.querySelectorAll('.prov-field').forEach(el => { el.hidden = el.dataset.prov !== sel.value; });
}

function connFormBody(form) {
    const provider = form.provider.value;
    const body = { provider, project_id: form.project_id.value.trim(), label: form.label.value.trim() };
    if (provider === 'vertex') {
        body.region = form.region.value.trim();
    } else {
        body.app_id = form.app_id.value.trim();
        body.cid = form.cid.value.trim();
    }
    return body;
}

function healthTableHTML() {
    const rows = providersHealth.map(p => {
        const vpc = p.error_type === 'vpc_sc';
        const status = p.status === 'ok'
            ? `<span class="status-ok">정상</span>`
            : vpc ? `<span class="status-vpcsc">VPC-SC 대기</span>`
                  : `<span class="status-error">오류</span>`;
        return `
        <tr>
            <td class="name-cell">${escapeHtml(p.label || p.name)}</td>
            <td>${status}</td>
            <td>${p.count ?? 0}</td>
            <td>${escapeHtml((vpc ? p.hint : p.error) || '—')}</td>
        </tr>`;
    }).join('');
    return `
        <h3 class="section-title">상태</h3>
        <table class="agent-table">
            <thead><tr><th>Provider</th><th>Status</th><th>Agents</th><th>Error</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="4">등록된 프로바이더가 없습니다.</td></tr>'}</tbody>
        </table>`;
}

function showConnMsg(kind, html) {
    const el = document.getElementById('conn-msg');
    if (!el) return;
    el.className = 'conn-msg conn-msg--' + kind;
    el.innerHTML = html;
}

async function onConnListClick(e) {
    const edit = e.target.closest('.conn-edit');
    if (edit) {
        editingId = edit.dataset.id;
        await renderSources();  // re-renders the shared form in edit mode, prefilled
        const form = document.getElementById('add-conn-form');
        if (form) form.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
    }
    const btn = e.target.closest('.conn-delete');
    if (!btn) return;
    btn.disabled = true;
    try {
        const res = await fetch('/api/connections/' + encodeURIComponent(btn.dataset.id), { method: 'DELETE' });
        if (!res.ok) throw new Error('연결을 삭제하지 못했습니다.');
        await renderSources();
    } catch (error) {
        btn.disabled = false;
        showConnMsg('error', escapeHtml(error.message));
    }
}

async function onAddConnection(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const body = connFormBody(form);
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    const url = editingId ? '/api/connections/' + encodeURIComponent(editingId) : '/api/connections';
    const method = editingId ? 'PUT' : 'POST';
    try {
        const res = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            showConnMsg('error', escapeHtml(data.detail || data.error || '연결을 저장하지 못했습니다.'));
            submit.disabled = false;
            return;
        }
        editingId = null;
        await renderSources();  // full re-render clears the form and shows the saved row
    } catch (error) {
        showConnMsg('error', escapeHtml(error.message));
        submit.disabled = false;
    }
}

async function onTestConnection() {
    const form = document.getElementById('add-conn-form');
    const btn = document.getElementById('test-conn-btn');
    const body = connFormBody(form);
    const missing = body.provider === 'vertex'
        ? (!body.project_id || !body.region)
        : (!body.project_id || !body.app_id);
    if (missing) {
        showConnMsg('error', body.provider === 'vertex'
            ? 'Project ID와 Region을 입력하세요.'
            : 'Project ID와 App ID를 입력하세요.');
        return;
    }
    const prev = btn.textContent;
    btn.disabled = true;
    btn.textContent = '테스트 중…';
    try {
        const res = await fetch('/api/connections/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await res.json();
        if (data.ok) {
            showConnMsg('ok', `연결 성공 — 에이전트 ${data.agent_count}개`);
        } else {
            let msg = escapeHtml(data.error || '연결 실패');
            if (data.hint) msg += `<div class="conn-hint">${escapeHtml(data.hint)}</div>`;
            showConnMsg('error', msg);
        }
    } catch (error) {
        showConnMsg('error', escapeHtml(error.message));
    } finally {
        btn.disabled = false;
        btn.textContent = prev;
    }
}
