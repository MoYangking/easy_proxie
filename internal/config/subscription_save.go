package config

import (
	"errors"
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

// SaveSubscriptionConfig persists subscription-related fields (subscriptions, subscription_refresh)
// while preserving the existing YAML structure for other fields.
func (c *Config) SaveSubscriptionConfig() error {
	if c == nil {
		return errors.New("config is nil")
	}
	if c.filePath == "" {
		return errors.New("config file path is unknown")
	}
	if err := EnsureDirForFile(c.filePath); err != nil {
		return fmt.Errorf("ensure config dir: %w", err)
	}

	data, err := os.ReadFile(c.filePath)
	if err != nil {
		return fmt.Errorf("read config: %w", err)
	}

	var saveCfg Config
	if err := yaml.Unmarshal(data, &saveCfg); err != nil {
		return fmt.Errorf("decode config: %w", err)
	}

	// Update only subscription-related fields.
	saveCfg.Subscriptions = append([]string(nil), c.Subscriptions...)
	saveCfg.SubscriptionRefresh = c.SubscriptionRefresh

	newData, err := yaml.Marshal(&saveCfg)
	if err != nil {
		return fmt.Errorf("encode config: %w", err)
	}
	if err := os.WriteFile(c.filePath, newData, 0o644); err != nil {
		return fmt.Errorf("write config: %w", err)
	}
	return nil
}

