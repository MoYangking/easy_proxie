export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", { hour12: false });
}

export function formatLatency(ms) {
  if (ms == null || ms < 0) return "—";
  return `${ms} ms`;
}

export function toast(message, type = "info", ttlMs = 2600) {
  const host = $("#toastHost");
  if (!host) return;
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  host.appendChild(el);
  window.setTimeout(() => el.remove(), ttlMs);
}

export function show(el) {
  if (!el) return;
  el.hidden = false;
}

export function hide(el) {
  if (!el) return;
  el.hidden = true;
}

export function setText(el, text) {
  if (!el) return;
  el.textContent = text;
}

export function setBusy(btn, busy, busyText = "处理中...") {
  if (!btn) return;
  if (!btn.dataset._text) btn.dataset._text = btn.textContent || "";
  btn.disabled = !!busy;
  btn.textContent = busy ? busyText : btn.dataset._text;
}
