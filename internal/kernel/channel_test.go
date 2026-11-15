package kernel

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func nowKernel(t *testing.T) *Kernel {
	t.Helper()
	clock := time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)
	return fixedKernel(t, &clock, nil)
}

func TestAccountConfigStripsEveryAPIKeyFieldAndNeverReturnsSecrets(t *testing.T) {
	k := nowKernel(t)
	config := `{"api":"openai-responses","baseURL":"https://api.openai.com/v1","apiKey":"sk-inline",` +
		`"models":[{"id":"m1","apiKey":"sk-model"},{"id":"m2","nested":{"ApiKey":"sk-nested","keep":"yes"}}],` +
		`"meta":{"apiKEY":"sk-upper"}}`
	addUsageAccount(t, k, "acct-config", "openai", "", config)
	view, err := k.AccountConfig("acct-config")
	if err != nil {
		t.Fatal(err)
	}
	if !view.HasAPIKey || view.Engine != "dsh" || view.Provider != "openai" {
		t.Fatalf("view = %+v", view)
	}
	body, _ := json.Marshal(view)
	text := string(body)
	for _, secret := range []string{"sk-inline", "sk-model", "sk-nested", "sk-upper"} {
		if strings.Contains(text, secret) {
			t.Fatalf("%q leaked in %s", secret, text)
		}
	}
	configBody, _ := json.Marshal(view.Config)
	configText := string(configBody)
	if strings.Contains(strings.ToLower(configText), "apikey") {
		t.Fatalf("an apiKey field survived: %s", configText)
	}
	if !strings.Contains(configText, `"keep":"yes"`) || !strings.Contains(configText, `"id":"m1"`) {
		t.Fatalf("the rest of the config was lost: %s", configText)
	}

	accounts, err := k.Accounts()
	if err != nil {
		t.Fatal(err)
	}
	all, _ := json.Marshal(accounts)
	if strings.Contains(string(all), "sk-inline") {
		t.Fatalf("account list leaked a secret: %s", all)
	}
}

func TestAccountConfigWithoutNativeConfigIsNull(t *testing.T) {
	k := nowKernel(t)
	addUsageAccount(t, k, "acct-noconfig", "openai", "", "")
	view, err := k.AccountConfig("acct-noconfig")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(view)
	if !strings.Contains(string(body), `"config":null`) {
		t.Fatalf("config = %s, want null", body)
	}
}

func TestFetchModelsOnOpenAIProtocolUsesTheRightHeadersAndKeys(t *testing.T) {
	k := nowKernel(t)
	var mu sync.Mutex
	var auth []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			t.Errorf("path = %s", r.URL.Path)
		}
		mu.Lock()
		auth = append(auth, r.Header.Get("Authorization"))
		mu.Unlock()
		io.WriteString(w, `{"data":[{"id":"m1","name":"Model One","context_window":272000,"max_tokens":128000},{"id":"m2"}]}`)
	}))
	defer server.Close()

	if _, err := k.AddAccount(AccountInput{ID: "acct-models", Engine: "dsh", Kind: "api", APIKey: "sk-stored",
		Provider: "acme", Protocol: "openai-completions", BaseURL: server.URL + "/v1"}); err != nil {
		t.Fatal(err)
	}
	models, err := k.FetchModels(ModelFetchInput{ID: "acct-models"})
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 2 || models[0].ID != "m1" || models[0].Name != "Model One" ||
		models[0].ContextWindow != 272000 || models[0].MaxTokens != 128000 || models[1].Name != "m2" {
		t.Fatalf("models = %+v", models)
	}

	// The form has not been saved yet: engine, provider and key all come in.
	models, err = k.FetchModels(ModelFetchInput{Engine: "dsh", Provider: "acme", Protocol: "openai-completions",
		BaseURL: server.URL + "/v1", APIKey: "sk-form"})
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 2 {
		t.Fatalf("form models = %+v", models)
	}
	// With both, the explicit key wins and the stored one fills only a gap.
	if _, err := k.FetchModels(ModelFetchInput{ID: "acct-models", APIKey: "sk-form"}); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	got := append([]string{}, auth...)
	mu.Unlock()
	want := []string{"Bearer sk-stored", "Bearer sk-form", "Bearer sk-form"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("Authorization headers = %v, want %v", got, want)
	}
}

func TestFetchModelsOnAnthropicProtocolRewritesV1AndReadsAnthropicLimits(t *testing.T) {
	k := nowKernel(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" || r.URL.Query().Get("limit") != "1000" {
			t.Errorf("request = %s?%s", r.URL.Path, r.URL.RawQuery)
		}
		if got := r.Header.Get("x-api-key"); got != "sk-ant" {
			t.Errorf("x-api-key = %q", got)
		}
		if got := r.Header.Get("anthropic-version"); got != "2023-06-01" {
			t.Errorf("anthropic-version = %q", got)
		}
		io.WriteString(w, `{"data":[{"id":"claude-x","display_name":"Claude X","max_input_tokens":200000,"max_tokens":64000}],"has_more":false}`)
	}))
	defer server.Close()

	if _, err := k.AddAccount(AccountInput{ID: "acct-ant", Engine: "dsh", Kind: "api", APIKey: "sk-ant",
		Provider: "anthropic", Protocol: "anthropic-messages", BaseURL: server.URL + "/v1"}); err != nil {
		t.Fatal(err)
	}
	models, err := k.FetchModels(ModelFetchInput{ID: "acct-ant"})
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 1 {
		t.Fatalf("models = %+v", models)
	}
	m := models[0]
	if m.ID != "claude-x" || m.Name != "Claude X" || m.ContextWindow != 200000 || m.MaxTokens != 64000 {
		t.Fatalf("model = %+v", m)
	}
}

func TestFetchModelsRefusesDeepSeekOfficial(t *testing.T) {
	k := nowKernel(t)
	addUsageAccount(t, k, "acct-ds", "deepseek-official", "", "")
	for _, in := range []ModelFetchInput{{ID: "acct-ds"}, {Engine: "dsh"}} {
		_, err := k.FetchModels(in)
		want := "DeepSeek 官方渠道的模型由 dsh 内置"
		if got := AsError(err); got.Code != "INVALID" || got.Message != want {
			t.Errorf("%+v: err = %v, want INVALID %q", in, err, want)
		}
	}
}

func strptr(s string) *string { return &s }

func TestDshOfficialEffortMustBeOffLowHighMax(t *testing.T) {
	k := nowKernel(t)
	if _, err := k.AddAccount(AccountInput{ID: "acct-ds", Engine: "dsh", Kind: "api", APIKey: "k", Provider: "deepseek-official"}); err != nil {
		t.Fatal(err)
	}
	_, err := k.SetWorker(WorkerInput{ID: "w", Engine: "dsh", Model: "deepseek-chat", Effort: strptr("xhigh"), Accounts: []string{"acct-ds"}})
	if got := AsError(err); got.Code != "INVALID" || !strings.Contains(got.Message, "off/low/high/max") {
		t.Fatalf("err = %v, want INVALID naming off/low/high/max", err)
	}
	if _, err := k.SetWorker(WorkerInput{ID: "w", Engine: "dsh", Model: "deepseek-chat", Effort: strptr("high"), Accounts: []string{"acct-ds"}}); err != nil {
		t.Fatal(err)
	}
}

func TestDshModelEffortsRestrictTheWorkerEffort(t *testing.T) {
	k := nowKernel(t)
	config := `{"models":[{"id":"m1","name":"m1","reasoningEfforts":{"xhigh":"xhigh","max":"max"}}]}`
	addUsageAccount(t, k, "acct-effort", "openai", "", config)
	_, err := k.SetWorker(WorkerInput{ID: "w", Engine: "dsh", Model: "m1", Effort: strptr("high"), Accounts: []string{"acct-effort"}})
	if got := AsError(err); got.Code != "INVALID" || !strings.Contains(got.Message, "模型 m1 的思考力度只有 max/xhigh") {
		t.Fatalf("err = %v, want INVALID listing max/xhigh", err)
	}
	if _, err := k.SetWorker(WorkerInput{ID: "w", Engine: "dsh", Model: "m1", Effort: strptr("xhigh"), Accounts: []string{"acct-effort"}}); err != nil {
		t.Fatal(err)
	}
	// The same check applies when an existing candidate changes its effort.
	_, err = k.SetWorker(WorkerInput{ID: "w", Effort: strptr("high")})
	if got := AsError(err); got.Code != "INVALID" || !strings.Contains(got.Message, "max/xhigh") {
		t.Fatalf("update err = %v, want INVALID", err)
	}
	if w, _ := k.Worker("w"); w.Effort != "xhigh" {
		t.Fatalf("a rejected update changed the effort to %q", w.Effort)
	}
}

func TestDshModelWithoutReasoningEffortsRequiresAnEmptyEffort(t *testing.T) {
	k := nowKernel(t)
	config := `{"models":[{"id":"m1","reasoningEfforts":false}]}`
	addUsageAccount(t, k, "acct-noeffort", "openai", "", config)
	_, err := k.SetWorker(WorkerInput{ID: "w", Engine: "dsh", Model: "m1", Effort: strptr("high"), Accounts: []string{"acct-noeffort"}})
	if got := AsError(err); got.Code != "INVALID" || !strings.Contains(got.Message, "模型 m1 不支持思考力度") {
		t.Fatalf("err = %v, want INVALID", err)
	}
	if _, err := k.SetWorker(WorkerInput{ID: "w", Engine: "dsh", Model: "m1", Effort: strptr(""), Accounts: []string{"acct-noeffort"}}); err != nil {
		t.Fatal(err)
	}
}

func TestDshModelOutsideTheConfigIsNotChecked(t *testing.T) {
	k := nowKernel(t)
	config := `{"models":[{"id":"m1","reasoningEfforts":{"xhigh":"xhigh"}}]}`
	addUsageAccount(t, k, "acct-unknown", "openai", "", config)
	if _, err := k.SetWorker(WorkerInput{ID: "w", Engine: "dsh", Model: "m-new", Effort: strptr("whatever"), Accounts: []string{"acct-unknown"}}); err != nil {
		t.Fatal(err)
	}
}
