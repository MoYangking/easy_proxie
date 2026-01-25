package monitor

import (
	"context"
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"easy_proxies/internal/config"
)

//go:embed assets/*
var embeddedFS embed.FS

// NodeManager exposes config node CRUD and reload operations.
type NodeManager interface {
	ListConfigNodes(ctx context.Context) ([]config.NodeConfig, error)
	CreateNode(ctx context.Context, node config.NodeConfig) (config.NodeConfig, error)
	UpdateNode(ctx context.Context, name string, node config.NodeConfig) (config.NodeConfig, error)
	DeleteNode(ctx context.Context, name string) error
	TriggerReload(ctx context.Context) error

	// ConfigSnapshot returns a copy of current config for read-only use.
	ConfigSnapshot(ctx context.Context) (*config.Config, error)
	// UpdateSubscriptionConfig persists subscription list and refresh settings.
	UpdateSubscriptionConfig(ctx context.Context, subscriptions []string, refresh config.SubscriptionRefreshConfig) error
	// RefreshSubscriptions performs a one-shot subscription fetch + reload.
	RefreshSubscriptions(ctx context.Context) (int, error)
}

// Sentinel errors for node operations.
var (
	ErrNodeNotFound = errors.New("节点不存在")
	ErrNodeConflict = errors.New("节点名称或端口已存在")
	ErrInvalidNode  = errors.New("无效的节点配置")
)

// SubscriptionRefresher interface for subscription manager.
type SubscriptionRefresher interface {
	RefreshNow() error
	Status() SubscriptionStatus
}

// SubscriptionStatus represents subscription refresh status.
type SubscriptionStatus struct {
	LastRefresh   time.Time `json:"last_refresh"`
	NextRefresh   time.Time `json:"next_refresh"`
	NodeCount     int       `json:"node_count"`
	LastError     string    `json:"last_error,omitempty"`
	RefreshCount  int       `json:"refresh_count"`
	IsRefreshing  bool      `json:"is_refreshing"`
	NodesModified bool      `json:"nodes_modified"` // True if nodes.txt was modified since last refresh
}

// Server exposes HTTP endpoints for monitoring.
type Server struct {
	cfg          Config
	cfgMu        sync.RWMutex   // 保护动态配置字段
	cfgSrc       *config.Config // 可持久化的配置对象
	mgr          *Manager
	srv          *http.Server
	logger       *log.Logger
	sessionToken string // 简单的 session token，重启后失效
	subRefresher SubscriptionRefresher
	nodeMgr      NodeManager

	subMu     sync.RWMutex
	subStatus SubscriptionStatus // subRefresher 不存在时的手动刷新状态
}

// NewServer constructs a server; it can be nil when disabled.
func NewServer(cfg Config, mgr *Manager, logger *log.Logger) *Server {
	if !cfg.Enabled || mgr == nil {
		return nil
	}
	if logger == nil {
		logger = log.Default()
	}
	s := &Server{cfg: cfg, mgr: mgr, logger: logger}

	// 生成随机 session token
	tokenBytes := make([]byte, 32)
	rand.Read(tokenBytes)
	s.sessionToken = hex.EncodeToString(tokenBytes)

	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleIndex)
	mux.HandleFunc("/api/auth", s.handleAuth)
	mux.HandleFunc("/api/settings", s.withAuth(s.handleSettings))
	mux.HandleFunc("/api/proxy/auth", s.withAuth(s.handleProxyAuth))
	mux.HandleFunc("/api/nodes", s.withAuth(s.handleNodes))
	mux.HandleFunc("/api/nodes/config", s.withAuth(s.handleConfigNodes))
	mux.HandleFunc("/api/nodes/config/", s.withAuth(s.handleConfigNodeItem))
	mux.HandleFunc("/api/nodes/probe-all", s.withAuth(s.handleProbeAll))
	mux.HandleFunc("/api/nodes/delete-failed", s.withAuth(s.handleDeleteFailedNodes))
	mux.HandleFunc("/api/nodes/", s.withAuth(s.handleNodeAction))
	mux.HandleFunc("/api/debug", s.withAuth(s.handleDebug))
	mux.HandleFunc("/api/export", s.withAuth(s.handleExport))
	mux.HandleFunc("/api/subscription/config", s.withAuth(s.handleSubscriptionConfig))
	mux.HandleFunc("/api/subscription/status", s.withAuth(s.handleSubscriptionStatus))
	mux.HandleFunc("/api/subscription/refresh", s.withAuth(s.handleSubscriptionRefresh))
	mux.HandleFunc("/api/reload", s.withAuth(s.handleReload))
	s.srv = &http.Server{Addr: cfg.Listen, Handler: mux}
	return s
}

// SetSubscriptionRefresher sets the subscription refresher for API endpoints.
func (s *Server) SetSubscriptionRefresher(sr SubscriptionRefresher) {
	if s != nil {
		s.subRefresher = sr
	}
}

// SetNodeManager enables config-node CRUD endpoints.
func (s *Server) SetNodeManager(nm NodeManager) {
	if s != nil {
		s.nodeMgr = nm
	}
}

// SetConfig binds the persistable config object for settings API.
func (s *Server) SetConfig(cfg *config.Config) {
	if s == nil {
		return
	}
	s.cfgMu.Lock()
	defer s.cfgMu.Unlock()
	s.cfgSrc = cfg
	if cfg != nil {
		proxyUsername := cfg.Listener.Username
		proxyPassword := cfg.Listener.Password
		if cfg.Mode == "multi-port" || cfg.Mode == "hybrid" {
			proxyUsername = cfg.MultiPort.Username
			proxyPassword = cfg.MultiPort.Password
		}
		s.cfg.ExternalIP = cfg.ExternalIP
		s.cfg.ProbeTarget = cfg.Management.ProbeTarget
		s.cfg.SkipCertVerify = cfg.SkipCertVerify
		s.cfg.ProxyUsername = proxyUsername
		s.cfg.ProxyPassword = proxyPassword
	}
}

// getSettings returns current dynamic settings (thread-safe).
func (s *Server) getSettings() (externalIP, probeTarget string, skipCertVerify bool) {
	s.cfgMu.RLock()
	defer s.cfgMu.RUnlock()
	return s.cfg.ExternalIP, s.cfg.ProbeTarget, s.cfg.SkipCertVerify
}

// updateSettings updates dynamic settings and persists to config file.
func (s *Server) updateSettings(externalIP, probeTarget string, skipCertVerify bool, poolMode *string) error {
	s.cfgMu.Lock()
	defer s.cfgMu.Unlock()

	s.cfg.ExternalIP = externalIP
	s.cfg.ProbeTarget = probeTarget
	s.cfg.SkipCertVerify = skipCertVerify

	if s.cfgSrc == nil {
		return errors.New("配置存储未初始化")
	}

	s.cfgSrc.ExternalIP = externalIP
	s.cfgSrc.Management.ProbeTarget = probeTarget
	s.cfgSrc.SkipCertVerify = skipCertVerify
	if poolMode != nil {
		s.cfgSrc.Pool.Mode = *poolMode
	}

	if err := s.cfgSrc.SaveSettings(); err != nil {
		return fmt.Errorf("保存配置失败: %w", err)
	}
	return nil
}

// Start launches the HTTP server.
func (s *Server) Start(ctx context.Context) {
	if s == nil || s.srv == nil {
		return
	}
	s.logger.Printf("Starting monitor server on %s", s.cfg.Listen)
	go func() {
		if err := s.srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			s.logger.Printf("❌ Monitor server error: %v", err)
		}
	}()
	// Give server a moment to start and check for immediate errors
	time.Sleep(100 * time.Millisecond)
	s.logger.Printf("✅ Monitor server started on http://%s", s.cfg.Listen)

	go func() {
		<-ctx.Done()
		s.Shutdown(context.Background())
	}()
}

// Shutdown stops the server gracefully.
func (s *Server) Shutdown(ctx context.Context) {
	if s == nil || s.srv == nil {
		return
	}
	_ = s.srv.Shutdown(ctx)
}

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	if path == "/" {
		path = "/index.html"
	}

	// Remove leading slash
	path = strings.TrimPrefix(path, "/")

	// Prevent directory traversal
	if strings.Contains(path, "..") {
		http.NotFound(w, r)
		return
	}

	// Try to read from assets/
	fullPath := "assets/" + path
	data, err := embeddedFS.ReadFile(fullPath)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			http.NotFound(w, r)
			return
		}
		s.logger.Printf("Error reading asset %s: %v", fullPath, err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}

	// Detect content type
	switch {
	case strings.HasSuffix(path, ".css"):
		w.Header().Set("Content-Type", "text/css; charset=utf-8")
	case strings.HasSuffix(path, ".js"):
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
	case strings.HasSuffix(path, ".html"):
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
	case strings.HasSuffix(path, ".png"):
		w.Header().Set("Content-Type", "image/png")
	case strings.HasSuffix(path, ".svg"):
		w.Header().Set("Content-Type", "image/svg+xml")
	case strings.HasSuffix(path, ".ico"):
		w.Header().Set("Content-Type", "image/x-icon")
	}

	_, _ = w.Write(data)
}

func (s *Server) handleNodes(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	// 只返回初始检查通过的可用节点
	all := queryBool(r.URL.Query().Get("all"), false)
	var nodes []Snapshot
	if all {
		nodes = s.mgr.Snapshot()
	} else {
		nodes = s.mgr.SnapshotFiltered(true)
	}
	payload := map[string]any{"nodes": nodes}
	writeJSON(w, payload)
}

func (s *Server) handleDeleteFailedNodes(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if !s.ensureNodeManager(w) {
		return
	}

	snapshots := s.mgr.Snapshot()
	failed := make([]Snapshot, 0)
	for _, snap := range snapshots {
		if !snap.InitialCheckDone || snap.Available {
			continue
		}
		if strings.TrimSpace(snap.Name) == "" {
			continue
		}
		failed = append(failed, snap)
	}

	if len(failed) == 0 {
		writeJSON(w, map[string]any{
			"deleted":      0,
			"total_failed": 0,
			"message":      "没有探测失败的节点",
		})
		return
	}

	deletedNames := make([]string, 0, len(failed))
	deleteErrors := make([]string, 0)
	for _, snap := range failed {
		if err := s.nodeMgr.DeleteNode(r.Context(), snap.Name); err != nil {
			deleteErrors = append(deleteErrors, fmt.Sprintf("%s: %v", snap.Name, err))
			continue
		}
		deletedNames = append(deletedNames, snap.Name)
	}

	if len(deletedNames) == 0 {
		w.WriteHeader(http.StatusInternalServerError)
		writeJSON(w, map[string]any{
			"deleted":      0,
			"total_failed": len(failed),
			"errors":       deleteErrors,
			"error":        "删除失败",
		})
		return
	}

	reload := queryBool(r.URL.Query().Get("reload"), true)
	if reload {
		if err := s.nodeMgr.TriggerReload(r.Context()); err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			writeJSON(w, map[string]any{
				"deleted":       len(deletedNames),
				"total_failed":  len(failed),
				"deleted_nodes": deletedNames,
				"errors":        deleteErrors,
				"error":         fmt.Sprintf("删除成功，但重载失败: %v", err),
			})
			return
		}
	}

	message := fmt.Sprintf("已删除 %d 个探测失败节点", len(deletedNames))
	if reload {
		message += "，并已重载生效"
	} else {
		message += "，请点击重载使配置生效"
	}
	writeJSON(w, map[string]any{
		"deleted":       len(deletedNames),
		"total_failed":  len(failed),
		"deleted_nodes": deletedNames,
		"errors":        deleteErrors,
		"message":       message,
	})
}

func (s *Server) handleDebug(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	snapshots := s.mgr.Snapshot()
	var totalCalls, totalSuccess int64
	debugNodes := make([]map[string]any, 0, len(snapshots))
	for _, snap := range snapshots {
		totalCalls += snap.SuccessCount + int64(snap.FailureCount)
		totalSuccess += snap.SuccessCount
		debugNodes = append(debugNodes, map[string]any{
			"tag":                snap.Tag,
			"name":               snap.Name,
			"mode":               snap.Mode,
			"port":               snap.Port,
			"failure_count":      snap.FailureCount,
			"success_count":      snap.SuccessCount,
			"active_connections": snap.ActiveConnections,
			"last_latency_ms":    snap.LastLatencyMs,
			"last_success":       snap.LastSuccess,
			"last_failure":       snap.LastFailure,
			"last_error":         snap.LastError,
			"blacklisted":        snap.Blacklisted,
			"timeline":           snap.Timeline,
		})
	}
	var successRate float64
	if totalCalls > 0 {
		successRate = float64(totalSuccess) / float64(totalCalls) * 100
	}
	writeJSON(w, map[string]any{
		"nodes":         debugNodes,
		"total_calls":   totalCalls,
		"total_success": totalSuccess,
		"success_rate":  successRate,
	})
}

func (s *Server) handleNodeAction(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/nodes/"), "/")
	if len(parts) < 1 {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	tag := parts[0]
	if tag == "" {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	action := ""
	if len(parts) > 1 {
		action = parts[1]
	}
	switch action {
	case "probe":
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		latency, err := s.mgr.Probe(ctx, tag)
		if err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		latencyMs := latency.Milliseconds()
		if latencyMs == 0 && latency > 0 {
			latencyMs = 1 // Round up sub-millisecond latencies to 1ms
		}
		writeJSON(w, map[string]any{"message": "探测成功", "latency_ms": latencyMs})
	case "probe-ip":
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		ip, err := s.mgr.ProbeIP(ctx, tag)
		if err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, map[string]any{"message": "探测成功", "ip": ip})
	case "delete":
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if !s.ensureNodeManager(w) {
			return
		}
		e, err := s.mgr.entry(tag)
		if err != nil {
			w.WriteHeader(http.StatusNotFound)
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		e.mu.RLock()
		nodeName := strings.TrimSpace(e.info.Name)
		e.mu.RUnlock()
		if nodeName == "" {
			w.WriteHeader(http.StatusBadRequest)
			writeJSON(w, map[string]any{"error": "missing node name"})
			return
		}
		if err := s.nodeMgr.DeleteNode(r.Context(), nodeName); err != nil {
			s.respondNodeError(w, err)
			return
		}
		if err := s.nodeMgr.TriggerReload(r.Context()); err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			writeJSON(w, map[string]any{"error": fmt.Sprintf("节点已删除，但重载失败: %v", err)})
			return
		}
		writeJSON(w, map[string]any{"message": "节点已删除并已重载生效"})
	case "release":
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if err := s.mgr.Release(tag); err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, map[string]any{"message": "已解除拉黑"})
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

// handleProbeAll probes all nodes in batches and returns results via SSE
func (s *Server) handleProbeAll(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	// Set SSE headers
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "SSE not supported", http.StatusInternalServerError)
		return
	}

	// Get all nodes
	snapshots := s.mgr.Snapshot()
	total := len(snapshots)
	if total == 0 {
		fmt.Fprintf(w, "data: %s\n\n", `{"type":"complete","total":0,"success":0,"failed":0}`)
		flusher.Flush()
		return
	}

	// Send start event
	fmt.Fprintf(w, "data: %s\n\n", fmt.Sprintf(`{"type":"start","total":%d}`, total))
	flusher.Flush()

	// Probe all nodes concurrently
	type probeResult struct {
		tag     string
		name    string
		latency int64
		err     string
	}
	results := make(chan probeResult, total)

	// Launch all probes concurrently
	for _, snap := range snapshots {
		go func(snap Snapshot, mgr *Manager) {
			ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
			defer cancel()
			latency, err := mgr.Probe(ctx, snap.Tag)
			if err != nil {
				results <- probeResult{tag: snap.Tag, name: snap.Name, latency: -1, err: err.Error()}
			} else {
				results <- probeResult{tag: snap.Tag, name: snap.Name, latency: latency.Milliseconds(), err: ""}
			}
		}(snap, s.mgr)
	}

	// Collect results as they come in with overall timeout
	successCount := 0
	failedCount := 0
	timeout := time.After(30 * time.Second) // Overall timeout for all probes

	for i := 0; i < total; i++ {
		select {
		case result := <-results:
			if result.err != "" {
				failedCount++
			} else {
				successCount++
			}
			current := successCount + failedCount
			progress := float64(current) / float64(total) * 100
			eventData := fmt.Sprintf(`{"type":"progress","tag":"%s","name":"%s","latency":%d,"error":"%s","current":%d,"total":%d,"progress":%.1f}`,
				result.tag, result.name, result.latency, result.err, current, total, progress)
			fmt.Fprintf(w, "data: %s\n\n", eventData)
			flusher.Flush()
		case <-timeout:
			// Overall timeout reached, report remaining nodes as timed out
			remaining := total - (successCount + failedCount)
			for j := 0; j < remaining; j++ {
				failedCount++
				current := successCount + failedCount
				progress := float64(current) / float64(total) * 100
				eventData := fmt.Sprintf(`{"type":"progress","tag":"unknown","name":"超时节点","latency":-1,"error":"overall timeout","current":%d,"total":%d,"progress":%.1f}`,
					current, total, progress)
				fmt.Fprintf(w, "data: %s\n\n", eventData)
				flusher.Flush()
			}
			goto complete
		}
	}

complete:

	// Send complete event
	fmt.Fprintf(w, "data: %s\n\n", fmt.Sprintf(`{"type":"complete","total":%d,"success":%d,"failed":%d}`, total, successCount, failedCount))
	flusher.Flush()
}

func writeJSON(w http.ResponseWriter, payload any) {
	w.Header().Set("Content-Type", "application/json")
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(payload)
}

// queryBool parses typical boolean query parameter values.
func queryBool(raw string, defaultValue bool) bool {
	value := strings.ToLower(strings.TrimSpace(raw))
	if value == "" {
		return defaultValue
	}
	switch value {
	case "1", "true", "t", "yes", "y", "on":
		return true
	case "0", "false", "f", "no", "n", "off":
		return false
	default:
		return defaultValue
	}
}

// withAuth 认证中间件，如果配置了密码则需要验证
func (s *Server) withAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// 如果没有配置密码，直接放行
		if s.cfg.Password == "" {
			next(w, r)
			return
		}

		// 检查 Cookie 中的 session token
		cookie, err := r.Cookie("session_token")
		if err == nil && cookie.Value == s.sessionToken {
			next(w, r)
			return
		}

		// 检查 Authorization header (Bearer token)
		authHeader := r.Header.Get("Authorization")
		if authHeader != "" {
			token := strings.TrimPrefix(authHeader, "Bearer ")
			if token == s.sessionToken {
				next(w, r)
				return
			}
		}

		// 未授权
		w.WriteHeader(http.StatusUnauthorized)
		writeJSON(w, map[string]any{"error": "未授权，请先登录"})
	}
}

// handleAuth 处理登录认证
func (s *Server) handleAuth(w http.ResponseWriter, r *http.Request) {
	// 如果没有配置密码，直接返回成功（不需要token）
	if s.cfg.Password == "" {
		writeJSON(w, map[string]any{"message": "无需密码", "no_password": true})
		return
	}

	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Password string `json:"password"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		writeJSON(w, map[string]any{"error": "请求格式错误"})
		return
	}

	// 验证密码
	if req.Password != s.cfg.Password {
		w.WriteHeader(http.StatusUnauthorized)
		writeJSON(w, map[string]any{"error": "密码错误"})
		return
	}

	// 设置 cookie
	http.SetCookie(w, &http.Cookie{
		Name:     "session_token",
		Value:    s.sessionToken,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   86400 * 7, // 7天
	})

	writeJSON(w, map[string]any{
		"message": "登录成功",
		"token":   s.sessionToken,
	})
}

// handleExport 导出所有可用代理池节点的 HTTP 代理 URI，每行一个
// 在 hybrid 模式下，只导出 multi-port 格式（每节点独立端口）
func (s *Server) handleExport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	// 只导出初始检查通过的可用节点
	snapshots := s.mgr.SnapshotFiltered(true)
	var lines []string

	for _, snap := range snapshots {
		// 只导出有监听地址和端口的节点
		if snap.ListenAddress == "" || snap.Port == 0 {
			continue
		}

		// 在 hybrid 和 multi-port 模式下，导出每节点独立端口
		// 在 pool 模式下，所有节点共享同一端口，也正常导出
		listenAddr := snap.ListenAddress
		if listenAddr == "0.0.0.0" || listenAddr == "::" {
			if extIP, _, _ := s.getSettings(); extIP != "" {
				listenAddr = extIP
			}
		}

		var proxyURI string
		if s.cfg.ProxyUsername != "" && s.cfg.ProxyPassword != "" {
			proxyURI = fmt.Sprintf("http://%s:%s@%s:%d",
				s.cfg.ProxyUsername, s.cfg.ProxyPassword,
				listenAddr, snap.Port)
		} else {
			proxyURI = fmt.Sprintf("http://%s:%d", listenAddr, snap.Port)
		}
		lines = append(lines, proxyURI)
	}

	// 返回纯文本，每行一个 URI
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Content-Disposition", "attachment; filename=proxy_pool.txt")
	_, _ = w.Write([]byte(strings.Join(lines, "\n")))
}

// handleSettings handles GET/PUT for dynamic settings (external_ip, probe_target, skip_cert_verify).
func (s *Server) handleSettings(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		extIP, probeTarget, skipCertVerify := s.getSettings()
		var mode string
		var poolMode string
		s.cfgMu.RLock()
		if s.cfgSrc != nil {
			mode = s.cfgSrc.Mode
			poolMode = s.cfgSrc.Pool.Mode
		}
		s.cfgMu.RUnlock()
		writeJSON(w, map[string]any{
			"mode":             mode,
			"external_ip":      extIP,
			"probe_target":     probeTarget,
			"skip_cert_verify": skipCertVerify,
			"pool_mode":        poolMode,
		})
	case http.MethodPut:
		var req struct {
			ExternalIP     string  `json:"external_ip"`
			ProbeTarget    string  `json:"probe_target"`
			SkipCertVerify bool    `json:"skip_cert_verify"`
			PoolMode       *string `json:"pool_mode,omitempty"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			writeJSON(w, map[string]any{"error": "请求格式错误"})
			return
		}

		extIP := strings.TrimSpace(req.ExternalIP)
		probeTarget := strings.TrimSpace(req.ProbeTarget)

		var poolMode *string
		if req.PoolMode != nil {
			val := strings.ToLower(strings.TrimSpace(*req.PoolMode))
			switch val {
			case "", "sequential":
				val = "sequential"
			case "random":
				val = "random"
			case "balance":
				val = "balance"
			default:
				w.WriteHeader(http.StatusBadRequest)
				writeJSON(w, map[string]any{"error": "pool_mode 只支持 sequential/random/balance"})
				return
			}
			poolMode = &val
		}

		if err := s.updateSettings(extIP, probeTarget, req.SkipCertVerify, poolMode); err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		var currentPoolMode string
		s.cfgMu.RLock()
		if s.cfgSrc != nil {
			currentPoolMode = s.cfgSrc.Pool.Mode
		}
		s.cfgMu.RUnlock()

		writeJSON(w, map[string]any{
			"message":          "设置已保存",
			"external_ip":      extIP,
			"probe_target":     probeTarget,
			"skip_cert_verify": req.SkipCertVerify,
			"pool_mode":        currentPoolMode,
			"need_reload":      true,
		})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

type proxyAuthSection struct {
	Enabled  *bool   `json:"enabled,omitempty"`
	Username *string `json:"username,omitempty"`
	Password *string `json:"password,omitempty"`
}

type proxyAuthRequest struct {
	Listener  *proxyAuthSection `json:"listener,omitempty"`
	MultiPort *proxyAuthSection `json:"multi_port,omitempty"`
	Reload    *bool             `json:"reload,omitempty"`
}

func applyProxyAuthSection(req *proxyAuthSection, username, password *string) error {
	if req == nil || username == nil || password == nil {
		return nil
	}
	// No changes.
	if req.Enabled == nil && req.Username == nil && req.Password == nil {
		return nil
	}

	// Explicitly disabled: clear credentials.
	if req.Enabled != nil && !*req.Enabled {
		*username = ""
		*password = ""
		return nil
	}

	currentUsername := strings.TrimSpace(*username)
	currentPassword := *password

	nextUsername := currentUsername
	if req.Username != nil {
		nextUsername = strings.TrimSpace(*req.Username)
	}

	nextPassword := currentPassword
	if req.Password != nil {
		if strings.TrimSpace(*req.Password) != "" {
			nextPassword = *req.Password
		}
	}

	enabled := nextUsername != ""
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	if !enabled {
		*username = ""
		*password = ""
		return nil
	}

	wasEnabled := currentUsername != ""
	if nextUsername == "" {
		return errors.New("启用代理认证时用户名不能为空")
	}
	if !wasEnabled && strings.TrimSpace(nextPassword) == "" {
		return errors.New("启用代理认证时密码不能为空")
	}

	*username = nextUsername
	*password = nextPassword
	return nil
}

func (s *Server) handleProxyAuth(w http.ResponseWriter, r *http.Request) {
	if !s.ensureNodeManager(w) {
		return
	}

	switch r.Method {
	case http.MethodGet:
		cfg, err := s.nodeMgr.ConfigSnapshot(r.Context())
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		if cfg == nil {
			w.WriteHeader(http.StatusServiceUnavailable)
			writeJSON(w, map[string]any{"error": "配置未初始化"})
			return
		}

		listenerEnabled := strings.TrimSpace(cfg.Listener.Username) != ""
		multiPortEnabled := strings.TrimSpace(cfg.MultiPort.Username) != ""
		writeJSON(w, map[string]any{
			"mode": cfg.Mode,
			"listener": map[string]any{
				"enabled":      listenerEnabled,
				"username":     cfg.Listener.Username,
				"has_password": strings.TrimSpace(cfg.Listener.Password) != "",
			},
			"multi_port": map[string]any{
				"enabled":      multiPortEnabled,
				"username":     cfg.MultiPort.Username,
				"has_password": strings.TrimSpace(cfg.MultiPort.Password) != "",
			},
		})
	case http.MethodPut:
		var req proxyAuthRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			writeJSON(w, map[string]any{"error": "请求格式错误"})
			return
		}

		reload := false
		if req.Reload != nil {
			reload = *req.Reload
		}

		s.cfgMu.Lock()
		cfg := s.cfgSrc
		if cfg == nil {
			s.cfgMu.Unlock()
			w.WriteHeader(http.StatusServiceUnavailable)
			writeJSON(w, map[string]any{"error": "配置存储未初始化"})
			return
		}

		if err := applyProxyAuthSection(req.Listener, &cfg.Listener.Username, &cfg.Listener.Password); err != nil {
			s.cfgMu.Unlock()
			w.WriteHeader(http.StatusBadRequest)
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		if err := applyProxyAuthSection(req.MultiPort, &cfg.MultiPort.Username, &cfg.MultiPort.Password); err != nil {
			s.cfgMu.Unlock()
			w.WriteHeader(http.StatusBadRequest)
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}

		proxyUsername := cfg.Listener.Username
		proxyPassword := cfg.Listener.Password
		if cfg.Mode == "multi-port" || cfg.Mode == "multi_port" || cfg.Mode == "hybrid" {
			proxyUsername = cfg.MultiPort.Username
			proxyPassword = cfg.MultiPort.Password
		}
		s.cfg.ProxyUsername = proxyUsername
		s.cfg.ProxyPassword = proxyPassword

		if err := cfg.SaveSettings(); err != nil {
			s.cfgMu.Unlock()
			w.WriteHeader(http.StatusInternalServerError)
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		s.cfgMu.Unlock()

		if reload {
			if err := s.nodeMgr.TriggerReload(r.Context()); err != nil {
				w.WriteHeader(http.StatusInternalServerError)
				writeJSON(w, map[string]any{"error": fmt.Sprintf("设置已保存，但重载失败: %v", err), "need_reload": true})
				return
			}
			writeJSON(w, map[string]any{"message": "代理认证设置已保存并已重载生效", "need_reload": false})
			return
		}

		writeJSON(w, map[string]any{"message": "代理认证设置已保存，请点击重载使配置生效", "need_reload": true})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

// handleSubscriptionConfig returns/updates subscription URLs and refresh settings.
func (s *Server) handleSubscriptionConfig(w http.ResponseWriter, r *http.Request) {
	if !s.ensureNodeManager(w) {
		return
	}

	switch r.Method {
	case http.MethodGet:
		cfg, err := s.nodeMgr.ConfigSnapshot(r.Context())
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		if cfg == nil {
			w.WriteHeader(http.StatusServiceUnavailable)
			writeJSON(w, map[string]any{"error": "配置未初始化"})
			return
		}

		writeJSON(w, map[string]any{
			"subscriptions": cfg.Subscriptions,
			"subscription_refresh": map[string]any{
				"enabled":              cfg.SubscriptionRefresh.Enabled,
				"interval":             cfg.SubscriptionRefresh.Interval.String(),
				"timeout":              cfg.SubscriptionRefresh.Timeout.String(),
				"health_check_timeout": cfg.SubscriptionRefresh.HealthCheckTimeout.String(),
				"drain_timeout":        cfg.SubscriptionRefresh.DrainTimeout.String(),
				"min_available_nodes":  cfg.SubscriptionRefresh.MinAvailableNodes,
			},
		})
	case http.MethodPut:
		type refreshReq struct {
			Enabled            *bool  `json:"enabled,omitempty"`
			Interval           string `json:"interval,omitempty"`
			Timeout            string `json:"timeout,omitempty"`
			HealthCheckTimeout string `json:"health_check_timeout,omitempty"`
			DrainTimeout       string `json:"drain_timeout,omitempty"`
			MinAvailableNodes  *int   `json:"min_available_nodes,omitempty"`
		}
		var req struct {
			Subscriptions       []string   `json:"subscriptions"`
			SubscriptionRefresh refreshReq `json:"subscription_refresh"`
		}

		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			writeJSON(w, map[string]any{"error": "请求格式错误"})
			return
		}

		// Load current refresh settings to support partial updates.
		cfg, err := s.nodeMgr.ConfigSnapshot(r.Context())
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		if cfg == nil {
			w.WriteHeader(http.StatusServiceUnavailable)
			writeJSON(w, map[string]any{"error": "配置未初始化"})
			return
		}

		// Validate and normalize subscription URLs.
		var subs []string
		seen := make(map[string]struct{}, len(req.Subscriptions))
		for _, raw := range req.Subscriptions {
			u := strings.TrimSpace(raw)
			if u == "" {
				continue
			}
			if _, ok := seen[u]; ok {
				continue
			}
			parsed, err := url.Parse(u)
			if err != nil || parsed.Scheme == "" || parsed.Host == "" {
				w.WriteHeader(http.StatusBadRequest)
				writeJSON(w, map[string]any{"error": fmt.Sprintf("订阅链接无效: %s", u)})
				return
			}
			switch strings.ToLower(parsed.Scheme) {
			case "http", "https":
			default:
				w.WriteHeader(http.StatusBadRequest)
				writeJSON(w, map[string]any{"error": fmt.Sprintf("订阅链接仅支持 http/https: %s", u)})
				return
			}
			seen[u] = struct{}{}
			subs = append(subs, u)
		}

		refresh := cfg.SubscriptionRefresh
		if req.SubscriptionRefresh.Enabled != nil {
			refresh.Enabled = *req.SubscriptionRefresh.Enabled
		}
		if req.SubscriptionRefresh.Interval != "" {
			d, err := time.ParseDuration(strings.TrimSpace(req.SubscriptionRefresh.Interval))
			if err != nil || d <= 0 {
				w.WriteHeader(http.StatusBadRequest)
				writeJSON(w, map[string]any{"error": "刷新间隔无效（例如：30m、1h）"})
				return
			}
			refresh.Interval = d
		}
		if req.SubscriptionRefresh.Timeout != "" {
			d, err := time.ParseDuration(strings.TrimSpace(req.SubscriptionRefresh.Timeout))
			if err != nil || d <= 0 {
				w.WriteHeader(http.StatusBadRequest)
				writeJSON(w, map[string]any{"error": "订阅超时无效（例如：30s）"})
				return
			}
			refresh.Timeout = d
		}
		if req.SubscriptionRefresh.HealthCheckTimeout != "" {
			d, err := time.ParseDuration(strings.TrimSpace(req.SubscriptionRefresh.HealthCheckTimeout))
			if err != nil || d <= 0 {
				w.WriteHeader(http.StatusBadRequest)
				writeJSON(w, map[string]any{"error": "健康检查超时无效（例如：60s）"})
				return
			}
			refresh.HealthCheckTimeout = d
		}
		if req.SubscriptionRefresh.DrainTimeout != "" {
			d, err := time.ParseDuration(strings.TrimSpace(req.SubscriptionRefresh.DrainTimeout))
			if err != nil || d <= 0 {
				w.WriteHeader(http.StatusBadRequest)
				writeJSON(w, map[string]any{"error": "排空超时无效（例如：30s）"})
				return
			}
			refresh.DrainTimeout = d
		}
		if req.SubscriptionRefresh.MinAvailableNodes != nil {
			if *req.SubscriptionRefresh.MinAvailableNodes <= 0 {
				w.WriteHeader(http.StatusBadRequest)
				writeJSON(w, map[string]any{"error": "最少可用节点数必须大于 0"})
				return
			}
			refresh.MinAvailableNodes = *req.SubscriptionRefresh.MinAvailableNodes
		}

		if err := s.nodeMgr.UpdateSubscriptionConfig(r.Context(), subs, refresh); err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}

		writeJSON(w, map[string]any{
			"message":       "订阅设置已保存",
			"subscriptions": subs,
			"need_refresh":  len(subs) > 0,
		})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

// handleSubscriptionStatus returns the current subscription refresh status.
func (s *Server) handleSubscriptionStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	if s.nodeMgr == nil {
		writeJSON(w, map[string]any{"enabled": false, "message": "节点管理未启用"})
		return
	}
	cfg, _ := s.nodeMgr.ConfigSnapshot(r.Context())
	configured := cfg != nil && len(cfg.Subscriptions) > 0
	if s.subRefresher != nil {
		configured = true
	}

	var status SubscriptionStatus
	if s.subRefresher != nil {
		status = s.subRefresher.Status()
	} else {
		s.subMu.RLock()
		status = s.subStatus
		s.subMu.RUnlock()
		if status.NodeCount == 0 && cfg != nil {
			// Best-effort: count current subscription-sourced nodes.
			for _, n := range cfg.Nodes {
				if n.Source == config.NodeSourceSubscription {
					status.NodeCount++
				}
			}
		}
	}

	writeJSON(w, map[string]any{
		"enabled":       configured,
		"auto_refresh":  cfg != nil && cfg.SubscriptionRefresh.Enabled,
		"last_refresh":  status.LastRefresh,
		"next_refresh":  status.NextRefresh,
		"node_count":    status.NodeCount,
		"last_error":    status.LastError,
		"refresh_count": status.RefreshCount,
		"is_refreshing": status.IsRefreshing,
		"nodes_modified": status.NodesModified,
	})
}

// handleSubscriptionRefresh triggers an immediate subscription refresh.
func (s *Server) handleSubscriptionRefresh(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	if !s.ensureNodeManager(w) {
		return
	}

	// If periodic refresher is available, use it; otherwise do a one-shot refresh.
	if s.subRefresher != nil {
		if err := s.subRefresher.RefreshNow(); err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		status := s.subRefresher.Status()
		writeJSON(w, map[string]any{
			"message":       "刷新成功",
			"node_count":    status.NodeCount,
			"last_refresh":  status.LastRefresh,
			"refresh_count": status.RefreshCount,
		})
		return
	}

	s.subMu.Lock()
	s.subStatus.IsRefreshing = true
	s.subMu.Unlock()

	nodeCount, err := s.nodeMgr.RefreshSubscriptions(r.Context())

	s.subMu.Lock()
	s.subStatus.IsRefreshing = false
	now := time.Now()
	s.subStatus.LastRefresh = now
	s.subStatus.RefreshCount++
	s.subStatus.NodeCount = nodeCount
	if err != nil {
		s.subStatus.LastError = err.Error()
	} else {
		s.subStatus.LastError = ""
	}
	refreshCount := s.subStatus.RefreshCount
	s.subMu.Unlock()

	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		writeJSON(w, map[string]any{"error": err.Error()})
		return
	}

	writeJSON(w, map[string]any{
		"message":       "刷新成功",
		"node_count":    nodeCount,
		"last_refresh":  now,
		"refresh_count": refreshCount,
	})
}

// nodePayload is the JSON request body for node CRUD operations.
type nodePayload struct {
	Name     string `json:"name"`
	URI      string `json:"uri"`
	Port     uint16 `json:"port"`
	Username string `json:"username"`
	Password string `json:"password"`
}

func (p nodePayload) toConfig() config.NodeConfig {
	return config.NodeConfig{
		Name:     p.Name,
		URI:      p.URI,
		Port:     p.Port,
		Username: p.Username,
		Password: p.Password,
	}
}

// handleConfigNodes handles GET (list) and POST (create) for config nodes.
func (s *Server) handleConfigNodes(w http.ResponseWriter, r *http.Request) {
	if !s.ensureNodeManager(w) {
		return
	}

	switch r.Method {
	case http.MethodGet:
		nodes, err := s.nodeMgr.ListConfigNodes(r.Context())
		if err != nil {
			s.respondNodeError(w, err)
			return
		}
		writeJSON(w, map[string]any{"nodes": nodes})
	case http.MethodPost:
		var payload nodePayload
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			writeJSON(w, map[string]any{"error": "请求格式错误"})
			return
		}
		node, err := s.nodeMgr.CreateNode(r.Context(), payload.toConfig())
		if err != nil {
			s.respondNodeError(w, err)
			return
		}
		writeJSON(w, map[string]any{"node": node, "message": "节点已添加，请点击重载使配置生效"})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

// handleConfigNodeItem handles PUT (update) and DELETE for a specific config node.
func (s *Server) handleConfigNodeItem(w http.ResponseWriter, r *http.Request) {
	if !s.ensureNodeManager(w) {
		return
	}

	namePart := strings.TrimPrefix(r.URL.Path, "/api/nodes/config/")
	nodeName, err := url.PathUnescape(namePart)
	if err != nil || nodeName == "" {
		w.WriteHeader(http.StatusBadRequest)
		writeJSON(w, map[string]any{"error": "节点名称无效"})
		return
	}

	switch r.Method {
	case http.MethodPut:
		var payload nodePayload
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			writeJSON(w, map[string]any{"error": "请求格式错误"})
			return
		}
		node, err := s.nodeMgr.UpdateNode(r.Context(), nodeName, payload.toConfig())
		if err != nil {
			s.respondNodeError(w, err)
			return
		}
		writeJSON(w, map[string]any{"node": node, "message": "节点已更新，请点击重载使配置生效"})
	case http.MethodDelete:
		if err := s.nodeMgr.DeleteNode(r.Context(), nodeName); err != nil {
			s.respondNodeError(w, err)
			return
		}
		writeJSON(w, map[string]any{"message": "节点已删除，请点击重载使配置生效"})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

// handleReload triggers a configuration reload.
func (s *Server) handleReload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if !s.ensureNodeManager(w) {
		return
	}

	if err := s.nodeMgr.TriggerReload(r.Context()); err != nil {
		s.respondNodeError(w, err)
		return
	}
	writeJSON(w, map[string]any{
		"message": "重载成功，现有连接已被中断",
	})
}

func (s *Server) ensureNodeManager(w http.ResponseWriter) bool {
	if s.nodeMgr == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		writeJSON(w, map[string]any{"error": "节点管理未启用"})
		return false
	}
	return true
}

func (s *Server) respondNodeError(w http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	switch {
	case errors.Is(err, ErrNodeNotFound):
		status = http.StatusNotFound
	case errors.Is(err, ErrNodeConflict), errors.Is(err, ErrInvalidNode):
		status = http.StatusBadRequest
	}
	w.WriteHeader(status)
	writeJSON(w, map[string]any{"error": err.Error()})
}
