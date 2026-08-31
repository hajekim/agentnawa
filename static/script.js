document.addEventListener('DOMContentLoaded', async () => {
    const grid = document.getElementById('agent-grid');
    const searchInput = document.getElementById('search');
    const healthBar = document.getElementById('provider-health');
    let allAgents = [];

    // Icon per normalized agent type
    function getIcon(type) {
        switch (type) {
            case 'High Code': return '<i class="fas fa-code"></i>';
            case 'Low/No Code': return '<i class="fas fa-pen-nib"></i>';
            case 'A2A': return '<i class="fas fa-network-wired"></i>';
            case 'Workflow': return '<i class="fas fa-diagram-project"></i>';
            case 'Skill': return '<i class="fas fa-screwdriver-wrench"></i>';
            case 'Managed': return '<i class="fas fa-shield-halved"></i>';
            default: return '<i class="fas fa-robot"></i>';
        }
    }

    // Normalize a type label into a CSS-safe class suffix
    function typeClass(type) {
        return type.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    }

    function escapeHtml(s) {
        return (s || '').replace(/[&<>"']/g, c => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
        ));
    }

    try {
        const res = await fetch('/api/agents');
        const data = await res.json();
        allAgents = data.agents || [];
        renderHealth(data.providers || []);
        renderGrid(allAgents);
    } catch (error) {
        grid.innerHTML = `<div class="loading">Error loading data: ${escapeHtml(error.message)}</div>`;
    }

    searchInput.addEventListener('input', () => {
        const q = searchInput.value.trim().toLowerCase();
        renderGrid(allAgents.filter(a =>
            (a.display_name || '').toLowerCase().includes(q) ||
            (a.description || '').toLowerCase().includes(q) ||
            (a.type || '').toLowerCase().includes(q)
        ));
    });

    function renderHealth(providers) {
        const problems = providers.filter(p => p.status !== 'ok');
        if (problems.length === 0) { healthBar.innerHTML = ''; return; }
        healthBar.innerHTML = problems.map(p =>
            `<span class="health-error">⚠ ${escapeHtml(p.name)} 사용 불가: ${escapeHtml(p.error || '')}</span>`
        ).join('');
    }

    function renderGrid(agents) {
        grid.innerHTML = '';

        if (!agents || agents.length === 0) {
            grid.innerHTML = '<div class="loading">No agents found.</div>';
            return;
        }

        agents.forEach(agent => {
            const type = agent.type || 'Unknown';
            const icon = getIcon(type);
            const created = agent.created_at ? new Date(agent.created_at).toLocaleDateString() : '—';

            const card = document.createElement('div');
            card.className = 'card';
            card.innerHTML = `
                <div class="card-header">
                    <div class="icon-wrapper">${icon}</div>
                    <span class="badge badge-${typeClass(type)}">${escapeHtml(type)}</span>
                </div>
                <div class="card-body">
                    <h2 title="${escapeHtml(agent.display_name)}">${escapeHtml(agent.display_name) || 'Unnamed Agent'}</h2>
                    <p>${escapeHtml(agent.description) || 'No description available.'}</p>
                </div>
                <div class="card-footer">
                    <div class="footer-left">
                        <span>Source: ${escapeHtml(agent.provider)}</span><br/>
                        <span>Created: ${created}</span>
                    </div>
                    <div class="footer-right">
                        ${agent.open_url
                            ? `<a class="action-btn open-btn" href="${escapeHtml(agent.open_url)}" target="_blank" rel="noopener"><i class="fas fa-up-right-from-square"></i> 열기</a>`
                            : `<span class="action-btn disabled" title="이 타입은 열기 링크가 없습니다"><i class="fas fa-ban"></i></span>`}
                    </div>
                </div>
            `;
            grid.appendChild(card);
        });
    }
});
