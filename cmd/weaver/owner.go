package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
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

// findMissionOwner only accepts a create call paired with its own tool result.
func findMissionOwner(mission string, roots map[string]string) (map[string]string, error) {
	var candidates []map[string]string
	for engine, root := range roots {
		err := filepath.WalkDir(root, func(path string, d fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				if os.IsNotExist(walkErr) {
					return nil
				}
				return walkErr
			}
			if d.IsDir() || !strings.HasSuffix(path, ".jsonl") {
				return nil
			}
			if engine == "codex" && !strings.HasPrefix(d.Name(), "rollout-") {
				return nil
			}
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			if !bytes.Contains(data, []byte(mission)) {
				return nil
			}
			calls := map[string]bool{}
			matched := false
			session := strings.TrimSuffix(d.Name(), ".jsonl")
			if engine == "codex" {
				session = rolloutPrefix.ReplaceAllString(session, "")
				if strings.HasPrefix(session, "rollout-") {
					session = session[strings.LastIndex(session, "-")+1:]
				}
			}
			scanner := bufio.NewScanner(bytes.NewReader(data))
			scanner.Buffer(make([]byte, 4096), 64<<20)
			for scanner.Scan() {
				var row map[string]any
				if json.Unmarshal(scanner.Bytes(), &row) != nil {
					continue
				}
				if engine == "codex" {
					p, _ := row["payload"].(map[string]any)
					typ, _ := p["type"].(string)
					id, _ := p["call_id"].(string)
					if row["type"] == "session_meta" {
						if sid, ok := p["id"].(string); ok && sid != "" {
							session = sid
						}
					}
					if typ == "function_call" || typ == "custom_tool_call" {
						input := p["arguments"]
						if input == nil {
							input = p["input"]
						}
						calls[id] = isMissionCreate(input)
					}
					if (typ == "function_call_output" || typ == "custom_tool_call_output") && calls[id] && hasMissionID(p["output"], mission) {
						matched = true
					}
				} else {
					msg, _ := row["message"].(map[string]any)
					blocks, _ := msg["content"].([]any)
					for _, block := range blocks {
						b, _ := block.(map[string]any)
						id, _ := b["id"].(string)
						if b["type"] == "tool_use" {
							calls[id] = isMissionCreate(b["input"])
						}
						call, _ := b["tool_use_id"].(string)
						if b["type"] == "tool_result" && calls[call] && hasMissionID(b["content"], mission) {
							matched = true
						}
					}
				}
			}
			if err = scanner.Err(); err != nil {
				return err
			}
			if matched {
				candidates = append(candidates, map[string]string{"engine": engine, "session": session})
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i]["engine"]+candidates[i]["session"] < candidates[j]["engine"]+candidates[j]["session"]
	})
	if len(candidates) != 1 {
		return nil, fmt.Errorf("父会话匹配数为 %d，候选：%v", len(candidates), candidates)
	}
	return candidates[0], nil
}

var rolloutPrefix = regexp.MustCompile(`^rollout-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-`)
var missionCreatePattern = regexp.MustCompile(`(?:^|[\s/;|&"'])weaver\s+mission\s+create(?:\s|$)`)

func isMissionCreate(input any) bool {
	if s, ok := input.(string); ok {
		var v any
		if json.Unmarshal([]byte(s), &v) == nil {
			return isMissionCreate(v)
		}
		return missionCreatePattern.MatchString(s)
	}
	p, _ := input.(map[string]any)
	for _, key := range []string{"cmd", "command"} {
		if s, ok := p[key].(string); ok && missionCreatePattern.MatchString(s) {
			return true
		}
	}
	return false
}
func hasMissionID(v any, mission string) bool {
	if s, ok := v.(string); ok {
		pattern := regexp.MustCompile(`"id"\s*:\s*"` + regexp.QuoteMeta(mission) + `"`)
		return pattern.MatchString(s)
	}
	if blocks, ok := v.([]any); ok {
		for _, block := range blocks {
			b, _ := block.(map[string]any)
			if hasMissionID(b["text"], mission) {
				return true
			}
		}
	}
	return false
}
