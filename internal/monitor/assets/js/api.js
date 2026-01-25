
export class API {
    static async request(endpoint, options = {}) {
        const response = await fetch(endpoint, options);
        if (response.status === 401) {
            window.location.reload(); // Simple auth redirect
            return null;
        }
        if (!response.ok) {
            const err = await response.json().catch(() => ({ error: 'Unknown error' }));
            throw new Error(err.error || response.statusText);
        }
        return response.json();
    }

    static async getNodes(all = false) {
        return this.request(`/api/nodes?all=${all ? 1 : 0}`);
    }

    static async probeNode(tag) {
        return this.request(`/api/nodes/${encodeURIComponent(tag)}/probe`, { method: 'POST' });
    }

    static async checkIP(tag) {
        return this.request('/api/nodes/check-ip', {
            method: 'POST',
            body: JSON.stringify({ tag }),
            headers: { 'Content-Type': 'application/json' }
        });
    }

    static async deleteFailedNodes(reload = true) {
        return this.request(`/api/nodes/delete-failed?reload=${reload}`, { method: 'POST' });
    }

    static async login(password) {
        return this.request('/api/auth', {
            method: 'POST',
            body: JSON.stringify({ password }),
            headers: { 'Content-Type': 'application/json' }
        });
    }

    static async getConfigNodes() {
        return this.request('/api/nodes/config');
    }

    static async addConfigNode(node) {
        return this.request('/api/nodes/config', {
            method: 'POST',
            body: JSON.stringify(node),
            headers: { 'Content-Type': 'application/json' }
        });
    }

    static async deleteConfigNode(name) {
        return this.request(`/api/nodes/config/${encodeURIComponent(name)}`, { method: 'DELETE' });
    }

    static async getSettings() {
        return this.request('/api/settings');
    }

    static async getSubscriptionConfig() {
        return this.request('/api/subscription/config');
    }

    static async updateSubscriptionConfig(config) {
        return this.request('/api/subscription/config', {
            method: 'PUT',
            body: JSON.stringify(config),
            headers: { 'Content-Type': 'application/json' }
        });
    }

    static async getSubscriptionStatus() {
        return this.request('/api/subscription/status');
    }

    static async refreshSubscriptions() {
        return this.request('/api/subscription/refresh', { method: 'POST' });
    }

    static async getProxyAuth() {
        return this.request('/api/proxy/auth');
    }

    static async updateProxyAuth(authConfig) {
        return this.request('/api/proxy/auth', {
            method: 'PUT',
            body: JSON.stringify(authConfig),
            headers: { 'Content-Type': 'application/json' }
        });
    }

    static async updateSettings(settings) {
        return this.request('/api/settings', {
            method: 'PUT',
            body: JSON.stringify(settings),
            headers: { 'Content-Type': 'application/json' }
        });
    }

    static async reload() {
        return this.request('/api/reload', { method: 'POST' });
    }

    static getExportUrl() {
        return '/api/export';
    }
}
