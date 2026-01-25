import { API } from './api.js';
import { UI } from './ui.js';

class App {
    constructor() {
        this.nodes = [];
        this.init();
    }

    async init() {
        this.bindEvents();
        await this.loadData();
        // Auto refresh every 5s
        setInterval(() => this.loadData(), 5000);
    }

    bindEvents() {
        // Tabs
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const tabName = e.target.dataset.tab;
                document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));

                e.target.classList.add('active');
                document.getElementById(`view-${tabName}`).classList.add('active');
            });
        });

        // Global Buttons
        document.getElementById('btn-probe-all').addEventListener('click', () => this.probeAll());
        document.getElementById('btn-delete-failed').addEventListener('click', () => this.deleteFailed());

        // Node Actions Delegation
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
    }

    async loadData() {
        try {
            const data = await API.getNodes(false); // Get filtered active nodes usually, assuming API default
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

        // Render Nodes (only redraw if needed or just naive redraw for now)
        // Ideally we diff, but for < 100 nodes, replacement is fine
        // We want to preserve open IP results if possible, but that's complex without a state store.
        // For now, let's just re-render. Note: This clears IP checks. 
        // Improvement: Store IP check results in this.nodes state.

        const grid = document.getElementById('nodes-grid');
        // Simple optimization: if node count matches and we are just refreshing stats, maybe update in place? 
        // For this task, we will just re-render.

        // Preserve IP results
        const ipResults = {};
        document.querySelectorAll('.ip-result-container').forEach(el => {
            if (el.innerHTML) ipResults[el.id] = el.innerHTML;
        });

        grid.innerHTML = this.nodes.map(n => UI.renderNodeCard(n)).join('');

        // Restore IP results (if node still exists)
        Object.keys(ipResults).forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.innerHTML = ipResults[id];
                el.style.display = 'block';
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
        btn.disabled = true;
        btn.innerHTML = '查询中...';

        const resultContainer = document.getElementById(`ip-result-${tag}`);
        resultContainer.style.display = 'block';
        resultContainer.innerHTML = '<span class="text-secondary">正在连接...</span>';

        try {
            const res = await API.checkIP(tag);
            resultContainer.innerHTML = `<div class="ip-result">IP: ${res.ip}</div>`;
            UI.showToast('IP查询成功', 'success');
        } catch (err) {
            resultContainer.innerHTML = `<span style="color: var(--error)">查询失败</span>`;
            UI.showToast('IP查询失败', 'error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = originalText;
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
