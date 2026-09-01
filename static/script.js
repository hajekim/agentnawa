let allAgents = [];
let providersHealth = [];
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

async function loadAgents() {
    const res = await fetch('/api/agents');
    const data = await res.json();
    allAgents = data.agents || [];
    providersHealth = data.providers || [];
}

document.addEventListener('DOMContentLoaded', async () => {
    bindFlyoutClose();
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
    const hash = (location.hash || '#/agents').replace('#/', '');
    state.view = ['overview', 'agents', 'sources'].includes(hash) ? hash : 'agents';
    document.querySelectorAll('.nav-item').forEach(el => {
        const active = el.dataset.view === state.view;
        el.classList.toggle('active', active);
        if (active) el.setAttribute('aria-current', 'page');
        else el.removeAttribute('aria-current');
    });
    if (state.view === 'overview') renderOverview();
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

function openFlyout(id) {
    const a = allAgents.find(x => x.id === id);
    if (!a) return;
    flyoutTrigger = document.activeElement;  // restore focus here on close
    const url = safeUrl(a.open_url);
    const type = a.type || 'Unknown';
    const st = a.state || 'UNKNOWN';
    const fly = document.getElementById('flyout');
    fly.innerHTML = `
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
            : `<span class="open-primary disabled"><i class="fas fa-ban"></i> 열기 링크 없음</span>`}`;
    fly.querySelector('.flyout-close').addEventListener('click', closeFlyout);
    document.getElementById('flyout-backdrop').hidden = false;
    fly.hidden = false;
    fly.setAttribute('aria-hidden', 'false');
    fly.querySelector('.flyout-close').focus();
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
        <div class="breakdown">
            <h3>타입별 분포${state.ovState ? ` · <span class="bk-filter">${escapeHtml(state.ovState)}</span>` : ''}</h3>
            ${barsHTML(byType)}
        </div>`;
    const grid = root.querySelector('.dash-grid');
    grid.addEventListener('click', onOverviewTile);
    grid.addEventListener('keydown', keyActivate(onOverviewTile));
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

function healthHTML() {
    const problems = providersHealth.filter(p => p.status !== 'ok');
    if (!problems.length) return '';
    return `<div class="provider-health">${problems.map(p =>
        `<span class="health-error">⚠ ${escapeHtml(p.label || p.name)} 사용 불가: ${escapeHtml(p.error || '')}</span>`
    ).join('')}</div>`;
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
    const rows = providersHealth.map(p => `
        <tr>
            <td class="name-cell">${escapeHtml(p.label || p.name)}</td>
            <td><span class="status-${p.status === 'ok' ? 'ok' : 'error'}">${p.status === 'ok' ? '정상' : '오류'}</span></td>
            <td>${p.count ?? 0}</td>
            <td>${escapeHtml(p.error || '—')}</td>
        </tr>`).join('');
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
