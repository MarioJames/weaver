package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/MarioJames/weaver/skills"
)

// An upgrade from 0.7 finds the old skill at the same place. Its command set is
// gone, so nothing of it may survive next to the new SKILL.md.
func TestSkillInstallReplacesAnOlderCopyAndLinksTheAgents(t *testing.T) {
	home := t.TempDir()
	old := filepath.Join(home, ".agents", "skills", "agents-weaver")
	must(t, os.MkdirAll(filepath.Join(old, "references"), 0o755))
	must(t, os.WriteFile(filepath.Join(old, "SKILL.md"), []byte("weaver owners register"), 0o644))
	must(t, os.WriteFile(filepath.Join(old, "references", "config.md"), []byte("0.7"), 0o644))
	must(t, os.MkdirAll(filepath.Join(home, ".claude", "skills"), 0o755))
	// Codex has a skill of that name the user placed there: not ours to replace.
	foreign := filepath.Join(home, ".codex", "skills", "agents-weaver")
	must(t, os.MkdirAll(foreign, 0o755))

	res, err := installSkill(home)
	if err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(filepath.Join(old, "SKILL.md"))
	if err != nil || string(body) != skills.Weaver {
		t.Fatalf("SKILL.md is not the embedded skill: %v", err)
	}
	if _, err := os.Stat(filepath.Join(old, "references")); !os.IsNotExist(err) {
		t.Error("files of the older skill were left behind")
	}
	link := filepath.Join(home, ".claude", "skills", "agents-weaver")
	if target, err := os.Readlink(link); err != nil || target != old {
		t.Errorf("claude link = %q, %v; want %s", target, err, old)
	}
	if info, err := os.Lstat(foreign); err != nil || !info.IsDir() {
		t.Error("a skill directory Weaver did not link was replaced")
	}
	if len(res.Links) != 1 || len(res.Skipped) != 1 || !strings.Contains(res.Skipped[0], ".codex") {
		t.Errorf("result = %+v", res)
	}

	// Running it again updates in place.
	if _, err := installSkill(home); err != nil {
		t.Fatalf("second install: %v", err)
	}
}

func TestSkillIsNamedAgentsWeaverAndSpeaksOfOneWeaver(t *testing.T) {
	if !strings.Contains(skills.Weaver, "\nname: agents-weaver\n") {
		t.Error("the skill keeps the name agents load it by: agents-weaver")
	}
	for name, text := range map[string]string{"help": usage, "skill": skills.Weaver} {
		if strings.Contains(strings.ToLower(text), "weaver2") || strings.Contains(text, "Weaver 2") {
			t.Errorf("%s still names a separate Weaver 2", name)
		}
	}
}

func TestOldStyleFlagsStillReachVersionAndSkill(t *testing.T) {
	for flag, want := range map[string]string{"--version": "version", "--skill": "skill", "--help": "help", "-h": "help", "status": "status"} {
		if got := canonical([]string{flag})[0]; got != want {
			t.Errorf("%s runs %q, want %q", flag, got, want)
		}
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func TestMissionOwnerEnvironmentAndOverrides(t *testing.T) {
	original := readAncestorProcess
	readAncestorProcess = func(int) (int, string, error) { return 0, "", os.ErrNotExist }
	t.Cleanup(func() { readAncestorProcess = original })
	t.Setenv("CLAUDE_CODE_SESSION_ID", "claude-session")
	t.Setenv("CODEX_THREAD_ID", "codex-session")
	a, err := parse(nil)
	if err != nil {
		t.Fatal(err)
	}
	owner := missionOwner(a)
	if owner["engine"] != "claude" || owner["session"] != "claude-session" {
		t.Fatal(owner)
	}
	t.Setenv("CLAUDE_CODE_SESSION_ID", "")
	owner = missionOwner(a)
	if owner["engine"] != "codex" || owner["session"] != "codex-session" {
		t.Fatal(owner)
	}
	a, err = parse([]string{"--owner-engine", "other", "--owner-session", "override"})
	if err != nil {
		t.Fatal(err)
	}
	owner = missionOwner(a)
	if owner["engine"] != "other" || owner["session"] != "override" {
		t.Fatal(owner)
	}
	t.Setenv("CODEX_THREAD_ID", "")
	a, _ = parse(nil)
	owner = missionOwner(a)
	if owner["engine"] != "" || owner["session"] != "" {
		t.Fatal(owner)
	}
}

func TestMissionOwnerNearestAncestor(t *testing.T) {
	for _, tc := range []struct {
		name, nearest, outer, claudeSession, codexSession, engine, session string
		flags                                                              []string
	}{
		{name: "claude launches codex", nearest: "codex", outer: "claude", claudeSession: "claude-session", codexSession: "codex-session", engine: "codex", session: "codex-session"},
		{name: "codex launches claude", nearest: "claude", outer: "codex", claudeSession: "claude-session", codexSession: "codex-session", engine: "claude", session: "claude-session"},
		{name: "codex session missing", nearest: "codex", outer: "claude", claudeSession: "claude-session"},
		{name: "claude session missing", nearest: "claude", outer: "codex", codexSession: "codex-session"},
		{name: "explicit override", nearest: "codex", outer: "claude", claudeSession: "claude-session", codexSession: "codex-session", flags: []string{"--owner-engine", "other", "--owner-session", "override"}, engine: "other", session: "override"},
		{name: "no agent ancestor", nearest: "zsh", outer: "systemd", claudeSession: "claude-session", codexSession: "codex-session", engine: "claude", session: "claude-session"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("CLAUDE_CODE_SESSION_ID", tc.claudeSession)
			t.Setenv("CODEX_THREAD_ID", tc.codexSession)
			original := readAncestorProcess
			readAncestorProcess = func(pid int) (int, string, error) {
				if pid == os.Getppid() {
					return os.Getppid() + 1, "sh", nil
				}
				if pid == os.Getppid()+1 {
					return os.Getppid() + 2, tc.nearest, nil
				}
				if pid == os.Getppid()+2 {
					return 0, tc.outer, nil
				}
				return 0, "", os.ErrNotExist
			}
			t.Cleanup(func() { readAncestorProcess = original })
			a, err := parse(tc.flags)
			must(t, err)
			owner := missionOwner(a)
			if owner["engine"] != tc.engine || owner["session"] != tc.session {
				t.Fatalf("owner = %v, want engine=%q session=%q", owner, tc.engine, tc.session)
			}
		})
	}
}

func TestWorkerRejectsWeightFlag(t *testing.T) {
	err := run([]string{"worker", "set", "candidate", "--weight", "8"})
	if err == nil || !strings.Contains(err.Error(), "未知选项 --weight") {
		t.Fatalf("%v", err)
	}
}

func TestWorkerRejectsInvalidIntelligenceBeforeRPC(t *testing.T) {
	for _, score := range []string{"7.3", "0.5", "11", "NaN", "+Inf"} {
		err := run([]string{"worker", "set", "candidate", "--intelligence", score})
		if err == nil || !strings.Contains(err.Error(), "INVALID") {
			t.Fatalf("%s: %v", score, err)
		}
	}
}
