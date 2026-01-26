export class UI {
    static formatLatency(ms) {
        if (ms < 0) return `<span class="text-secondary">-</span>`;
        if (ms < 100) return `<span style="color: var(--success)">${ms}</span>`;
        if (ms < 400) return `<span style="color: var(--warning)">${ms}</span>`;
        return `<span style="color: var(--error)">${ms}</span>`;
    }

    // Convert country code to flag emoji
    static countryFlag(countryCode) {
        if (!countryCode || countryCode.length !== 2) return '🌍';
        const offset = 127397;
        const firstChar = countryCode.toUpperCase().charCodeAt(0);
        const secondChar = countryCode.toUpperCase().charCodeAt(1);
        return String.fromCodePoint(firstChar + offset) + String.fromCodePoint(secondChar + offset);
    }

    static getStatusClass(node) {
        if (!node.available) return 'error';
        if (node.last_latency_ms > 400) return 'warning';
        return 'healthy';
    }

    // Render mini sparkline chart for latency history
    static renderSparkline(timeline) {
        if (!timeline || timeline.length < 2) {
            return '<div class="sparkline-placeholder">-</div>';
        }

        // Take last 10 entries
        const data = timeline.slice(-10);
        const maxLatency = Math.max(...data.map(e => e.latency_ms || 0), 100);
        const width = 80;
        const height = 24;

        const points = data.map((e, i) => {
            const x = (i / (data.length - 1)) * width;
            const y = height - ((e.latency_ms || 0) / maxLatency) * (height - 4);
            return `${x.toFixed(1)},${y.toFixed(1)}`;
        }).join(' ');

        // Color based on latest latency
        const latestMs = data[data.length - 1]?.latency_ms || 0;
        const color = latestMs < 100 ? 'var(--success)' : latestMs < 400 ? 'var(--warning)' : 'var(--error)';

        return `
            <svg width="${width}" height="${height}" class="sparkline">
                <polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
        `;
    }

    // Calculate health score (0-100)
    static getHealthScore(node) {
        let score = 100;

        // Latency penalty: up to -30 for high latency
        if (node.last_latency_ms >= 0) {
            score -= Math.min(node.last_latency_ms / 20, 30);
        }

        // Failure penalty: up to -50 based on failure count
        if (node.failure_count > 0) {
            score -= Math.min(node.failure_count * 10, 50);
        }

        // Unavailable penalty
        if (!node.available) {
            score -= 30;
        }

        return Math.max(0, Math.round(score));
    }

    static renderHealthBadge(score) {
        let color = 'var(--success)';
        if (score < 50) color = 'var(--error)';
        else if (score < 80) color = 'var(--warning)';

        return `<span class="health-badge" style="background: ${color}20; color: ${color}">${score}</span>`;
    }

    static renderNodeCard(node) {
        const statusClass = this.getStatusClass(node);
        const latency = node.last_latency_ms >= 0 ? node.last_latency_ms : '-';
        const sparkline = this.renderSparkline(node.timeline);
        const healthScore = this.getHealthScore(node);
        const healthBadge = this.renderHealthBadge(healthScore);

        return `
            <div class="node-card ${statusClass}" data-tag="${node.tag}">
                <div class="node-header">
                    <div class="node-select">
                        <input type="checkbox" class="node-checkbox" data-tag="${node.tag}">
                    </div>
                    <div class="node-info">
                        <div class="node-name" title="${node.name}">${node.name}</div>
                        <div class="node-tag">${node.tag}</div>
                    </div>
                    <div class="node-stats">
                        ${healthBadge}
                        <div class="latency-badge">
                            ${this.formatLatency(node.last_latency_ms)}<span class="ms">ms</span>
                        </div>
                    </div>
                </div>
                
                <div class="node-metrics">
                    ${sparkline}
                    <div class="metric-text">
                        <span title="Connections">🔗 ${node.active_connections || 0}</span>
                        <span title="Failures">❌ ${node.failure_count || 0}</span>
                    </div>
                </div>

                <div class="node-actions">
                    <button class="btn btn-secondary btn-xs btn-probe" data-tag="${node.tag}">
                        探测
                    </button>
                    <button class="btn btn-secondary btn-xs btn-check-ip" data-tag="${node.tag}">
                        查IP
                    </button>
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

    static renderConfigItem(node) {
        return `
            <div class="config-node-card">
                <div class="config-info">
                    <div class="node-name">${node.name}</div>
                    <div class="node-tag">${node.uri}</div>
                    <div class="text-secondary" style="font-size: 0.8em; margin-top:4px">
                        Port: <span style="color:var(--primary)">${node.port || 'Auto'}</span>
                    </div>
                </div>
                <div class="config-actions">
                    <button class="btn btn-secondary btn-xs btn-delete-config" data-name="${node.name}">删除</button>
                </div>
            </div>
        `;
    }

    static renderSettingsForm(data) {
        return `
            <div class="form-group">
                <label>代理池模式</label>
                <select name="pool_mode" class="form-input">
                    <option value="sequential" ${data.pool_mode === 'sequential' ? 'selected' : ''}>顺序轮询 (Sequential)</option>
                    <option value="random" ${data.pool_mode === 'random' ? 'selected' : ''}>随机 (Random)</option>
                    <option value="balance" ${data.pool_mode === 'balance' ? 'selected' : ''}>最少连接 (Least Conn)</option>
                    <option value="smart" ${data.pool_mode === 'smart' ? 'selected' : ''}>🧠 智能调度 (Smart)</option>
                </select>
            </div>
            
            <div class="form-group" style="margin-top: 1rem">
                <label>外部 IP (External IP)</label>
                <input type="text" name="external_ip" class="form-input" value="${data.external_ip || ''}" placeholder="0.0.0.0">
                <div class="form-help">用于导出的代理链接地址</div>
            </div>

            <div class="form-group" style="margin-top: 1rem">
                <label>探测目标 (Probe Target)</label>
                <input type="text" name="probe_target" class="form-input" value="${data.probe_target || ''}">
            </div>

            <div class="form-group" style="margin-top: 1rem">
                <label class="checkbox-label">
                    <input type="checkbox" name="skip_cert_verify" ${data.skip_cert_verify ? 'checked' : ''}>
                    跳过证书验证 (Skip SSL Verify)
                </label>
            </div>

            <div class="form-actions" style="margin-top: 2rem">
                <button type="submit" class="btn btn-primary">保存通用设置 (Save General)</button>
            </div>
        `;
    }

    static renderSubscriptionStatus(status) {
        const lastRef = status.last_refresh ? new Date(status.last_refresh).toLocaleString() : 'Never';
        const nextRef = status.next_refresh ? new Date(status.next_refresh).toLocaleString() : 'N/A';

        return `
            <div class="stat-card">
                <div class="stat-label">上次刷新</div>
                <div class="stat-value" style="font-size:1.2rem">${lastRef}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">下次刷新</div>
                <div class="stat-value" style="font-size:1.2rem">${nextRef}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">节点数量</div>
                <div class="stat-value" style="font-size:1.5rem">${status.node_count}</div>
            </div>
        `;
    }

    static renderSubscriptionForm(cfg) {
        const refresh = cfg.subscription_refresh || {};
        return `
            <div class="form-group">
                <label>订阅链接 (每行一个)</label>
                <textarea name="subscriptions" class="form-input" rows="6" style="font-family:monospace">${(cfg.subscriptions || []).join('\n')}</textarea>
            </div>

            <div class="form-group" style="margin-top: 1rem">
                <label class="checkbox-label">
                    <input type="checkbox" name="enabled" ${refresh.enabled ? 'checked' : ''}>
                    启用自动刷新
                </label>
            </div>

            <div class="form-row" style="display:flex; gap:1rem; margin-top:1rem">
                <div class="form-group" style="flex:1">
                    <label>刷新间隔</label>
                    <input type="text" name="interval" class="form-input" value="${refresh.interval || '30m'}">
                </div>
                 <div class="form-group" style="flex:1">
                    <label>超时时间</label>
                    <input type="text" name="timeout" class="form-input" value="${refresh.timeout || '30s'}">
                </div>
                <div class="form-group" style="flex:1">
                    <label>最少可用节点</label>
                    <input type="number" name="min_available_nodes" class="form-input" value="${refresh.min_available_nodes || 1}">
                </div>
            </div>

            <div class="form-actions" style="margin-top: 2rem">
                <button type="submit" class="btn btn-primary">保存订阅配置</button>
            </div>
        `;
    }

    static renderProxyAuthForm(auth) {
        // auth.listener is generic {username, has_password, enabled}
        // auth.multi_port similar
        // Note: Password fields are write-only usually, but backend might not return them.
        // We use placeholders if password is set.

        const listener = auth.listener || {};
        const multi = auth.multi_port || {};

        return `
             <div class="form-section" style="margin-bottom:2rem">
                <h3 style="margin-bottom:1rem; font-size:1rem; color:var(--primary)">Listener Auth (单端口模式)</h3>
                <div class="form-group">
                    <label>用户名</label>
                    <input type="text" name="listener_username" class="form-input" value="${listener.username || ''}">
                </div>
                <div class="form-group">
                    <label>密码 ${listener.has_password ? '(已设置)' : ''}</label>
                    <input type="password" name="listener_password" class="form-input" placeholder="${listener.has_password ? 'Leave empty to keep' : ''}">
                </div>
             </div>

             <div class="form-section">
                <h3 style="margin-bottom:1rem; font-size:1rem; color:var(--primary)">Multi-Port Auth (多端口模式)</h3>
                <div class="form-group">
                    <label>用户名</label>
                    <input type="text" name="multi_port_username" class="form-input" value="${multi.username || ''}">
                </div>
                <div class="form-group">
                    <label>密码 ${multi.has_password ? '(已设置)' : ''}</label>
                    <input type="password" name="multi_port_password" class="form-input" placeholder="${multi.has_password ? 'Leave empty to keep' : ''}">
                </div>
             </div>
             
             <div class="form-actions" style="margin-top: 2rem">
                <button type="submit" class="btn btn-primary">保存认证设置</button>
            </div>
        `;
    }

    static showLoginModal(onSubmit) {
        const container = document.getElementById('modal-container');
        container.innerHTML = `
            <div class="modal-overlay">
                <div class="modal-card">
                    <h2>Login</h2>
                    <form id="login-form">
                        <div class="form-group">
                            <input type="password" id="login-password" class="form-input" placeholder="Password" required>
                        </div>
                        <button type="submit" class="btn btn-primary" style="width: 100%; margin-top: 1rem">Sign In</button>
                    </form>
                </div>
            </div>
        `;

        document.getElementById('login-form').addEventListener('submit', (e) => {
            e.preventDefault();
            const pwd = document.getElementById('login-password').value;
            onSubmit(pwd);
        });
    }

    static showAddNodeModal(onSubmit) {
        const container = document.getElementById('modal-container');
        container.innerHTML = `
            <div class="modal-overlay">
                <div class="modal-card">
                    <h2>添加节点</h2>
                    <form id="add-node-form">
                        <div class="form-group">
                            <label>节点名称</label>
                            <input type="text" name="name" class="form-input" required>
                        </div>
                        <div class="form-group" style="margin-top: 1rem">
                            <label>代理 URI (socks5://...)</label>
                            <input type="text" name="uri" class="form-input" required>
                        </div>
                        <div class="form-group" style="margin-top: 1rem">
                            <label>本地端口 (可选)</label>
                            <input type="number" name="port" class="form-input" placeholder="0 = 随机">
                        </div>
                        <div class="modal-actions" style="margin-top: 1.5rem; display: flex; gap: 1rem">
                            <button type="button" class="btn btn-secondary" onclick="document.getElementById('modal-container').innerHTML=''">取消</button>
                            <button type="submit" class="btn btn-primary" style="flex:1">添加</button>
                        </div>
                    </form>
                </div>
            </div>
        `;

        document.getElementById('add-node-form').addEventListener('submit', (e) => {
            e.preventDefault();
            const formData = new FormData(e.target);
            onSubmit({
                name: formData.get('name'),
                uri: formData.get('uri'),
                port: parseInt(formData.get('port') || 0)
            });
            container.innerHTML = '';
        });
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
