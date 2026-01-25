export class ApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

async function readJsonSafe(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

export async function requestJSON(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (!headers.has("Content-Type") && options.body != null) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(path, { ...options, headers });
  const payload = await readJsonSafe(res);
  if (!res.ok) {
    throw new ApiError(payload?.error || `${res.status} ${res.statusText}`, res.status, payload);
  }
  return payload;
}

export async function auth(password) {
  return requestJSON("/api/auth", { method: "POST", body: JSON.stringify({ password }) });
}

export async function getNodes({ all = false } = {}) {
  const url = all ? "/api/nodes?all=1" : "/api/nodes";
  const data = await requestJSON(url);
  return data.nodes || [];
}

export async function probeNode(tag) {
  return requestJSON(`/api/nodes/${encodeURIComponent(tag)}/probe`, { method: "POST" });
}

export async function probeExitIP(tag) {
  return requestJSON(`/api/nodes/${encodeURIComponent(tag)}/probe-ip`, { method: "POST" });
}

export async function releaseNode(tag) {
  return requestJSON(`/api/nodes/${encodeURIComponent(tag)}/release`, { method: "POST" });
}

export async function deleteNode(tag) {
  return requestJSON(`/api/nodes/${encodeURIComponent(tag)}/delete`, { method: "POST" });
}

export async function deleteFailedNodes() {
  return requestJSON("/api/nodes/delete-failed", { method: "POST" });
}

export async function reloadConfig() {
  return requestJSON("/api/reload", { method: "POST" });
}

export async function exportNodes() {
  const res = await fetch("/api/export");
  if (!res.ok) {
    const payload = await readJsonSafe(res);
    throw new ApiError(payload?.error || `${res.status} ${res.statusText}`, res.status, payload);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "proxy_pool.txt";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function getSettings() {
  return requestJSON("/api/settings");
}

export async function updateSettings(payload) {
  return requestJSON("/api/settings", { method: "PUT", body: JSON.stringify(payload) });
}

export async function getProxyAuth() {
  return requestJSON("/api/proxy/auth");
}

export async function updateProxyAuth(payload) {
  return requestJSON("/api/proxy/auth", { method: "PUT", body: JSON.stringify(payload) });
}

export async function getConfigNodes() {
  const data = await requestJSON("/api/nodes/config");
  return data.nodes || [];
}

export async function createConfigNode(payload) {
  return requestJSON("/api/nodes/config", { method: "POST", body: JSON.stringify(payload) });
}

export async function updateConfigNode(name, payload) {
  return requestJSON(`/api/nodes/config/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify(payload) });
}

export async function deleteConfigNode(name) {
  return requestJSON(`/api/nodes/config/${encodeURIComponent(name)}`, { method: "DELETE" });
}

export async function getSubscriptionConfig() {
  return requestJSON("/api/subscription/config");
}

export async function updateSubscriptionConfig(payload) {
  return requestJSON("/api/subscription/config", { method: "PUT", body: JSON.stringify(payload) });
}

export async function getSubscriptionStatus() {
  return requestJSON("/api/subscription/status");
}

export async function refreshSubscriptions() {
  return requestJSON("/api/subscription/refresh", { method: "POST" });
}

export async function getDebug() {
  return requestJSON("/api/debug");
}

export async function probeAllNodes(onEvent) {
  const res = await fetch("/api/nodes/probe-all", { method: "POST" });
  if (!res.ok || !res.body) {
    const payload = await readJsonSafe(res);
    throw new ApiError(payload?.error || `${res.status} ${res.statusText}`, res.status, payload);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";

    for (const chunk of chunks) {
      const lines = chunk.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const jsonText = trimmed.replace(/^data:\\s*/, "");
        if (!jsonText) continue;
        try {
          const evt = JSON.parse(jsonText);
          onEvent?.(evt);
        } catch {
          // ignore
        }
      }
    }
  }
}
