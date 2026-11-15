package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

// readAncestorProcess is replaceable so owner detection can be tested without
// depending on the agent running the tests.
var readAncestorProcess = readProcProcess

func readProcProcess(pid int) (int, string, error) {
	if runtime.GOOS != "linux" {
		return 0, "", fmt.Errorf("process ancestry unavailable on %s", runtime.GOOS)
	}
	dir := filepath.Join("/proc", strconv.Itoa(pid))
	stat, err := os.ReadFile(filepath.Join(dir, "stat"))
	if err != nil {
		return 0, "", err
	}
	// The parenthesized comm field may itself contain spaces and parentheses.
	end := strings.LastIndexByte(string(stat), ')')
	if end < 0 {
		return 0, "", fmt.Errorf("invalid process stat for %d", pid)
	}
	fields := strings.Fields(string(stat[end+1:]))
	if len(fields) < 2 {
		return 0, "", fmt.Errorf("missing parent in process stat for %d", pid)
	}
	parent, err := strconv.Atoi(fields[1])
	if err != nil {
		return 0, "", err
	}
	comm, err := os.ReadFile(filepath.Join(dir, "comm"))
	if err != nil {
		return 0, "", err
	}
	return parent, strings.TrimSuffix(string(comm), "\n"), nil
}

// ancestorAgent returns the closest agent, even if its session environment is
// missing: an outer agent's inherited session must not claim that mission.
func ancestorAgent() (string, bool) {
	seen := make(map[int]bool)
	for pid := os.Getppid(); pid > 0 && !seen[pid]; {
		seen[pid] = true
		parent, name, err := readAncestorProcess(pid)
		if err != nil {
			break
		}
		if name == "claude" || name == "codex" {
			return name, true
		}
		pid = parent
	}
	return "", false
}
