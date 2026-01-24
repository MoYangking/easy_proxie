package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// EnsureDirForFile makes sure the parent directory of the given file path exists.
// If the path has no parent directory (e.g. "config.yaml"), this is a no-op.
func EnsureDirForFile(path string) error {
	dir := filepath.Dir(path)
	if dir == "" || dir == "." {
		return nil
	}
	return os.MkdirAll(dir, 0o755)
}

// EnsureConfigFile ensures the config directory exists and writes a default config
// when the config file is missing.
func EnsureConfigFile(path string) (created bool, err error) {
	if path == "" {
		return false, errors.New("config path is empty")
	}

	if err := EnsureDirForFile(path); err != nil {
		return false, fmt.Errorf("create config dir: %w", err)
	}

	info, err := os.Stat(path)
	if err == nil {
		if info.IsDir() {
			return false, fmt.Errorf("config path %q is a directory", path)
		}
		return false, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return false, fmt.Errorf("stat config: %w", err)
	}

	if err := os.WriteFile(path, DefaultConfigYAML(), 0o644); err != nil {
		return false, fmt.Errorf("write default config: %w", err)
	}
	return true, nil
}

func DefaultConfigYAML() []byte {
	// Keep it minimal but valid so the program can start after first boot.
	// Users are expected to replace the sample node.
	return []byte(`mode: pool
log_level: info
skip_cert_verify: false

management:
  enabled: true
  listen: 0.0.0.0:9090
  probe_target: www.apple.com:80
  password: ""

listener:
  address: 0.0.0.0
  port: 2323
  username: ""
  password: ""

pool:
  mode: sequential
  failure_threshold: 3
  blacklist_duration: 24h

multi_port:
  address: 0.0.0.0
  base_port: 24000
  username: ""
  password: ""

# 订阅链接列表（可在 WebUI 中导入/管理）
subscriptions: []

subscription_refresh:
  enabled: false
  interval: 1h
  timeout: 30s
  health_check_timeout: 60s
  drain_timeout: 30s
  min_available_nodes: 1

nodes:
  - uri: "vless://00000000-0000-0000-0000-000000000000@example.com:443#示例节点"
`)
}
