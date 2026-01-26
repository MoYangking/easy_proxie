import { API } from './api.js';
import { UI } from './ui.js';

class App {
    constructor() {
        this.nodes = [];
        this.loggedIn = false;
        this.nodeHashes = new Map(); // Track node state for diff rendering
        this.ipCheckSeq = new Map(); // Per-node request sequencing for check-ip
        this.ws = null;
        this.wsReconnectTimer = null;
        this.init();
    }

    // Generate hash for node state to detect changes
    getNodeHash(node) {
        return `${node.tag}:${node.last_latency_ms}:${node.available}:${node.active_connections}:${node.failure_count}`;
    }

    async init() {
        this.bindEvents();

        // check auth first
        try {
            await API.getSettings(); // cheap probe
            this.loggedIn = true;
            this.updateAuthUI();
        } catch (e) {
            this.loggedIn = false;
            this.updateAuthUI();
            UI.showLoginModal((pwd) => this.handleLogin(pwd));
        }

        if (this.loggedIn) {
            await this.loadData();
            this.connectWebSocket();
        }
    }

    connectWebSocket() {
        if (this.ws) {
            this.ws.close();
        }

        const wsUrl = API.getWebSocketUrl();
        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
            console.log('WebSocket connected');
            if (this.wsReconnectTimer) {
                clearTimeout(this.wsReconnectTimer);
                this.wsReconnectTimer = null;
            }
        };

        this.ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                this.handleWSMessage(msg);
            } catch (e) {
                console.error('WS message parse error:', e);
            }
        };

        this.ws.onclose = () => {
            console.log('WebSocket closed, reconnecting in 5s...');
            this.wsReconnectTimer = setTimeout(() => this.connectWebSocket(), 5000);
        };

        this.ws.onerror = (err) => {
            console.error('WebSocket error:', err);
        };
    }

    handleWSMessage(msg) {
        switch (msg.type) {
            case 'init':
            case 'refresh':
                this.nodes = msg.nodes || [];
                this.render();
                break;
            case 'node_update':
                // Update single node
                const idx = this.nodes.findIndex(n => n.tag === msg.node.tag);
                if (idx >= 0) {
                    this.nodes[idx] = msg.node;
                } else {
                    this.nodes.push(msg.node);
                }
                this.render();
                break;
        }
    }

    async handleLogin(password) {
        try {
            const res = await API.login(password);
            if (res.token || res.no_password) {
                this.loggedIn = true;
                document.getElementById('modal-container').innerHTML = ''; // close modal
                this.updateAuthUI();
                await this.loadData();
                this.connectWebSocket(); // Use WebSocket instead of polling
                UI.showToast('Login Successful', 'success');
            }
        } catch (e) {
            UI.showToast(e.message, 'error');
        }
    }

    updateAuthUI() {
        const area = document.getElementById('auth-area');
        if (this.loggedIn) {
            area.innerHTML = '<span class="status-badge healthy">Logged In</span>';
        } else {
            area.innerHTML = '<span class="status-badge error">Not Logged In</span>';
        }
    }

    bindEvents() {
        // Tabs
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const tabName = e.target.dataset.tab;
                document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));

                e.target.classList.add('active');
                document.getElementById(`view-${tabName}`).classList.add('active');

                if (tabName === 'config') await this.loadConfig();
                if (tabName === 'subscriptions') await this.loadSubscriptions();
                if (tabName === 'settings') {
                    await this.loadSettings();
                    await this.loadProxyAuth();
                }
            });
        });

        // Global Buttons
        document.getElementById('btn-probe-all').addEventListener('click', () => this.probeAll());
        document.getElementById('btn-delete-failed').addEventListener('click', () => this.deleteFailed());
        document.getElementById('btn-add-node').addEventListener('click', () => {
            UI.showAddNodeModal((node) => this.addNode(node));
        });

        const btnRefreshSubs = document.getElementById('btn-refresh-subs');
        if (btnRefreshSubs) {
            btnRefreshSubs.addEventListener('click', async () => {
                try {
                    btnRefreshSubs.disabled = true;
                    btnRefreshSubs.innerText = 'Refreshing...';
                    await API.refreshSubscriptions();
                    UI.showToast('Subscription Refresh Triggered', 'success');
                    await this.loadSubscriptions(); // reload status
                } catch (e) {
                    UI.showToast(e.message, 'error');
                } finally {
                    btnRefreshSubs.disabled = false;
                    btnRefreshSubs.innerHTML = '<span class="icon">🔄</span> 立即刷新订阅';
                }
            });
        }
        document.getElementById('btn-reload').addEventListener('click', () => this.handleReload());

        // Batch selection
        const selectAllToggle = document.getElementById('toggle-select-all');
        const batchProbeBtn = document.getElementById('btn-batch-probe');
        const batchCountSpan = document.getElementById('batch-count');

        if (selectAllToggle) {
            selectAllToggle.addEventListener('change', () => {
                const checkboxes = document.querySelectorAll('.node-checkbox');
                checkboxes.forEach(cb => cb.checked = selectAllToggle.checked);
                this.updateBatchCount();
            });
        }

        // Batch probe button
        if (batchProbeBtn) {
            batchProbeBtn.addEventListener('click', () => this.batchProbe());
        }

        // Node Actions Delegation (including checkbox changes)
        document.getElementById('nodes-grid').addEventListener('click', async (e) => {
            const btn = e.target.closest('button');
            if (!btn) return;

            const tag = btn.dataset.tag;
            if (btn.classList.contains('btn-probe')) {
                await this.probeNode(tag, btn);
            } else if (btn.classList.contains('btn-check-ip')) {
                await this.checkNodeIP(tag, btn);
            }
        });

        document.getElementById('nodes-grid').addEventListener('change', (e) => {
            if (e.target.classList.contains('node-checkbox')) {
                this.updateBatchCount();
            }
        });
    }

    updateBatchCount() {
        const selected = document.querySelectorAll('.node-checkbox:checked');
        const count = selected.length;
        const batchCountSpan = document.getElementById('batch-count');
        const batchProbeBtn = document.getElementById('btn-batch-probe');

        if (batchCountSpan) batchCountSpan.textContent = count;
        if (batchProbeBtn) batchProbeBtn.disabled = count === 0;
    }

    getSelectedTags() {
        return Array.from(document.querySelectorAll('.node-checkbox:checked'))
            .map(cb => cb.dataset.tag);
    }

    async batchProbe() {
        const tags = this.getSelectedTags();
        if (tags.length === 0) return;

        UI.showToast(`开始批量探测 ${tags.length} 个节点...`, 'info');

        // Probe each node sequentially (or could batch on backend)
        let success = 0, failed = 0;
        for (const tag of tags) {
            try {
                await API.probeNode(tag);
                success++;
            } catch (e) {
                failed++;
            }
        }

        UI.showToast(`批量探测完成: 成功 ${success}, 失败 ${failed}`, success > 0 ? 'success' : 'error');
        await this.loadData();
    }

    async loadConfig() {
        try {
            const res = await API.getConfigNodes();
            const list = document.getElementById('config-list');
            list.innerHTML = res.nodes.map(n => UI.renderConfigItem(n)).join('');

            // Rebind delete buttons
            list.querySelectorAll('.btn-delete-config').forEach(btn => {
                btn.addEventListener('click', (e) => this.deleteConfigNode(e.target.dataset.name));
            });
        } catch (e) {
            UI.showToast('Load Config Failed: ' + e.message, 'error');
        }
    }

    async addNode(node) {
        try {
            await API.addConfigNode(node);
            UI.showToast('Node Added', 'success');
            await this.loadConfig();
            this.handleReload(false); // auto reload backend?
        } catch (e) {
            UI.showToast(e.message, 'error');
        }
    }

    async deleteConfigNode(name) {
        if (!confirm(`Delete node "${name}"?`)) return;
        try {
            await API.deleteConfigNode(name);
            UI.showToast('Node Deleted', 'success');
            await this.loadConfig();
        } catch (e) {
            UI.showToast(e.message, 'error');
        }
    }

    async loadSubscriptions() {
        try {
            const [config, status] = await Promise.all([
                API.getSubscriptionConfig(),
                API.getSubscriptionStatus()
            ]);

            const form = document.getElementById('subscription-form');
            form.innerHTML = UI.renderSubscriptionForm(config);
            form.onsubmit = async (e) => {
                e.preventDefault();
                await this.saveSubscriptions(new FormData(e.target));
            };

            const grid = document.getElementById('sub-status-grid');
            grid.innerHTML = UI.renderSubscriptionStatus(status);
        } catch (e) {
            UI.showToast('Load Subscriptions Failed: ' + e.message, 'error');
        }
    }

    async saveSubscriptions(formData) {
        const subs = formData.get('subscriptions').split('\n').filter(s => s.trim());
        const config = {
            subscriptions: subs,
            subscription_refresh: {
                enabled: formData.get('enabled') === 'on',
                interval: formData.get('interval') || '30m',
                timeout: formData.get('timeout') || '30s',
                min_available_nodes: parseInt(formData.get('min_available_nodes') || 1)
            }
        };
        try {
            await API.updateSubscriptionConfig(config);
            UI.showToast('Subscriptions Saved', 'success');
            await this.loadSubscriptions();
        } catch (e) {
            UI.showToast(e.message, 'error');
        }
    }

    async loadProxyAuth() {
        try {
            const auth = await API.getProxyAuth();

            // Append auth settings to settings form or a separate container? 
            // It's cleaner to have a separate section if we can, but let's append to settings-form 
            // or better yet, UI.renderSettingsForm should handle it if we pass it entire data.
            // But Settings API and Proxy Auth API are different.
            // Let's create a separate div for Proxy Auth in settings view

            let container = document.getElementById('proxy-auth-settings');
            if (!container) {
                container = document.createElement('div');
                container.id = 'proxy-auth-settings';
                container.className = 'settings-card';
                container.style.marginTop = '2rem';
                document.getElementById('view-settings').appendChild(container);
            }

            container.innerHTML = `
                <h2>代理认证设置 (Proxy Auth)</h2>
                <form id="proxy-auth-form">
                    ${UI.renderProxyAuthForm(auth)}
                </form>
            `;

            document.getElementById('proxy-auth-form').onsubmit = async (e) => {
                e.preventDefault();
                await this.saveProxyAuth(new FormData(e.target));
            };

        } catch (e) {
            UI.showToast('Load Proxy Auth Failed: ' + e.message, 'error');
        }
    }

    async saveProxyAuth(formData) {
        // Construct nested object
        const req = {
            listener: {
                // enabled checkbox logic is tricky with FormData if not present
                // We typically check strictly
                // UI.renderProxyAuthForm will use checkboxes
                username: formData.get('listener_username'),
                password: formData.get('listener_password')
            },
            multi_port: {
                username: formData.get('multi_port_username'),
                password: formData.get('multi_port_password')
            },
            reload: true
        };

        // Handle checkboxes manually if needed, or assume empty string means disabled?
        // Actually backend logic: if enabled/username/password are nil, no change.
        // We want to update.
        // Let's simplify: Just send username/password. Empty string clears it.

        try {
            const res = await API.updateProxyAuth(req);
            UI.showToast(res.message, 'success');
            if (res.need_reload) {
                // ...
            }
        } catch (e) {
            UI.showToast(e.message, 'error');
        }
    }

    async loadSettings() {
        try {
            const settings = await API.getSettings();
            const formContainer = document.getElementById('settings-form');
            formContainer.innerHTML = UI.renderSettingsForm(settings);

            formContainer.onsubmit = async (e) => {
                e.preventDefault();
                await this.saveSettings(new FormData(e.target));
            };
        } catch (e) {
            UI.showToast('Load Settings Failed: ' + e.message, 'error');
        }
    }

    async saveSettings(formData) {
        const settings = {
            pool_mode: formData.get('pool_mode'),
            external_ip: formData.get('external_ip'),
            probe_target: formData.get('probe_target'),
            skip_cert_verify: formData.get('skip_cert_verify') === 'on'
        };
        try {
            const res = await API.updateSettings(settings);
            UI.showToast(res.message, 'success');
            if (res.need_reload) {
                // Prompt reload?
            }
        } catch (e) {
            UI.showToast(e.message, 'error');
        }
    }

    async handleReload(notify = true) {
        try {
            await API.reload();
            if (notify) UI.showToast('System Reloaded', 'success');
            if (this.loggedIn) {
                await this.loadData();
                this.connectWebSocket();
            }
        } catch (e) {
            UI.showToast(e.message, 'error');
        }
    }

    async loadData() {
        if (!this.loggedIn) return;
        try {
            const data = await API.getNodes(true); // Get ALL nodes, including failed ones
            this.nodes = data.nodes || [];
            this.render();
        } catch (err) {
            console.error('Failed to load data:', err);
            UI.showToast('Failed to load nodes', 'error');
        }
    }

    render() {
        // Render Stats
        document.getElementById('stats-grid').innerHTML = UI.renderStats(this.nodes);

        const grid = document.getElementById('nodes-grid');

        // Build current node map
        const currentNodeMap = new Map();
        this.nodes.forEach(n => currentNodeMap.set(n.tag, n));

        // Preserve IP results
        const ipResults = {};
        document.querySelectorAll('.ip-result-container').forEach(el => {
            const html = el.innerHTML.trim();
            if (html !== '' || el.style.display !== 'none') {
                ipResults[el.id] = { html: el.innerHTML, display: el.style.display };
            }
        });

        // Get existing node cards
        const existingCards = new Map();
        grid.querySelectorAll('.node-card').forEach(card => {
            existingCards.set(card.dataset.tag, card);
        });

        // Diff-based update
        const newHashes = new Map();
        const fragment = document.createDocumentFragment();
        const processedTags = new Set();

        this.nodes.forEach(node => {
            const hash = this.getNodeHash(node);
            newHashes.set(node.tag, hash);
            processedTags.add(node.tag);

            const existingCard = existingCards.get(node.tag);
            const oldHash = this.nodeHashes.get(node.tag);

            if (existingCard && oldHash === hash) {
                // Node unchanged - keep existing card
                fragment.appendChild(existingCard);
            } else {
                // Node changed or new - create new card
                const temp = document.createElement('div');
                temp.innerHTML = UI.renderNodeCard(node);
                const newCard = temp.firstElementChild;
                fragment.appendChild(newCard);
            }
        });

        // Clear and rebuild grid
        grid.innerHTML = '';
        grid.appendChild(fragment);

        // Update hash map
        this.nodeHashes = newHashes;

        // Restore IP results
        Object.keys(ipResults).forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.innerHTML = ipResults[id].html;
                el.style.display = ipResults[id].display || 'block';
            }
        });
    }

    async probeNode(tag, btn) {
        btn.disabled = true;
        btn.innerHTML = '...';
        try {
            const res = await API.probeNode(tag);
            UI.showToast(`探测成功: ${res.latency_ms}ms`, 'success');
            await this.loadData();
        } catch (err) {
            UI.showToast(err.message, 'error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = '探测';
        }
    }

    async checkNodeIP(tag, btn) {
        const originalText = btn.innerHTML;
        const seq = (this.ipCheckSeq.get(tag) || 0) + 1;
        this.ipCheckSeq.set(tag, seq);
        btn.disabled = true;
        btn.innerHTML = '查询中(3次)...';

        const containerId = `ip-result-${tag}`;
        const getContainer = () => document.getElementById(containerId);

        let resultContainer = getContainer();
        if (!resultContainer) {
            btn.disabled = false;
            btn.innerHTML = originalText;
            return;
        }
        resultContainer.style.display = 'block';
        resultContainer.innerHTML = '<span class="text-secondary">正在采样3次...</span>';

        try {
            const res = await API.checkIP(tag);
            if (this.ipCheckSeq.get(tag) !== seq) return;
            if (res.tag && res.tag !== tag) throw new Error('check-ip response tag mismatch');
            const stableIcon = res.is_stable ? '✅' : '⚠️';
            const allIpsText = res.all_ips && res.all_ips.length > 1
                ? `<div class="text-secondary" style="font-size:0.75rem; margin-top:4px">检测到: ${res.all_ips.join(', ')}</div>`
                : '';

            // Initial display
            resultContainer = getContainer();
            if (!resultContainer) return;
            resultContainer.innerHTML = `
                <div class="ip-result">${stableIcon} IP: ${res.ip} <span class="geo-loading">🌍...</span></div>
                ${allIpsText}
            `;

            // Fetch GeoIP async
            try {
                const geo = await API.getGeoIP(res.ip);
                if (this.ipCheckSeq.get(tag) !== seq) return;
                const geoText = `${UI.countryFlag(geo.country_code)} ${geo.city || geo.country}`;
                resultContainer = getContainer();
                if (!resultContainer) return;
                const loadingEl = resultContainer.querySelector('.geo-loading');
                if (loadingEl) loadingEl.outerHTML = `<span class="geo-info">${geoText}</span>`;
            } catch (geoErr) {
                resultContainer = getContainer();
                if (!resultContainer) return;
                const loadingEl = resultContainer.querySelector('.geo-loading');
                if (loadingEl) loadingEl.outerHTML = '';
            }

            if (this.ipCheckSeq.get(tag) !== seq) return;
            UI.showToast(res.is_stable ? 'IP稳定' : 'IP不稳定(多个出口)', res.is_stable ? 'success' : 'info');
        } catch (err) {
            if (this.ipCheckSeq.get(tag) === seq) {
                resultContainer = getContainer();
                if (resultContainer) {
                    resultContainer.innerHTML = `<span style="color: var(--error)">查询失败</span>`;
                }
                UI.showToast('IP查询失败', 'error');
            }
        } finally {
            if (this.ipCheckSeq.get(tag) === seq) {
                btn.disabled = false;
                btn.innerHTML = originalText;
            }
        }
    }

    async probeAll() {
        // This usually uses SSE in the original code, but we might just trigger it.
        // The original backend has SSE handler /api/nodes/probe-all
        // We should probably implement SSE handling if we want progress.
        // For simplicity now, we'll just open a toast saying it started.

        const eventSource = new EventSource('/api/nodes/probe-all?method=POST'); // GET implies standard SSE, but the backend checks POST? 
        // Wait, standard EventSource is GET.
        // The backend code:
        // func (s *Server) handleProbeAll(w http.ResponseWriter, r *http.Request) {
        //    if r.Method != http.MethodPost { ... }

        // Use fetch to trigger it if it requires POST, but EventSource doesn't support POST.
        // The backend requires POST for /api/nodes/probe-all. 
        // This design in backend is slightly conflicting with standard EventSource (which is GET).
        // However, we can use fetch to trigger it and read the stream manually, or use a library like event-source-polyfill which supports custom constraints.
        // Or we can just modify backend to allow GET? 
        // Modifying backend is safer.

        // Let's modify the backend to allow GET for SSE or use fetch to read stream.
        // Using fetch to read stream is strictly better here as we don't need to change backend again.

        UI.showToast('开始全量探测...', 'info');

        try {
            const response = await fetch('/api/nodes/probe-all', { method: 'POST' });
            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value);
                const lines = chunk.split('\n');
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.slice(6));
                            if (data.type === 'progress') {
                                // Maybe update specific node card?
                            } else if (data.type === 'complete') {
                                UI.showToast(`探测完成: 成功 ${data.success}, 失败 ${data.failed}`, 'success');
                                this.loadData();
                            }
                        } catch (e) { }
                    }
                }
            }
        } catch (err) {
            UI.showToast('探测请求失败', 'error');
        }
    }

    async deleteFailed() {
        if (!confirm('确定要删除所有失效节点吗？')) return;
        try {
            const res = await API.deleteFailedNodes();
            UI.showToast(res.message, 'success');
            this.loadData();
        } catch (err) {
            UI.showToast(err.message, 'error');
        }
    }
}

// Init
new App();
