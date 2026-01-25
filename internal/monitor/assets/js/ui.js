export class UI {
    static formatLatency(ms) {
        if (ms < 0) return `<span class="text-secondary">-</span>`;
        if (ms < 100) return `<span style="color: var(--success)">${ms}</span>`;
        if (ms < 400) return `<span style="color: var(--warning)">${ms}</span>`;
        return `<span style="color: var(--error)">${ms}</span>`;
    }

    static getStatusClass(node) {
        if (!node.available) return 'error';
        if (node.last_latency_ms > 400) return 'warning';
        return 'healthy';
    }

    static renderNodeCard(node) {
        const statusClass = this.getStatusClass(node);
        const latency = node.last_latency_ms >= 0 ? node.last_latency_ms : '-';

        return `
            <div class="node-card ${statusClass}" data-tag="${node.tag}">
                <div class="node-header">
                    <div>
                        <div class="node-name" title="${node.name}">${node.name}</div>
                        <div class="node-tag">${node.tag}</div>
                    </div>
                    <div class="latency-badge">
                        ${this.formatLatency(node.last_latency_ms)}<span class="ms">ms</span>
                    </div>
                </div>
                
                <div class="node-metrics">
                   <!-- Add sparkleline or mini details here later -->
                </div>

                <div class="node-actions">
                    <button class="btn btn-secondary btn-xs btn-probe" data-tag="${node.tag}">
                        探测
                    </button>
                    <button class="btn btn-secondary btn-xs btn-check-ip" data-tag="${node.tag}">
                        查IP
                    </button>
                    <!-- Extra actions placeholder -->
                </div>
                <div class="ip-result-container" id="ip-result-${node.tag}" style="margin-top: 0.5rem; display: none;"></div>
            </div>
        `;
    }

    static renderStats(nodes) {
        const total = nodes.length;
        const available = nodes.filter(n => n.available).length;
        const failed = total - available;
        const avgLatency = available > 0
            ? Math.round(nodes.filter(n => n.available).reduce((a, b) => a + b.last_latency_ms, 0) / available)
            : 0;

        return `
            <div class="stat-card">
                <div class="stat-label">总节点数</div>
                <div class="stat-value">${total}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">可用节点</div>
                <div class="stat-value" style="color: var(--success)">${available}</div>
            </div>
             <div class="stat-card">
                <div class="stat-label">失效节点</div>
                <div class="stat-value" style="color: var(--error)">${failed}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">平均延迟</div>
                <div class="stat-value">${avgLatency}<span style="font-size: 1rem; color: var(--text-secondary)">ms</span></div>
            </div>
        `;
    }

    static showToast(message, type = 'info') {
        const container = document.getElementById('toast-container');
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerHTML = `
            <span>${message}</span>
        `;
        container.appendChild(toast);

        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(-20px)';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }
}
