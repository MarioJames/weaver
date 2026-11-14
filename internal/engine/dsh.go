package engine

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// dsh reaches DeepSeek through its built-in route. Every other vendor goes
// through its llm-pi-ai plugin, which this file configures for one run: the
// account names the provider, the candidate names the model and effort.

// dshKeyRef is the credential reference a non-DeepSeek provider reads its key from.
const dshKeyRef = "WEAVER_API_KEY"

// dshEndpoints are the vendors an account can name without spelling out the protocol and address.
var dshEndpoints = map[string]struct{ api, base string }{
	"openai":    {"openai-responses", "https://api.openai.com/v1"},
	"anthropic": {"anthropic-messages", "https://api.anthropic.com"},
}

var reDshEffort = regexp.MustCompile(`^[a-z]+$`)

func dshNative(a Account) bool {
	return a.Provider == "" || a.Provider == "deepseek" || a.Provider == "deepseek-official"
}

func dshAPI(a Account) string {
	switch a.Protocol {
	case "anthropic", "anthropic-messages":
		return "anthropic-messages"
	case "openai-responses":
		return "openai-responses"
	case "":
		if e, ok := dshEndpoints[a.Provider]; ok {
			return e.api
		}
	}
	return "openai-completions"
}

func dshArgv(c *launchCtx) ([]string, error) {
	a, effort := c.run.Account, c.run.Effort
	var route string
	if dshNative(a) {
		if effort == "" {
			effort = "high"
		}
		if !oneOf(effort, "off", "low", "high", "max") {
			return nil, fmt.Errorf("dsh 的推理强度 %q 不在 off/low/high/max 之内", effort)
		}
		route = "- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: " + strconv.Quote(c.run.Model) +
			"\n- id: llm-deepseek\n  config:\n    reasoningEffort: " + strconv.Quote(effort)
	} else {
		route = "- id: agent-default-model\n  config:\n    provider: " + strconv.Quote(a.Provider) + "\n    model: " + strconv.Quote(c.run.Model)
		if effort != "" {
			route += "\n    reasoningEffort: " + strconv.Quote(effort)
		}
	}
	// Pin model, effort and an unattended posture for this run only:
	// workspace-write with approval "ask" fails closed on anything
	// beyond the workspace, because headless has nobody to ask.
	overlay := route + "\n- id: sandbox-policy\n  config:\n    mode: workspace-write\n    workspaceRoot: !!js process.cwd()\n- id: approval\n  config:\n    policy: ask\n- id: credentials\n  disabled: false\n"
	path, err := c.put("dsh-overlay.yml", overlay)
	if err != nil {
		return nil, err
	}
	argv := []string{"dsh", "--profile", "headless", "--patch", path}
	argv = append(argv, c.extra...)
	return append(argv, "--json"), nil
}

func dshPrepare(c *launchCtx) error {
	a := c.run.Account
	if a.Kind != "api" || a.APIKey == "" {
		return errors.New("dsh 需要带密钥的 API 账号")
	}
	home, err := c.privateDir("dsh-home")
	if err != nil {
		return err
	}
	c.env["DSH_HOME"] = home
	ref, llm := "DEEPSEEK_API_KEY", ""
	if dshNative(a) {
		if a.Config != "" {
			return errors.New("dsh 的 DeepSeek 账号不支持附带原生配置")
		}
		base := a.BaseURL
		if base == "" {
			base = "https://api.deepseek.com/anthropic"
		}
		llm = "- id: llm-deepseek\n  config:\n    apiKeyEnv: DEEPSEEK_API_KEY\n    baseURL: " + strconv.Quote(base) + "\n"
	} else {
		block, err := dshProvider(a, c.run.Model, c.run.Effort)
		if err != nil {
			return err
		}
		body, err := json.Marshal(map[string]any{"providers": map[string]any{a.Provider: block}})
		if err != nil {
			return err
		}
		// A JSON object is a valid YAML flow mapping.
		ref, llm = dshKeyRef, "- id: llm-pi-ai\n  config: "+string(body)+"\n"
	}
	credential, err := c.put("dsh-home/.credentials.yaml", "version: 1\nrefs:\n  "+ref+": "+strconv.Quote(a.APIKey)+"\nrecords: {}\n")
	if err != nil {
		return err
	}
	patch, err := c.put("dsh-credentials.yml", "- id: credentials\n  disabled: false\n  config:\n    path: "+strconv.Quote(credential)+"\n"+llm)
	c.extra = append(c.extra, "--patch", patch)
	return err
}

// dshProvider builds the llm-pi-ai provider entry for an account. The account's
// native config, when present, is that entry as JSON (model limits, efforts);
// the protocol, address and key reference always come from the account itself.
func dshProvider(a Account, model, effort string) (map[string]any, error) {
	block := map[string]any{}
	if a.Config != "" {
		if err := json.Unmarshal([]byte(a.Config), &block); err != nil {
			return nil, errors.New("账号的原生 JSON 配置无法解析")
		}
	}
	if a.Protocol != "" || block["api"] == nil {
		block["api"] = dshAPI(a)
	}
	base := a.BaseURL
	if base == "" {
		base, _ = block["baseURL"].(string)
	}
	if base == "" {
		base = dshEndpoints[a.Provider].base
	}
	if base == "" {
		return nil, fmt.Errorf("dsh 的 %s 账号需要填写接口地址（--base-url）", a.Provider)
	}
	block["baseURL"], block["apiKeyEnv"] = base, dshKeyRef
	if block["displayName"] == nil {
		block["displayName"] = a.Provider
	}
	if effort != "" && !reDshEffort.MatchString(effort) {
		return nil, fmt.Errorf("推理强度 %q 的写法不对", effort)
	}
	models, _ := block["models"].([]any)
	for _, item := range models {
		m, _ := item.(map[string]any)
		if m == nil || m["id"] != model {
			continue
		}
		offered, _ := m["reasoningEfforts"].(map[string]any)
		if _, ok := offered[effort]; effort != "" && len(offered) > 0 && !ok {
			names := make([]string, 0, len(offered))
			for name := range offered {
				names = append(names, name)
			}
			sort.Strings(names)
			return nil, fmt.Errorf("模型 %s 的推理强度 %q 不在 %s 之内", model, effort, strings.Join(names, "/"))
		}
		return block, nil
	}
	entry := map[string]any{"id": model, "name": model}
	if effort != "" {
		entry["reasoningEfforts"] = map[string]any{effort: effort}
	}
	block["models"] = append(models, entry)
	return block, nil
}

// toolCPU is the CPU time used so far by the scopes dsh made for this attempt's
// tool commands. dsh does not run them in the attempt's own scope, so without
// this a long build looks like an idle process.
func (r *coldRun) toolCPU() uint64 {
	if strings.HasPrefix(r.unit, "pid:") {
		return 0
	}
	out, err := exec.Command("systemctl", "--user", "show", r.unit+".scope", "-p", "ControlGroup", "--value").Output()
	group := strings.TrimSpace(string(out))
	r.mu.Lock()
	defer r.mu.Unlock()
	if err != nil || group == "" {
		return r.toolTotal
	}
	dir := filepath.Join("/sys/fs/cgroup", group)
	var pids []int
	if body, err := os.ReadFile(filepath.Join(dir, "cgroup.procs")); err == nil {
		for _, field := range strings.Fields(string(body)) {
			if pid, err := strconv.Atoi(field); err == nil {
				pids = append(pids, pid)
			}
		}
	}
	if r.toolSeen == nil {
		r.toolSeen = map[string]uint64{}
	}
	r.toolTotal = addToolScopeCPU(filepath.Dir(dir), pids, r.toolSeen, r.toolTotal)
	return r.toolTotal
}

// addToolScopeCPU adds what the tool scopes of the given dsh processes have
// used since they were last seen, in nanoseconds. dsh names them
// dsh-subprocess-<its pid>-<random> and dsh-terminal-<its pid>-<random>.
// The total only grows: a scope that has ended keeps what it had used.
func addToolScopeCPU(parent string, pids []int, seen map[string]uint64, total uint64) uint64 {
	for _, pid := range pids {
		for _, prefix := range []string{"dsh-subprocess-", "dsh-terminal-"} {
			scopes, _ := filepath.Glob(filepath.Join(parent, fmt.Sprintf("%s%d-*.scope", prefix, pid)))
			for _, scope := range scopes {
				body, err := os.ReadFile(filepath.Join(scope, "cpu.stat"))
				if err != nil {
					continue
				}
				for _, line := range strings.Split(string(body), "\n") {
					value, ok := strings.CutPrefix(line, "usage_usec ")
					if !ok {
						continue
					}
					usec, _ := strconv.ParseUint(strings.TrimSpace(value), 10, 64)
					if name := filepath.Base(scope); usec > seen[name] {
						total += (usec - seen[name]) * 1000
						seen[name] = usec
					}
				}
			}
		}
	}
	return total
}
