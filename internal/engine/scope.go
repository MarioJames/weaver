package engine

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func canonicalDirectory(dir string) string {
	absolute, err := filepath.Abs(dir)
	if err != nil {
		return filepath.Clean(dir)
	}
	// Resolve existing ancestors too, so a not-yet-created home under a symlink
	// gets the same identity before and after MkdirAll.
	ancestor := absolute
	var suffix []string
	for {
		if resolved, err := filepath.EvalSymlinks(ancestor); err == nil {
			for i := len(suffix) - 1; i >= 0; i-- {
				resolved = filepath.Join(resolved, suffix[i])
			}
			return resolved
		}
		parent := filepath.Dir(ancestor)
		if parent == ancestor {
			return absolute
		}
		suffix = append(suffix, filepath.Base(ancestor))
		ancestor = parent
	}
}

// scopeInDirectory checks a live process rather than trusting a stale run
// directory on disk. In particular, legacy resident names may have been reused
// by another data directory since their record was saved.
func scopeInDirectory(command func(string, ...string) *exec.Cmd, unit, dir string) bool {
	out, err := command("systemctl", "--user", "show", unit+".scope", "-p", "ControlGroup", "--value").Output()
	if err != nil {
		return false
	}
	group := strings.TrimSpace(string(out))
	if !filepath.IsAbs(group) || filepath.Clean(group) != group || group == "/" {
		return false
	}
	pids, err := os.ReadFile(filepath.Join("/sys/fs/cgroup", group, "cgroup.procs"))
	if err != nil {
		return false
	}
	expected := canonicalDirectory(dir)
	for _, pid := range strings.Fields(string(pids)) {
		cwd, err := os.Readlink(filepath.Join("/proc", pid, "cwd"))
		if err == nil && canonicalDirectory(cwd) == expected {
			return true
		}
	}
	return false
}
