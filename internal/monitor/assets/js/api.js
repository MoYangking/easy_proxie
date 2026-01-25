
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

    static async getSettings() {
        return this.request('/api/settings');
    }
}
