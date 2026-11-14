package engine

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func dshLaunch(t *testing.T, account Account, model, effort string) ([]string, string, error) {
	t.Helper()
	c := &launchCtx{run: Run{AttemptID: "p_x.1", Engine: "dsh", Model: model, Effort: effort, Account: account, RunDir: t.TempDir()}, env: map[string]string{}, stdin: true}
	if err := specs["dsh"].prepare(c); err != nil {
		return nil, "", err
	}
	argv, err := specs["dsh"].argv(c)
	if err != nil {
		return nil, "", err
	}
	var files strings.Builder
	for i, arg := range argv {
		if arg == "--patch" {
			body, err := os.ReadFile(argv[i+1])
			if err != nil {
				t.Fatal(err)
			}
			files.Write(body)
			files.WriteString("\n")
		}
	}
	return argv, files.String(), nil
}

func TestDshRoutesAnOpenAIAccountThroughItsOwnProvider(t *testing.T) {
	account := Account{Engine: "dsh", Kind: "api", APIKey: "sk-test-key", Provider: "openai"}
	_, patches, err := dshLaunch(t, account, "gpt-6.1-terra", "xhigh")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`provider: "openai"`, `model: "gpt-6.1-terra"`, `reasoningEffort: "xhigh"`,
		`"api":"openai-responses"`, `"baseURL":"https://api.openai.com/v1"`, `"apiKeyEnv":"WEAVER_API_KEY"`, `"id":"gpt-6.1-terra"`,
	} {
		if !strings.Contains(patches, want) {
			t.Errorf("patches lack %s:\n%s", want, patches)
		}
	}
	if strings.Contains(patches, "sk-test-key") {
		t.Error("the key belongs in the credentials file, not in a patch")
	}
	if strings.Contains(patches, "deepseek-official") {
		t.Errorf("an OpenAI account must not select the DeepSeek route:\n%s", patches)
	}
}

func TestDshAnthropicAccountKeepsTheModelLimitsFromItsConfig(t *testing.T) {
	config := `{"models":[{"id":"claude-haiku-5-5","name":"claude-haiku-5.5","contextWindow":1000000,"maxTokens":128000,"reasoningEfforts":{"xhigh":"xhigh","max":"max"}}]}`
	account := Account{Engine: "dsh", Kind: "api", APIKey: "k", Provider: "anthropic", Config: config}
	_, patches, err := dshLaunch(t, account, "claude-haiku-5-5", "xhigh")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"api":"anthropic-messages"`, `"baseURL":"https://api.anthropic.com"`, `"contextWindow":1000000`, `"maxTokens":128000`} {
		if !strings.Contains(patches, want) {
			t.Errorf("patches lack %s:\n%s", want, patches)
		}
	}
	// One entry for the model: the configured one, not a second generated one.
	if n := strings.Count(patches, `"id":"claude-haiku-5-5"`); n != 1 {
		t.Errorf("model listed %d times", n)
	}
	if _, _, err := dshLaunch(t, account, "claude-haiku-5-5", "low"); err == nil || !strings.Contains(err.Error(), "xhigh") {
		t.Errorf("an effort the model does not offer must be refused and name the offered ones, got %v", err)
	}
}

func TestDshDeepSeekAccountIsUnchanged(t *testing.T) {
	_, patches, err := dshLaunch(t, Account{Engine: "dsh", Kind: "api", APIKey: "k"}, "deepseek-flash", "")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`provider: deepseek-official`, `reasoningEffort: "high"`, `apiKeyEnv: DEEPSEEK_API_KEY`} {
		if !strings.Contains(patches, want) {
			t.Errorf("patches lack %s:\n%s", want, patches)
		}
	}
	if strings.Contains(patches, "llm-pi-ai") {
		t.Error("a DeepSeek account needs no extra provider")
	}
	if _, _, err := dshLaunch(t, Account{Engine: "dsh", Kind: "api", APIKey: "k"}, "deepseek-flash", "xhigh"); err == nil {
		t.Error("DeepSeek offers off/low/high/max only")
	}
}

func TestDshProviderWithoutAKnownEndpointNeedsABaseURL(t *testing.T) {
	if _, _, err := dshLaunch(t, Account{Engine: "dsh", Kind: "api", APIKey: "k", Provider: "acme"}, "m", ""); err == nil {
		t.Error("an unknown provider without a base URL must be refused")
	}
	_, patches, err := dshLaunch(t, Account{Engine: "dsh", Kind: "api", APIKey: "k", Provider: "acme", BaseURL: "https://llm.acme.test/v1"}, "m", "")
	if err != nil {
		t.Fatal(err)
	}
	var seen bool
	for _, line := range strings.Split(patches, "\n") {
		if i := strings.Index(line, `{"providers"`); i >= 0 {
			var body map[string]any
			if err := json.Unmarshal([]byte(line[i:]), &body); err != nil {
				t.Fatalf("provider block is not valid JSON: %v\n%s", err, line)
			}
			seen = true
		}
	}
	if !seen || !strings.Contains(patches, `"api":"openai-completions"`) {
		t.Errorf("expected an OpenAI-compatible provider block:\n%s", patches)
	}
}

// dsh runs each tool command in a scope of its own, named after its pid. The
// attempt's scope then looks idle during a long build unless those are counted.
func TestToolScopeCPUCountsOnlyThisAttemptsScopesAndNeverGoesBack(t *testing.T) {
	root := t.TempDir()
	stat := func(scope string, usec int) {
		dir := filepath.Join(root, scope)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "cpu.stat"), []byte(fmt.Sprintf("usage_usec %d\nuser_usec 1\n", usec)), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	stat("dsh-subprocess-100-aaaa.scope", 2_000_000)
	stat("dsh-terminal-100-bbbb.scope", 500_000)
	stat("dsh-subprocess-999-cccc.scope", 9_000_000) // another attempt's dsh
	stat("weaver-p_other.1.scope", 7_000_000)
	seen := map[string]uint64{}
	var total uint64
	total = addToolScopeCPU(root, []int{100}, seen, total)
	if total != 2_500_000_000 {
		t.Fatalf("first sample: got %d ns", total)
	}
	stat("dsh-subprocess-100-aaaa.scope", 3_000_000)
	if total = addToolScopeCPU(root, []int{100}, seen, total); total != 3_500_000_000 {
		t.Fatalf("after one more second of tool CPU: got %d ns", total)
	}
	// The command ended and its scope is gone: what it used stays counted.
	os.RemoveAll(filepath.Join(root, "dsh-subprocess-100-aaaa.scope"))
	stat("dsh-subprocess-100-dddd.scope", 250_000)
	if total = addToolScopeCPU(root, []int{100}, seen, total); total != 3_750_000_000 {
		t.Fatalf("after a scope ended and a new one started: got %d ns", total)
	}
}
