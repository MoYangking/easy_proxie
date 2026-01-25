// Constants
const API_BASE = '/api';

// State
let state = {
  autoRefreshInterval: null,
  isAutoRefresh: true,
  isAuthenticated: false,
  showAllNodes: false,
  proxyAuthMode: '',
  subscriptionUrls: [],
  configNodes: [],
  isEditMode: false,
};

// --- Authentication ---

async function checkAuth() {
  try {
    const res = await fetch(`${API_BASE}/nodes`);
    if (res.status === 401) {
      showLoginModal();
      return false;
    }
    return true;
  } catch (err) {
    console.error('Check auth failed:', err);
    return false;
  }
}

async function handleLogin(event) {
  event.preventDefault();
  const password = document.getElementById('password').value;
  const loginError = document.getElementById('loginError');

  loginError.classList.remove('show');

  try {
    const res = await fetch(`${API_BASE}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });

    const data = await res.json();

    if (res.ok) {
      state.isAuthenticated = true;
      document.getElementById('loginOverlay').classList.remove('show');
      showToast('登录成功！', 'success');
      initApp();
    } else {
      loginError.textContent = data.error || '登录失败';
      loginError.classList.add('show');
    }
  } catch (err) {
    loginError.textContent = '登录失败: ' + err.message;
    loginError.classList.add('show');
  }
}

function showLoginModal() {
  document.getElementById('loginOverlay').classList.add('show');
}

// --- Dashboard / Monitor ---

async function refresh() {
  try {
    const url = state.showAllNodes ? `${API_BASE}/nodes?all=1` : `${API_BASE}/nodes`;
    const res = await fetch(url);
    
    if (res.status === 401) {
      state.isAuthenticated = false;
      showLoginModal();
      stopAutoRefresh();
      return;
    }
    
    if (!res.ok) throw new Error('请求失败');
    const data = await res.json();
    renderNodes(data.nodes || []);
    updateStats(data.nodes || []);
    document.getElementById('lastUpdate').textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN')}`;
  } catch (err) {
    showToast('刷新失败: ' + err.message, 'error');
  }
}

function updateStats(nodes) {
  document.getElementById('totalNodes').textContent = nodes.length;
  document.getElementById('healthyNodes').textContent = nodes.filter(n => !n.blacklisted && n.failure_count === 0).length;
  document.getElementById('activeConnections').textContent = nodes.reduce((sum, n) => sum + (n.active_connections || 0), 0);
  document.getElementById('blacklistedNodes').textContent = nodes.filter(n => n.blacklisted).length;
}

function renderNodes(nodes) {
  const container = document.getElementById('nodesContainer');
  const emptyState = document.getElementById('emptyState');

  if (nodes.length === 0) {
    container.innerHTML = '';
    emptyState.style.display = 'block';
    return;
  }

  emptyState.style.display = 'none';
  container.innerHTML = nodes.map(node => {
    const status = getNodeStatus(node);
    const latency = node.last_latency_ms || -1;
    const quality = getLatencyQuality(latency);

    return `
      <div class="node-card ${status}">
        <div class="node-header">
          <div class="node-info">
            <div class="node-name" title="${escapeHtml(node.name || node.tag)}">${escapeHtml(node.name || node.tag)}</div>
            <div class="node-tag">${escapeHtml(node.tag)}</div>
          </div>
          <span class="status-badge ${status}">
            <span class="status-icon"></span>
            ${getStatusText(status)}
          </span>
        </div>

        <div class="latency-display">
          <div class="latency-info">
            <div class="latency-icon">⚡</div>
            <div class="latency-text">
              <div class="latency-label">节点延迟</div>
              <div class="latency-value">${latency >= 0 ? latency : '—'}</div>
              ${latency >= 0 
                ? `<div class="latency-quality" style="color: ${quality.color}">${quality.text} · ${latency} ms</div>` 
                : '<div class="latency-quality">点击探测按钮测试延迟</div>'}
            </div>
          </div>
        </div>

        <div class="metrics">
          <div class="metric">
            <div class="metric-label">监听端口</div>
            <div class="metric-value">${node.port || '—'}</div>
          </div>
          <div class="metric">
            <div class="metric-label">活跃连接</div>
            <div class="metric-value success">${node.active_connections || 0}</div>
          </div>
          <div class="metric">
            <div class="metric-label">失败次数</div>
            <div class="metric-value ${node.failure_count > 0 ? 'error' : ''}">${node.failure_count || 0}</div>
          </div>
           <div class="metric">
            <div class="metric-label">模式</div>
            <div class="metric-value" style="font-size: 15px; text-transform: uppercase;">${node.mode || '—'}</div>
          </div>
        </div>

        <div class="node-footer">
          <div class="time-info">
            <div>✓ 最近成功: ${formatTime(node.last_success)}</div>
            <div>✗ 最近失败: ${formatTime(node.last_failure)}</div>
            ${node.blacklisted ? `<div style="color: var(--error);">⚠ 拉黑至: ${new Date(node.blacklisted_until).toLocaleString('zh-CN')}</div>` : ''}
          </div>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-secondary btn-sm" onclick="probe('${node.tag}')">
              🔍 探测
            </button>
            <button class="btn btn-secondary btn-sm" onclick="probeIP('${node.tag}')">
              🌐 IP
            </button>
            ${node.blacklisted ? `
              <button class="btn btn-primary btn-sm" onclick="release('${node.tag}')">
                解除
              </button>
            ` : ''}
             <button class="btn btn-danger btn-sm" onclick="deleteMonitorNode('${node.tag}')">
              删除
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// --- Actions ---

async function probe(tag) {
  try {
    showToast(`正在探测 ${tag}...`, 'success');
    const res = await fetch(`${API_BASE}/nodes/${encodeURIComponent(tag)}/probe`, { method: 'POST' });
    const data = await res.json();
    if (data.error) {
      showToast('探测失败: ' + data.error, 'error');
    } else {
      showToast(`探测成功！延迟: ${data.latency_ms}ms`, 'success');
    }
    setTimeout(refresh, 500);
  } catch (err) {
    showToast('探测失败: ' + err.message, 'error');
  }
}

async function probeIP(tag) {
  try {
    showToast(`正在探测 ${tag} 出口IP...`, 'success');
    const res = await fetch(`${API_BASE}/nodes/${encodeURIComponent(tag)}/probe-ip`, { method: 'POST' });
    const data = await res.json();
    if (data.error) {
      showToast('IP 探测失败: ' + data.error, 'error');
    } else {
      showToast(`IP 探测成功: ${data.ip}`, 'success');
      alert(`节点 ${tag} 的出口 IP 是:
${data.ip}`);
    }
  } catch (err) {
    showToast('IP 探测失败: ' + err.message, 'error');
  }
}

let isProbing = false;
async function probeAllNodes() {
  if (isProbing) {
    showToast('探测正在进行中...', 'error');
    return;
  }

  isProbing = true;
  const btn = document.getElementById('probeAllBtn');
  btn.disabled = true;
  btn.innerHTML = '探测中...';

  try {
    const response = await fetch(`${API_BASE}/nodes/probe-all`, { method: 'POST' });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('
');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
             if (data.type === 'complete') {
                 showToast(`批量探测完成！成功 ${data.success}，失败 ${data.failed}`, 'success');
             }
          } catch (e) {}
        }
      }
    }
  } catch (err) {
    showToast('批量探测失败: ' + err.message, 'error');
  } finally {
    isProbing = false;
    btn.disabled = false;
    btn.innerHTML = '⚡ 探测全部';
    refresh();
  }
}

async function deleteMonitorNode(tag) {
    if (!confirm(`确定删除节点 ${tag} 吗？
此操作会修改配置并自动重载。`)) return;
    try {
        const res = await fetch(`${API_BASE}/nodes/${encodeURIComponent(tag)}/delete`, { method: 'POST' });
         if (res.status === 401) {
            state.isAuthenticated = false;
            showLoginModal();
            return;
        }
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '未知错误');
        showToast(data.message, 'success');
        setTimeout(refresh, 1000);
    } catch (err) {
        showToast('删除失败: ' + err.message, 'error');
    }
}

async function release(tag) {
  try {
    const res = await fetch(`${API_BASE}/nodes/${encodeURIComponent(tag)}/release`, { method: 'POST' });
    const data = await res.json();
    if (data.error) {
      showToast('释放失败: ' + data.error, 'error');
    } else {
      showToast('已解除节点拉黑', 'success');
    }
    setTimeout(refresh, 500);
  } catch (err) {
    showToast('释放失败: ' + err.message, 'error');
  }
}

async function exportNodes() {
    try {
        const res = await fetch(`${API_BASE}/export`);
        if (res.status === 401) {
             showLoginModal();
             return;
        }
        if (!res.ok) throw new Error('导出失败');
        
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'nodes.txt';
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        showToast('导出成功', 'success');
    } catch(err) {
        showToast('导出失败: ' + err.message, 'error');
    }
}

async function deleteFailedNodes() {
     try {
        const res = await fetch(`${API_BASE}/nodes?all=1`);
         if (res.status === 401) {
             showLoginModal();
             return;
         }
        const data = await res.json();
        const failed = (data.nodes || []).filter(n => n.initial_check_done && n.available === false);
        
        if (failed.length === 0) {
            showToast('没有探测失败的节点', 'success');
            return;
        }

        if (!confirm(`确定删除 ${failed.length} 个失败节点吗？`)) return;
        
        const delRes = await fetch(`${API_BASE}/nodes/delete-failed`, { method: 'POST' });
        const delData = await delRes.json();
        
        if (!delRes.ok) throw new Error(delData.error || '删除失败');
        showToast(delData.message, 'success');
        setTimeout(refresh, 1000);
     } catch(err) {
         showToast('操作失败: ' + err.message, 'error');
     }
}

// --- Utils ---

function formatTime(timeStr) {
  if (!timeStr || timeStr === '0001-01-01T00:00:00Z') return '从未';
  const date = new Date(timeStr);
  const now = new Date();
  const diff = Math.floor((now - date) / 1000);
  if (diff < 60) return `${diff}秒前`;
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
  return `${Math.floor(diff / 86400)}天前`;
}

function getLatencyQuality(ms) {
  if (ms < 0) return { text: '未测试', color: 'var(--text-secondary)' };
  if (ms < 100) return { text: '优秀', color: 'var(--success)' };
  if (ms < 200) return { text: '良好', color: 'var(--primary)' };
  if (ms < 500) return { text: '一般', color: 'var(--warning)' };
  return { text: '较慢', color: 'var(--error)' };
}

function getNodeStatus(node) {
  if (node.blacklisted) return 'blacklisted';
  if (node.initial_check_done && node.available === false) return 'unavailable';
  if (node.failure_count >= 2) return 'error';
  if (node.failure_count >= 1) return 'warning';
  return 'healthy';
}

function getStatusText(status) {
  const map = {
    'unavailable': '不可用',
    'healthy': '健康',
    'warning': '警告',
    'error': '异常',
    'blacklisted': '已拉黑'
  };
  return map[status] || '未知';
}

function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  const toastMessage = document.getElementById('toastMessage');
  
  toast.className = `toast ${type} show`;
  toastMessage.textContent = message;
  
  setTimeout(() => toast.classList.remove('show'), 3000);
}

function toggleAutoRefresh() {
  state.isAutoRefresh = !state.isAutoRefresh;
  const btn = document.getElementById('autoRefreshText');
  if (state.isAutoRefresh) {
    btn.textContent = '关闭自动刷新';
    startAutoRefresh();
    showToast('已开启自动刷新', 'success');
  } else {
    btn.textContent = '开启自动刷新';
    stopAutoRefresh();
    showToast('已关闭自动刷新', 'success');
  }
}

function startAutoRefresh() {
  if (state.autoRefreshInterval) return;
  state.autoRefreshInterval = setInterval(refresh, 5000);
}

function stopAutoRefresh() {
  if (state.autoRefreshInterval) {
    clearInterval(state.autoRefreshInterval);
    state.autoRefreshInterval = null;
  }
}

function toggleShowAllNodes() {
  state.showAllNodes = !state.showAllNodes;
  localStorage.setItem('showAllNodes', state.showAllNodes ? '1' : '0');
  document.getElementById('showAllText').textContent = state.showAllNodes ? '仅显示可用节点' : '显示全部节点';
  refresh();
}

// --- Tabs ---

function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

  const tabBtn = document.querySelector(`.tab[data-tab="${tabName}"]`);
  if (tabBtn) tabBtn.classList.add('active');
  
  const content = document.getElementById(tabName + 'Tab');
  if (content) content.classList.add('active');

  // Load specific tab data
  if (tabName === 'manage') loadConfigNodes();
  // Add other tab loads here if needed
}

// --- Node Management (Simplified) ---

async function loadConfigNodes() {
    try {
        const res = await fetch(`${API_BASE}/nodes/config`);
         if (res.status === 401) {
             showLoginModal();
             return;
         }
        const data = await res.json();
        state.configNodes = data.nodes || [];
        renderConfigNodes();
    } catch (err) {
        showToast('加载配置节点失败', 'error');
    }
}

function renderConfigNodes() {
    const container = document.getElementById('configNodesContainer');
    const emptyState = document.getElementById('configEmptyState');
    
    if (state.configNodes.length === 0) {
        container.innerHTML = '';
        emptyState.style.display = 'block';
        return;
    }
    
    emptyState.style.display = 'none';
    container.innerHTML = state.configNodes.map((node, index) => `
        <div class="config-node-card">
            <div class="config-node-info">
                <div class="config-node-name">${escapeHtml(node.name)}</div>
                <div class="config-node-uri" title="${escapeHtml(node.uri)}">${escapeHtml(node.uri)}</div>
                 ${node.port ? `<div class="config-node-port">端口: ${node.port}</div>` : ''}
            </div>
            <div class="config-node-actions">
                <button class="btn btn-secondary btn-sm" onclick="showEditNodeModal('${node.name}')">✏️ 编辑</button>
                <button class="btn btn-danger btn-sm" onclick="deleteNode('${node.name}')">🗑️ 删除</button>
            </div>
        </div>
    `).join('');
}

function showAddNodeModal() {
    state.isEditMode = false;
    document.getElementById('nodeModalTitle').textContent = '➕ 添加节点';
    document.getElementById('nodeSubmitBtn').textContent = '添加';
    document.getElementById('nodeForm').reset();
    document.getElementById('nodeModalOverlay').classList.add('show');
}

function showEditNodeModal(name) {
    const node = state.configNodes.find(n => n.name === name);
    if (!node) return;
    
    state.isEditMode = true;
    document.getElementById('nodeModalTitle').textContent = '✏️ 编辑节点';
    document.getElementById('nodeSubmitBtn').textContent = '保存';
    
    document.getElementById('nodeName').value = node.name;
    document.getElementById('nodeUri').value = node.uri;
    document.getElementById('nodePort').value = node.port || '';
    document.getElementById('nodeEditName').value = name;
    
    document.getElementById('nodeModalOverlay').classList.add('show');
}

function hideNodeModal() {
    document.getElementById('nodeModalOverlay').classList.remove('show');
}

async function handleNodeSubmit(event) {
    event.preventDefault();
    const payload = {
        name: document.getElementById('nodeName').value.trim(),
        uri: document.getElementById('nodeUri').value.trim(),
        port: parseInt(document.getElementById('nodePort').value) || 0
    };
    
    try {
        let res;
        if (state.isEditMode) {
             const editName = document.getElementById('nodeEditName').value;
             res = await fetch(`${API_BASE}/nodes/config/${encodeURIComponent(editName)}`, {
                 method: 'PUT',
                 headers: {'Content-Type': 'application/json'},
                 body: JSON.stringify(payload)
             });
        } else {
            res = await fetch(`${API_BASE}/nodes/config`, {
                 method: 'POST',
                 headers: {'Content-Type': 'application/json'},
                 body: JSON.stringify(payload)
             });
        }
        
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        
        hideNodeModal();
        showToast(data.message, 'success');
        loadConfigNodes();
    } catch(err) {
        showToast(err.message, 'error');
    }
}

async function deleteNode(name) {
    if (!confirm(`确定删除节点 ${name} 吗？`)) return;
    try {
        const res = await fetch(`${API_BASE}/nodes/config/${encodeURIComponent(name)}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        showToast(data.message, 'success');
        loadConfigNodes();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function triggerReload() {
    if (!confirm('确定重载配置吗？会中断现有连接。')) return;
    try {
        const res = await fetch(`${API_BASE}/reload`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        showToast(data.message, 'success');
        setTimeout(() => {
            refresh();
            loadConfigNodes();
        }, 1500);
    } catch(err) {
        showToast(err.message, 'error');
    }
}

function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/"/g, """)
    .replace(/'/g, "&#039;");
}

// --- Init ---

function initApp() {
    const savedShowAll = localStorage.getItem('showAllNodes');
    state.showAllNodes = savedShowAll === '1';
    document.getElementById('showAllText').textContent = state.showAllNodes ? '仅显示可用节点' : '显示全部节点';
    
    refresh();
    startAutoRefresh();
}

(async function init() {
    // Basic event listeners
    document.querySelectorAll('.tab').forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
    
    // Auth check
    const authenticated = await checkAuth();
    if (authenticated) {
        state.isAuthenticated = true;
        initApp();
    }
})();
