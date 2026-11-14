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
