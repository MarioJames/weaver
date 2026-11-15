package main

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/MarioJames/weaver/internal/daemon"
	"github.com/MarioJames/weaver/internal/engine"
	"github.com/MarioJames/weaver/internal/kernel"
	"github.com/MarioJames/weaver/internal/store"
	"github.com/egoist/mygo/ui"
)

// Only the external agent launcher is replaced while seeding; all mission,
// attempt, event and transcript data goes through the real kernel.
type taskContractEngines struct{}

func (taskContractEngines) Launch(engine.Run)                           {}
func (taskContractEngines) Cancel(string) engine.CancelResult           { return engine.CancelResult{} }
func (taskContractEngines) Reattach(engine.Run, string, string, string) {}
func (taskContractEngines) Prewarm(engine.Run)                          {}
func (taskContractEngines) DropPrewarm(string)                          {}
func (taskContractEngines) Warm(string)                                 {}
func (taskContractEngines) Liveness(string) engine.Liveness             { return engine.Liveness{} }

// daemon.Run is the only public daemon entry point. It installs process-wide
// signal handlers and owns background loops, so run that actual Go entry point
// in a disposable test subprocess rather than leak those into the test runner.
func TestTaskContractDaemonProcess(t *testing.T) {
	if os.Getenv("WEAVER_TASK_CONTRACT_DAEMON") != "1" {
		return
	}
	if err := daemon.Run(os.Getenv("WEAVER_HOME")); err != nil {
		t.Fatal(err)
	}
}

func taskContractService(t *testing.T) (client, string, []string) {
	t.Helper()
	home := t.TempDir()
	db, err := store.Open(filepath.Join(home, "weaver.db"))
	if err != nil {
		t.Fatal(err)
	}
	k := kernel.New(kernel.Options{DB: db, Home: home, Engines: taskContractEngines{}, Check: func(engine.Account) (bool, string) { return true, "" }, Now: func() time.Time { return time.Date(2026, 11, 15, 6, 0, 1, 0, time.UTC) }})
	// Close before starting the daemon, including on a fixture setup failure.
	defer db.Close()
	defer k.Close()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(k.SetSetting("resident", "off"))
	must(k.SetSetting("standby", "off"))
	_, err = k.AddAccount(kernel.AccountInput{ID: "contract-account", Engine: "codex", Kind: "api", APIKey: "test-only", Label: "contract"})
	must(err)
	_, err = k.SetWorker(kernel.WorkerInput{ID: "contract-worker", Engine: "codex", Model: "test-model", Accounts: []string{"contract-account"}})
	must(err)
	m, err := k.CreateMission("contract", "真实服务契约任务", home, nil, &kernel.Owner{Engine: "claude", Session: "task-owner-claude"})
	must(err)
	plan, err := k.SubmitPlan("", kernel.PlanInput{Mission: m.ID, Packages: []kernel.PackageInput{{Key: "shell", Title: "应用骨架", Instruction: "实现应用骨架", Worker: "contract-worker"}, {Key: "server", Title: "服务接口", Instruction: "实现服务接口", Worker: "contract-worker"}}})
	must(err)
	ids := []string{plan.Packages[0].ID, plan.Packages[1].ID}
	finish := func(id, result string) {
		t.Helper()
		p, err := k.Package(id)
		must(err)
		if p.Current == nil {
			t.Fatalf("包没有启动尝试: %+v", p)
		}
		k.Handed(p.Current.ID, "cold", "")
		k.Started(p.Current.ID, "")
		k.Finished(p.Current.ID, engine.Outcome{Success: true, Text: result})
	}
	finish(ids[0], "第一次结果，需要修订")
	_, err = k.Verdict(ids[0], "return", "补上断线恢复说明")
	must(err)
	finish(ids[0], "第二次结果，检查通过")
	_, err = k.Verdict(ids[0], "accept", "检查通过")
	must(err)
	finish(ids[1], "服务接口结果")
	for _, artifact := range []struct{ name, title, body string }{
		{"design-v1.html", "设计 v1", `<title>设计 v1</title><div class="decision"></div><p data-check-id="A34"></p>`},
		{"design-v2.html", "设计 v2", `<title>设计 v2</title><div class="decision"></div><p data-check-id="A34"></p>`},
		{"REPORT.html", "验收报告", `<div data-status="pass"></div><div data-status="fail"></div>`},
	} {
		path := filepath.Join(home, artifact.name)
		must(os.WriteFile(path, []byte(artifact.body), 0600))
		_, err = k.AddArtifact(kernel.ArtifactInput{Mission: m.ID, Path: path, Title: artifact.title, URL: "https://example.test/" + artifact.name})
		must(err)
	}
	// Prevent credential checks or external launches on daemon resume.
	disabled := false
	_, err = k.UpdateAccount("contract-account", kernel.AccountPatch{Enabled: &disabled})
	must(err)
	k.Close()
	must(db.Close())

	source, err := os.ReadFile("testdata/task-owner-claude.jsonl")
	must(err)
	// The transcript must identify the mission created by this fixture; the
	// static sample's alias is not an ID prefix for its generated mission ID.
	source = bytes.ReplaceAll(source, []byte("--mission contract"), []byte("--mission "+m.ID))
	transcriptDir := filepath.Join(home, ".claude", "projects", "contract")
	must(os.MkdirAll(transcriptDir, 0700))
	must(os.WriteFile(filepath.Join(transcriptDir, "task-owner-claude.jsonl"), source, 0600))
	c := client{home: home}
	exe, err := os.Executable()
	must(err)
	cmd := exec.Command(exe, "-test.run=^TestTaskContractDaemonProcess$", "-test.count=1")
	cmd.Env = append(os.Environ(), "WEAVER_TASK_CONTRACT_DAEMON=1", "WEAVER_HOME="+home, "HOME="+home)
	var output bytes.Buffer
	cmd.Stdout, cmd.Stderr = &output, &output
	must(cmd.Start())
	t.Cleanup(func() {
		_ = cmd.Process.Signal(syscall.SIGTERM)
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("daemon: %v\n%s", err, output.String())
			}
		case <-time.After(5 * time.Second):
			_ = cmd.Process.Kill()
			<-done
			t.Errorf("daemon did not stop\n%s", output.String())
		}
	})
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if c.call("mission.list", map[string]bool{"all": true}, nil) == nil {
			return c, m.ID, ids
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("真实 daemon 未就绪")
	return client{}, "", nil
}

func TestTasksRealDaemonContract(t *testing.T) {
	c, mission, ids := taskContractService(t)
	// testApp isolates HOME and routes newApp to this temporary socket.
	a := testApp(t, &fakeService{home: c.home})
	a.page = "任务"
	tt := ui.NewTester(a.view, 1440, 1600)
	tasksWait(t, tt, "真实服务契约任务", 5*time.Second)
	tasksContains(t, tt, "Cl", "待结论 · 1 / 2 已采纳")
	click(t, tt, "真实服务契约任务")
	tasksWait(t, tt, "只做桌面端", 5*time.Second)
	at := time.Date(2026, 11, 15, 6, 0, 1, 0, time.UTC).UnixMilli()
	tasksContains(t, tt, "先实现骨架，再拆包。", "▸ weaver plan submit · "+taskTime(at), "▸ Read · "+taskTime(at+1000), "shell", "server", "子 Agent 2", "第 1 次尝试", "第 2 次尝试", "已退回：补上断线恢复说明", "▸ 第 1 次结果全文", "▸ 第 2 次结果全文")
	if _, exists := tt.Find("子 Agent"); exists {
		t.Fatal("计划卡片未匹配 submit，落入末尾分组")
	}
	texts := strings.Join(tt.Texts(), "\n")
	if strings.Index(texts, "weaver plan submit") > strings.Index(texts, "shell") {
		t.Fatal("子 Agent 卡片未出现在 submit 后")
	}
	if tt.HasText("hidden-thinking") || tt.HasText("正在读取父 Agent 对话") {
		t.Fatalf("对话未正常显示: %q", tt.Texts())
	}
	click(t, tt, "▸ 第 1 次结果全文")
	tasksContains(t, tt, "第一次结果，需要修订")
	click(t, tt, "server")
	tasksContains(t, tt, "待结论")
	if err := c.call("verdict", map[string]string{"package": ids[1], "verdict": "accept", "note": "服务接口已复核"}, nil); err != nil {
		t.Fatal(err)
	}
	tasksWait(t, tt, "已完成 · 2 / 2 已采纳", 3*time.Second)
	tasksContains(t, tt, "已采纳：服务接口已复核")
	// Both archive endpoints return a Mission, and list separates archived tasks.
	click(t, tt, "归档")
	tasksWait(t, tt, "已归档（1）", 3*time.Second)
	click(t, tt, "已归档（1）")
	click(t, tt, "恢复")
	tasksWait(t, tt, "已归档（0）", 3*time.Second)
	click(t, tt, "产物 3")
	tasksContains(t, tt, "设计 v2", "2 个版本", "待拍板 1 项 · 验收清单 1 项", "验收报告", "通过 1 · 失败 1")
	click(t, tt, "2 个版本")
	tasksContains(t, tt, "设计 v1")
	var restored kernel.Mission
	if err := c.call("mission.show", map[string]string{"id": mission}, &restored); err != nil {
		t.Fatal(err)
	}
	if restored.Archived || restored.Owner == nil || restored.Owner.Session != "task-owner-claude" {
		t.Fatalf("恢复的任务: %+v", restored)
	}
}
