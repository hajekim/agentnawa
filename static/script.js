document.addEventListener('DOMContentLoaded', async () => {
    const grid = document.getElementById('agent-grid');
    let likesData = {};

    // Helper to classify category
    function classifyCategory(description, displayName) {
        const text = (description + ' ' + displayName).toLowerCase();
        if (text.includes('research') || text.includes('analyze') || text.includes('feedback')) {
            return 'RESEARCH';
        } else if (text.includes('generate') || text.includes('marcom') || text.includes('marketing') || text.includes('concept')) {
            return 'CREATIVE';
        } else if (text.includes('data') || text.includes('code') || text.includes('excel')) {
            return 'DEVOPS';
        }
        return 'GENERAL';
    }

    // Custom icon selector
    function getIcon(category) {
        switch (category) {
            case 'RESEARCH': return '<i class="fas fa-search"></i>';
            case 'CREATIVE': return '<i class="fas fa-pen-nib"></i>';
            case 'DEVOPS': return '<i class="fas fa-code"></i>';
            default: return '<i class="fas fa-robot"></i>';
        }
    }

    // Fetch data
    try {
        const configRes = await fetch('/api/config');
        const config = await configRes.json();
        const app_id = config.cid;

        const [agentsRes, likesRes] = await Promise.all([
            fetch('/api/agents'),
            fetch(`/api/likes?app_id=${encodeURIComponent(app_id)}`)
        ]);

        const agentsData = await agentsRes.json();
        likesData = await likesRes.json();

        // Filter agents that have lowCodeAgentDefinition
        const filteredAgents = agentsData.agents.filter(agent => agent.lowCodeAgentDefinition && agent.state === 'ENABLED');

        // Sort by likes in descending order
        filteredAgents.sort((a, b) => {
            const likesA = likesData[a.name] || 0;
            const likesB = likesData[b.name] || 0;
            return likesB - likesA;
        });

        renderGrid(filteredAgents, app_id);
    } catch (error) {
        grid.innerHTML = `<div class="loading">Error loading data: ${error.message}</div>`;
    }

    function renderGrid(agents, app_id) {
        grid.innerHTML = '';

        if (!agents || agents.length === 0) {
            grid.innerHTML = '<div class="loading">No agents found.</div>';
            return;
        }

        agents.forEach(agent => {
            const category = classifyCategory(agent.description || '', agent.displayName || '');
            const categoryClass = category.toLowerCase();
            const icon = getIcon(category);
            const likesCount = likesData[agent.name] || 0;

            const agentId = agent.name;

            const card = document.createElement('div');
            card.className = 'card';
            card.innerHTML = `
                <div class="card-header">
                    <div class="icon-wrapper">
                        ${icon}
                    </div>
                    <span class="badge badge-${categoryClass}">${category}</span>
                </div>
                <div class="card-body">
                    <h2 title="${agent.displayName || ''}">${agent.displayName || 'Unnamed Agent'}</h2>
                    <p>${agent.description || 'No description available.'}</p>
                </div>
                <div class="card-footer">
                    <div class="footer-left">
                        <span>Created: ${new Date(agent.createTime).toLocaleDateString()}</span><br/>
                        <span>State: ${agent.state === 'ENABLED' ? `<span class="state-enabled">ENABLED</span>` : agent.state}</span>
                    </div>
                    <div class="footer-right">
                        <button class="action-btn like-btn" data-id="${agentId}">
                            <i class="fas fa-heart"></i> <span class="like-count">${likesCount}</span>
                        </button>
                        <button class="action-btn preview-btn" data-name="${agent.name}">
                            <i class="fas fa-eye"></i>
                        </button>
                    </div>
                </div>
            `;
            grid.appendChild(card);
        });

        // Add event listeners for like buttons
        document.querySelectorAll('.like-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const id = btn.getAttribute('data-id');
                try {
                    const res = await fetch(`/api/like?agent_id=${encodeURIComponent(id)}&app_id=${encodeURIComponent(app_id)}`, {
                        method: 'POST'
                    });

                    if (res.ok) {
                        const countSpan = btn.querySelector('.like-count');
                        countSpan.textContent = parseInt(countSpan.textContent) + 1;
                        btn.classList.add('liked');
                        btn.disabled = true;
                    } else {
                        const err = await res.json();
                        alert(err.detail || 'Failed to like');
                    }
                } catch (error) {
                    console.error('Error liking agent:', error);
                }
            });
        });

        // Add event listeners for preview buttons
        document.querySelectorAll('.preview-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const name = btn.getAttribute('data-name');
                const id = name.split('/').pop();
                const url = `https://vertexaisearch.cloud.google.com/home/cid/${app_id}/r/agent/${id}/session/-`;
                window.open(url, '_blank', 'width=800,height=850');
            });
        });
    }
});
