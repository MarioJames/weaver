// 后续页面通过 client.call 调用 RPC；服务原始错误的 code/message 保持不变。
// 不读取数据库，Unix socket 和数据目录均沿用 internal/rpc 的协议与 Home。
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/MarioJames/weaver/internal/rpc"
)

type client struct{ home string }
type callError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *callError) Error() string { return e.Message }
func (e *callError) Is(target error) bool {
	return target == rpc.ErrUnavailable && e.Code == "UNAVAILABLE"
}
func (c client) call(method string, params, out any) error {
	conn, err := net.DialTimeout("unix", rpc.SocketPath(c.home), 700*time.Millisecond)
	if err != nil {
		return &callError{"UNAVAILABLE", err.Error()}
	}
	defer conn.Close()
	// rpc.Call has no read deadline. Bound the entire exchange so polling can recover
	// promptly even when a live socket accepts requests but stops answering.
	timeout := 30 * time.Second
	if method == "status" {
		timeout = 700 * time.Millisecond
	}
	if err = conn.SetDeadline(time.Now().Add(timeout)); err != nil {
		return &callError{"INTERNAL", err.Error()}
	}
	body, err := json.Marshal(params)
	if err != nil {
		return &callError{"INVALID", err.Error()}
	}
	if err = json.NewEncoder(conn).Encode(rpc.Request{Method: method, Params: body}); err != nil {
		return &callError{"UNAVAILABLE", err.Error()}
	}
	line, err := bufio.NewReader(conn).ReadBytes('\n')
	if err != nil {
		return &callError{"UNAVAILABLE", err.Error()}
	}
	var response rpc.Response
	if err = json.Unmarshal(line, &response); err != nil {
		return &callError{"PROTOCOL", err.Error()}
	}
	if !response.OK {
		if response.Error != nil {
			return &callError{response.Error.Code, response.Error.Message}
		}
		return &callError{"INTERNAL", "服务没有返回错误详情"}
	}
	if out != nil {
		if err = json.Unmarshal(response.Result, out); err != nil {
			return &callError{"PROTOCOL", err.Error()}
		}
	}
	return nil
}

// 所有外部命令都经过这个可替换的边界；测试不调用本机 systemctl/weaver。
var runCommand = func(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}

func weaverExecutable() string {
	if self, err := os.Executable(); err == nil {
		candidate := filepath.Join(filepath.Dir(self), "weaver")
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() && info.Mode()&0111 != 0 {
			return candidate
		}
	}
	if path, err := exec.LookPath("weaver"); err == nil {
		return path
	}
	return "weaver"
}
func command(ctx context.Context, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	output, err := runCommand(ctx, name, args...)
	if err != nil {
		detail := strings.TrimSpace(string(output))
		if detail == "" {
			detail = err.Error()
		}
		return string(output), fmt.Errorf("%s", detail)
	}
	return string(output), nil
}
func startService(ctx context.Context) (string, error) {
	output, err := command(ctx, "systemctl", "--user", "start", "weaver.service")
	if err == nil {
		return output, nil
	}
	lower := strings.ToLower(output)
	if strings.Contains(lower, "not found") || strings.Contains(lower, "does not exist") || strings.Contains(lower, "not loaded") || strings.Contains(lower, "不存在") {
		return command(ctx, weaverExecutable(), "service", "install")
	}
	return output, err
}
func unavailable(err error) bool { return errors.Is(err, rpc.ErrUnavailable) }
