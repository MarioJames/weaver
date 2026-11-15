// 自定义数据目录：接口不变，只在服务管理上分叉。
// 默认目录（~/.local/share/weaver/v2）继续用正式的 weaver.service；
// 其他目录用 systemd-run --user 起一个按路径哈希命名的临时单元，
// 绝不触碰正式服务。所有外部命令仍走 runCommand。
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
)

// dataHomeDefault is a variable so tests can decide which directory counts as
// the default one; production always compares against the real default.
var dataHomeDefault = func() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local", "share", "weaver", "v2")
}

func isDefaultDataHome(home string) bool {
	if home == "" {
		return true
	}
	def := dataHomeDefault()
	if def == "" {
		return false
	}
	return filepath.Clean(home) == filepath.Clean(def)
}

// customDataHome reports the data directory when it is not the default one.
func (a *app) customDataHome() (string, bool) {
	home := a.client.home
	return home, home != "" && !isDefaultDataHome(home)
}

// serviceUnitName is short and stable: the same data directory always names
// the same transient unit, and different directories never collide.
func serviceUnitName(home string) string {
	sum := sha256.Sum256([]byte(filepath.Clean(home)))
	return "weaver-gui-" + hex.EncodeToString(sum[:6])
}

// startServiceFor starts the service the data directory calls for.
func startServiceFor(ctx context.Context, home string) (string, error) {
	if isDefaultDataHome(home) {
		return startService(ctx)
	}
	unit := serviceUnitName(home)
	output, err := command(ctx, "systemd-run", "--user", "--unit="+unit,
		"--setenv=WEAVER_HOME="+home, weaverExecutable(), "daemon")
	if err == nil {
		return output, nil
	}
	// A transient unit that was started once and then stopped stays loaded.
	// Starting it again means restarting that unit, not the system service.
	lower := strings.ToLower(output)
	if strings.Contains(lower, "already exists") || strings.Contains(lower, "already loaded") ||
		strings.Contains(lower, "exists already") {
		return command(ctx, "systemctl", "--user", "restart", unit)
	}
	return output, err
}

// restartServiceFor restarts only the unit that belongs to this data directory.
func restartServiceFor(ctx context.Context, home string) (string, error) {
	if isDefaultDataHome(home) {
		return command(ctx, "systemctl", "--user", "restart", "weaver.service")
	}
	return command(ctx, "systemctl", "--user", "restart", serviceUnitName(home))
}
