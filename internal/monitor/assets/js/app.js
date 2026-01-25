import * as api from "./api.js";
import { $, $$, formatLatency, formatTime, hide, setBusy, setText, show, toast } from "./ui.js";

const PREF_KEY = "easy_proxies.monitor.prefs";

const state = {
  activeTab: "nodes",
  autoRefresh: true,
  darkMode: null,
  showAllNodes: false,
  search: "",
  nodes: [],
  autoTimer: null,
};

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return;
    const prefs = JSON.parse(raw);
    state.autoRefresh = prefs.autoRefresh ?? true;
    state.showAllNodes = prefs.showAllNodes ?? false;
    state.darkMode = prefs.darkMode ?? null;
  } catch {
    // ignore
  }
}

function savePrefs() {
  localStorage.setItem(
    PREF_KEY,
    JSON.stringify({ autoRefresh: state.autoRefresh, showAllNodes: state.showAllNodes, darkMode: state.darkMode }),
  );
}

function setTheme(mode) {
  state.darkMode = mode; // true/false/null
  if (mode === null) {
    document.body.removeAttribute("data-theme");
  } else {
    document.body.dataset.theme = mode ? "dark" : "light";
  }
  savePrefs();
}

function isUnauthorized(err) {
  return err instanceof api.ApiError && err.status === 401;
}

function isNodeManagerDisabled(err) {
  return err instanceof api.ApiError && err.status === 503;
}

function showLogin(message) {
  const overlay = $("#loginOverlay");
  const errEl = $("#loginError");
  if (message) {
    setText(errEl, message);
    show(errEl);
  } else {
    hide(errEl);
  }
  show(overlay);
  $("#loginPassword")?.focus();
}

function hideLogin() {
  hide($("#loginOverlay"));
  hide($("#loginError"));
  const input = $("#loginPassword");
  if (input) input.value = "";
}

function switchTab(tab) {
  state.activeTab = tab;
  for (const btn of $$(".tab")) {
    btn.classList.toggle("is-active", btn.dataset.tab === tab);
  }
  for (const page of $$(".page")) {
    page.classList.toggle("is-active", page.dataset.page === tab);
  }
}

function renderStats(nodes) {
  const total = nodes.length;
  const checked = nodes.filter((n) => n.initial_check_done).length;
  const available = nodes.filter((n) => n.available).length;
  const blacklisted = nodes.filter((n) => n.blacklisted).length;

  const host = $("#stats");
  host.innerHTML = "";
  const items = [
    ["总节点", total],
    ["已检测", checked],
    ["可用", available],
    ["黑名单", blacklisted],
  ];
  for (const [k, v] of items) {
    const card = document.createElement("div");
    card.className = "stat";
    const kk = document.createElement("div");
    kk.className = "k";
    kk.textContent = k;
    const vv = document.createElement("div");
    vv.className = "v";
    vv.textContent = String(v);
    card.appendChild(kk);
    card.appendChild(vv);
    host.appendChild(card);
  }
}

function statusBadge(node) {
  let text = "未检测";
  let cls = "";
  if (node.initial_check_done) {
    if (node.available) {
      text = node.blacklisted ? "可用（黑名单）" : "可用";
      cls = "ok";
    } else {
      text = node.blacklisted ? "不可用（黑名单）" : "不可用";
      cls = "bad";
    }
  }
  const span = document.createElement("span");
  span.className = `badge ${cls}`;
  const dot = document.createElement("span");
  dot.className = "dot";
  const t = document.createElement("span");
  t.textContent = text;
  span.appendChild(dot);
  span.appendChild(t);
  return span;
}

function renderNodesTable(nodes) {
  const tbody = $("#nodesTable tbody");
  tbody.innerHTML = "";

  const q = state.search.trim().toLowerCase();
  const filtered = q
    ? nodes.filter((n) => {
        const hay = `${n.name || ""} ${n.tag || ""} ${n.uri || ""}`.toLowerCase();
        return hay.includes(q);
      })
    : nodes;

  for (const n of filtered) {
    const tr = document.createElement("tr");
    tr.dataset.tag = n.tag;

    const tdStatus = document.createElement("td");
    tdStatus.appendChild(statusBadge(n));

    const tdName = document.createElement("td");
    const title = document.createElement("div");
    title.className = "cell-title";
    title.textContent = n.name || n.tag;
    const sub = document.createElement("div");
    sub.className = "cell-sub";
    sub.textContent = n.tag || "";
    const uri = document.createElement("div");
    uri.className = "cell-sub";
    uri.textContent = n.uri || "";
    tdName.appendChild(title);
    tdName.appendChild(sub);
    if (n.uri) tdName.appendChild(uri);

    const tdMode = document.createElement("td");
    tdMode.textContent = n.mode || "—";

    const tdLatency = document.createElement("td");
    tdLatency.textContent = formatLatency(n.last_latency_ms);

    const tdExitIP = document.createElement("td");
    const ipText = n.last_exit_ip || "—";
    tdExitIP.textContent = ipText;
    const ipTitle = [];
    if (n.last_exit_ip_at) ipTitle.push(`时间：${formatTime(n.last_exit_ip_at)}`);
    if (n.last_exit_ip_error) ipTitle.push(`错误：${n.last_exit_ip_error}`);
    if (ipTitle.length) tdExitIP.title = ipTitle.join("\n");

    const tdConn = document.createElement("td");
    tdConn.textContent = String(n.active_connections ?? 0);

    const tdOk = document.createElement("td");
    tdOk.textContent = String(n.success_count ?? 0);

    const tdFail = document.createElement("td");
    tdFail.textContent = String(n.failure_count ?? 0);

    const tdErr = document.createElement("td");
    tdErr.textContent = n.last_error || n.last_exit_ip_error || "";

    const tdActions = document.createElement("td");
    tdActions.className = "actions";

    const mk = (label, action, cls) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `btn ${cls || ""}`.trim();
      b.dataset.nodeAction = action;
      b.dataset.tag = n.tag;
      b.textContent = label;
      return b;
    };

    tdActions.appendChild(mk("探测延迟", "probe"));
    tdActions.appendChild(mk("探测 IP", "probe-ip"));
    tdActions.appendChild(mk("释放", "release"));
    tdActions.appendChild(mk("删除", "delete", "danger"));

    tr.appendChild(tdStatus);
    tr.appendChild(tdName);
    tr.appendChild(tdMode);
    tr.appendChild(tdLatency);
    tr.appendChild(tdExitIP);
    tr.appendChild(tdConn);
    tr.appendChild(tdOk);
    tr.appendChild(tdFail);
    tr.appendChild(tdErr);
    tr.appendChild(tdActions);

    tbody.appendChild(tr);
  }
}

async function loadNodes() {
  const nodes = await api.getNodes({ all: state.showAllNodes });
  state.nodes = nodes;
  renderStats(nodes);
  renderNodesTable(nodes);
}

async function refreshNodes() {
  try {
    await loadNodes();
  } catch (err) {
    if (isUnauthorized(err)) {
      showLogin(err.message);
      return;
    }
    toast(err.message || "刷新失败", "error");
  }
}

function setAutoRefresh(enabled) {
  state.autoRefresh = enabled;
  savePrefs();
  if (state.autoTimer) {
    window.clearInterval(state.autoTimer);
    state.autoTimer = null;
  }
  if (enabled) {
    state.autoTimer = window.setInterval(() => {
      if (state.activeTab === "nodes") refreshNodes();
    }, 5000);
  }
}

async function handleNodeAction(btn) {
  const tag = btn.dataset.tag;
  const action = btn.dataset.nodeAction;
  if (!tag || !action) return;

  try {
    if (action === "delete") {
      if (!confirm(`确认删除节点：${tag}？（需要重载生效）`)) return;
    }

    setBusy(btn, true);
    if (action === "probe") {
      const res = await api.probeNode(tag);
      toast(`探测成功：${res.latency_ms ?? "—"} ms`, "success");
    } else if (action === "probe-ip") {
      const res = await api.probeExitIP(tag);
      toast(`出口 IP：${res.exit_ip || "—"}`, "success");
    } else if (action === "release") {
      await api.releaseNode(tag);
      toast("已释放黑名单", "success");
    } else if (action === "delete") {
      await api.deleteNode(tag);
      toast("已删除（请重载生效）", "success");
    }
    await refreshNodes();
  } catch (err) {
    if (isUnauthorized(err)) {
      showLogin(err.message);
      return;
    }
    toast(err.message || "操作失败", "error");
  } finally {
    setBusy(btn, false);
  }
}

function openProbeOverlay() {
  show($("#probeOverlay"));
  $("#probeBar").style.width = "0%";
  $("#probeInfo").innerHTML = "";
}

function updateProbeOverlay(evt) {
  if (evt.type === "start") {
    $("#probeBar").style.width = "0%";
    $("#probeInfo").innerHTML = `<b>总数</b><span>${evt.total}</span>`;
    return;
  }
  if (evt.type === "progress") {
    const pct = evt.progress ?? 0;
    $("#probeBar").style.width = `${pct}%`;
    $("#probeInfo").innerHTML =
      `<b>进度</b><span>${evt.current}/${evt.total}（${pct.toFixed?.(1) ?? pct}%）</span>` +
      `<b>节点</b><span>${evt.name || evt.tag || ""}</span>` +
      `<b>延迟</b><span>${evt.error ? "失败" : `${evt.latency} ms`}</span>`;
    return;
  }
  if (evt.type === "complete") {
    $("#probeBar").style.width = "100%";
    $("#probeInfo").innerHTML += `<b>完成</b><span>成功 ${evt.success} / 失败 ${evt.failed}</span>`;
  }
}

async function probeAll() {
  openProbeOverlay();
  try {
    await api.probeAllNodes(updateProbeOverlay);
    toast("批量探测完成", "success");
    await refreshNodes();
  } catch (err) {
    if (isUnauthorized(err)) {
      hide($("#probeOverlay"));
      showLogin(err.message);
      return;
    }
    toast(err.message || "批量探测失败", "error");
  }
}

async function loadSettings() {
  try {
    const data = await api.getSettings();
    $("#settingExternalIP").value = data.external_ip || "";
    $("#settingProbeTarget").value = data.probe_target || "";
    $("#settingSkipCertVerify").checked = !!data.skip_cert_verify;
    $("#settingPoolMode").value = data.pool_mode || "sequential";
  } catch (err) {
    if (isUnauthorized(err)) {
      showLogin(err.message);
      return;
    }
    toast(err.message || "加载设置失败", "error");
  }
}

async function saveSettings(btn) {
  const payload = {
    external_ip: $("#settingExternalIP").value.trim(),
    probe_target: $("#settingProbeTarget").value.trim(),
    skip_cert_verify: $("#settingSkipCertVerify").checked,
    pool_mode: $("#settingPoolMode").value,
  };
  try {
    setBusy(btn, true);
    const res = await api.updateSettings(payload);
    toast(res.message || "设置已保存", "success");
  } catch (err) {
    if (isUnauthorized(err)) {
      showLogin(err.message);
      return;
    }
    toast(err.message || "保存失败", "error");
  } finally {
    setBusy(btn, false);
  }
}

async function loadProxyAuth() {
  const notice = $("#proxyAuthNotice");
  hide(notice);
  try {
    const data = await api.getProxyAuth();
    $("#proxyListenerEnabled").checked = !!data.listener?.enabled;
    $("#proxyListenerUsername").value = data.listener?.username || "";
    $("#proxyMultiEnabled").checked = !!data.multi_port?.enabled;
    $("#proxyMultiUsername").value = data.multi_port?.username || "";
  } catch (err) {
    if (isUnauthorized(err)) {
      showLogin(err.message);
      return;
    }
    if (isNodeManagerDisabled(err)) {
      setText(notice, "节点管理未启用：代理认证相关功能不可用。");
      show(notice);
      return;
    }
    toast(err.message || "加载代理认证失败", "error");
  }
}

async function saveProxyAuth(btn) {
  const payload = {
    listener: {
      enabled: $("#proxyListenerEnabled").checked,
      username: $("#proxyListenerUsername").value.trim(),
      password: $("#proxyListenerPassword").value,
    },
    multi_port: {
      enabled: $("#proxyMultiEnabled").checked,
      username: $("#proxyMultiUsername").value.trim(),
      password: $("#proxyMultiPassword").value,
    },
    reload: $("#proxyAuthReload").checked,
  };
  try {
    setBusy(btn, true);
    const res = await api.updateProxyAuth(payload);
    toast(res.message || "代理认证已保存", "success");
    $("#proxyListenerPassword").value = "";
    $("#proxyMultiPassword").value = "";
  } catch (err) {
    if (isUnauthorized(err)) {
      showLogin(err.message);
      return;
    }
    toast(err.message || "保存失败", "error");
  } finally {
    setBusy(btn, false);
  }
}

function openConfigModal(editingNode) {
  $("#configEditingName").value = editingNode?.name || "";
  $("#configModalTitle").textContent = editingNode ? "编辑节点" : "新增节点";
  $("#configName").value = editingNode?.name || "";
  $("#configURI").value = editingNode?.uri || "";
  $("#configPort").value = editingNode?.port || "";
  $("#configUsername").value = editingNode?.username || "";
  $("#configPassword").value = editingNode?.password || "";
  hide($("#configError"));
  show($("#configModal"));
  $("#configName")?.focus();
}

function closeConfigModal() {
  hide($("#configModal"));
  $("#configPassword").value = "";
  $("#configEditingName").value = "";
}

function renderConfigNodes(nodes) {
  const tbody = $("#configTable tbody");
  tbody.innerHTML = "";

  for (const n of nodes) {
    const tr = document.createElement("tr");
    const tdName = document.createElement("td");
    tdName.textContent = n.name || "";
    const tdURI = document.createElement("td");
    tdURI.textContent = n.uri || "";
    tdURI.title = n.uri || "";
    const tdPort = document.createElement("td");
    tdPort.textContent = n.port ? String(n.port) : "";
    const tdUser = document.createElement("td");
    tdUser.textContent = n.username || "";

    const tdAct = document.createElement("td");
    tdAct.className = "actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "btn";
    edit.textContent = "编辑";
    edit.addEventListener("click", () => openConfigModal(n));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn danger";
    del.textContent = "删除";
    del.addEventListener("click", async () => {
      if (!confirm(`确认删除配置节点：${n.name}？（需要重载生效）`)) return;
      try {
        await api.deleteConfigNode(n.name);
        toast("已删除（请重载生效）", "success");
        await loadConfigNodes();
      } catch (err) {
        if (isUnauthorized(err)) return showLogin(err.message);
        toast(err.message || "删除失败", "error");
      }
    });
    tdAct.appendChild(edit);
    tdAct.appendChild(del);

    tr.appendChild(tdName);
    tr.appendChild(tdURI);
    tr.appendChild(tdPort);
    tr.appendChild(tdUser);
    tr.appendChild(tdAct);
    tbody.appendChild(tr);
  }
}

async function loadConfigNodes() {
  const notice = $("#configNotice");
  hide(notice);
  try {
    const nodes = await api.getConfigNodes();
    renderConfigNodes(nodes);
  } catch (err) {
    if (isUnauthorized(err)) {
      showLogin(err.message);
      return;
    }
    if (isNodeManagerDisabled(err)) {
      setText(notice, "节点管理未启用：配置节点相关功能不可用。");
      show(notice);
      return;
    }
    toast(err.message || "加载失败", "error");
  }
}

async function submitConfigForm(evt) {
  evt.preventDefault();
  const errEl = $("#configError");
  hide(errEl);

  const editingName = $("#configEditingName").value.trim();
  const payload = {
    name: $("#configName").value.trim(),
    uri: $("#configURI").value.trim(),
    port: Number($("#configPort").value || 0),
    username: $("#configUsername").value.trim(),
    password: $("#configPassword").value,
  };

  try {
    if (editingName) {
      await api.updateConfigNode(editingName, payload);
      toast("已更新（请重载生效）", "success");
    } else {
      await api.createConfigNode(payload);
      toast("已新增（请重载生效）", "success");
    }
    closeConfigModal();
    await loadConfigNodes();
  } catch (err) {
    if (isUnauthorized(err)) return showLogin(err.message);
    setText(errEl, err.message || "保存失败");
    show(errEl);
  }
}

function renderSubStatus(data) {
  const host = $("#subStatus");
  host.innerHTML = "";
  const add = (k, v) => {
    const kk = document.createElement("b");
    kk.textContent = k;
    const vv = document.createElement("span");
    vv.textContent = v ?? "—";
    host.appendChild(kk);
    host.appendChild(vv);
  };
  add("上次刷新", data.last_refresh ? formatTime(data.last_refresh) : "—");
  add("下次刷新", data.next_refresh ? formatTime(data.next_refresh) : "—");
  add("节点数", String(data.node_count ?? 0));
  add("刷新次数", String(data.refresh_count ?? 0));
  add("是否刷新中", data.is_refreshing ? "是" : "否");
  add("nodes.txt 变化", data.nodes_modified ? "是" : "否");
  add("最后错误", data.last_error || "—");
}

async function loadSubscription() {
  const notice = $("#subNotice");
  hide(notice);
  try {
    const cfg = await api.getSubscriptionConfig();
    const subs = cfg.subscriptions || [];
    $("#subUrls").value = subs.join("\n");
    const r = cfg.subscription_refresh || {};
    $("#subEnabled").checked = !!r.enabled;
    $("#subInterval").value = r.interval || "";
    $("#subTimeout").value = r.timeout || "";
    $("#subHealthTimeout").value = r.health_check_timeout || "";
    $("#subDrainTimeout").value = r.drain_timeout || "";
    $("#subMinAvailable").value = r.min_available_nodes ?? "";
    await loadSubscriptionStatus();
  } catch (err) {
    if (isUnauthorized(err)) {
      showLogin(err.message);
      return;
    }
    if (isNodeManagerDisabled(err)) {
      setText(notice, "节点管理未启用：订阅相关功能不可用。");
      show(notice);
      return;
    }
    toast(err.message || "加载订阅失败", "error");
  }
}

async function loadSubscriptionStatus() {
  try {
    const st = await api.getSubscriptionStatus();
    renderSubStatus(st);
  } catch (err) {
    if (isUnauthorized(err)) return showLogin(err.message);
    toast(err.message || "获取状态失败", "error");
  }
}

async function saveSubscription(btn) {
  const urls = $("#subUrls")
    .value.split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const minAvailableStr = String($("#subMinAvailable").value || "").trim();
  let minAvailableNodes;
  if (minAvailableStr !== "") {
    const parsed = Number(minAvailableStr);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      toast("最小可用节点数必须大于 0", "error");
      return;
    }
    minAvailableNodes = parsed;
  }
  const payload = {
    subscriptions: urls,
    subscription_refresh: {
      enabled: $("#subEnabled").checked,
      interval: $("#subInterval").value.trim(),
      timeout: $("#subTimeout").value.trim(),
      health_check_timeout: $("#subHealthTimeout").value.trim(),
      drain_timeout: $("#subDrainTimeout").value.trim(),
      min_available_nodes: minAvailableNodes,
    },
  };
  try {
    setBusy(btn, true);
    const res = await api.updateSubscriptionConfig(payload);
    toast(res.message || "订阅已保存", "success");
    await loadSubscriptionStatus();
  } catch (err) {
    if (isUnauthorized(err)) return showLogin(err.message);
    toast(err.message || "保存失败", "error");
  } finally {
    setBusy(btn, false);
  }
}

async function refreshSubscriptionsNow(btn) {
  try {
    setBusy(btn, true);
    const res = await api.refreshSubscriptions();
    toast(res.message || `已刷新：${res.count ?? 0}`, "success");
    await loadSubscriptionStatus();
    await refreshNodes();
  } catch (err) {
    if (isUnauthorized(err)) return showLogin(err.message);
    toast(err.message || "刷新失败", "error");
  } finally {
    setBusy(btn, false);
  }
}

async function loadDebug() {
  try {
    const data = await api.getDebug();
    $("#debugOutput").textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    if (isUnauthorized(err)) return showLogin(err.message);
    toast(err.message || "加载调试失败", "error");
  }
}

function wireEvents() {
  document.addEventListener("click", async (e) => {
    const tabBtn = e.target.closest(".tab");
    if (tabBtn) {
      const tab = tabBtn.dataset.tab;
      switchTab(tab);
      if (tab === "config") await loadConfigNodes();
      if (tab === "subscription") await loadSubscription();
      if (tab === "settings") {
        await loadSettings();
        await loadProxyAuth();
      }
      if (tab === "debug") await loadDebug();
      return;
    }

    const actionBtn = e.target.closest("[data-action]");
    if (actionBtn) {
      const action = actionBtn.dataset.action;
      if (action === "refresh") return refreshNodes();
      if (action === "probeAll") return probeAll();
      if (action === "export")
        return api
          .exportNodes()
          .catch((err) => (isUnauthorized(err) ? showLogin(err.message) : toast(err.message, "error")));
      if (action === "reload")
        return api
          .reloadConfig()
          .then((r) => toast(r.message || "已重载", "success"))
          .catch((err) => {
            if (isUnauthorized(err)) return showLogin(err.message);
            toast(err.message || "重载失败", "error");
          });
      if (action === "deleteFailed") {
        if (!confirm("确认删除所有探测失败的节点？（需要重载生效）")) return;
        return api
          .deleteFailedNodes()
          .then((r) => toast(r.message || `已删除 ${r.deleted ?? 0}`, "success"))
          .then(refreshNodes)
          .catch((err) => (isUnauthorized(err) ? showLogin(err.message) : toast(err.message || "删除失败", "error")));
      }
      if (action === "probeClose") return hide($("#probeOverlay"));
      if (action === "configRefresh") return loadConfigNodes();
      if (action === "configAdd") return openConfigModal(null);
      if (action === "configCancel") return closeConfigModal();
      if (action === "subSave") return saveSubscription(actionBtn);
      if (action === "subRefreshStatus") return loadSubscriptionStatus();
      if (action === "subRefreshNow") return refreshSubscriptionsNow(actionBtn);
      if (action === "settingsSave") return saveSettings(actionBtn);
      if (action === "proxyAuthSave") return saveProxyAuth(actionBtn);
      if (action === "debugRefresh") return loadDebug();
    }

    const nodeBtn = e.target.closest("[data-node-action]");
    if (nodeBtn) return handleNodeAction(nodeBtn);
  });

  $("#nodeSearch").addEventListener("input", (e) => {
    state.search = e.target.value || "";
    renderNodesTable(state.nodes);
  });

  $("#showAllNodes").addEventListener("change", async (e) => {
    state.showAllNodes = !!e.target.checked;
    savePrefs();
    await refreshNodes();
  });

  $("#autoRefresh").addEventListener("change", (e) => {
    setAutoRefresh(!!e.target.checked);
  });

  $("#darkMode").addEventListener("change", (e) => {
    setTheme(!!e.target.checked);
  });

  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const password = $("#loginPassword").value;
    const errEl = $("#loginError");
    hide(errEl);
    try {
      await api.auth(password);
      hideLogin();
      toast("登录成功", "success");
      await refreshNodes();
    } catch (err) {
      setText(errEl, err.message || "登录失败");
      show(errEl);
    }
  });

  $("#configForm").addEventListener("submit", submitConfigForm);
}

async function init() {
  loadPrefs();

  $("#autoRefresh").checked = state.autoRefresh;
  $("#showAllNodes").checked = state.showAllNodes;

  const themeToggle = $("#darkMode");
  if (state.darkMode === null) {
    themeToggle.indeterminate = true;
  } else {
    themeToggle.checked = !!state.darkMode;
    setTheme(!!state.darkMode);
  }

  wireEvents();
  setAutoRefresh(state.autoRefresh);

  await refreshNodes();
}

document.addEventListener("DOMContentLoaded", () => {
  init().catch((err) => toast(err.message || "初始化失败", "error"));
});
