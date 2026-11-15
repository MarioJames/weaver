package main

import (
	"fmt"
	"os"
	"sort"
	"time"

	"github.com/egoist/mygo/ui"
)

// Called while app.mu is held; all RPC work uses captured values and returns
// through app.action, the same busy/error/cancellation boundary as other pages.
func (a *app) pollTasks(s *taskState, force bool) {
	if !force && time.Now().Before(s.nextPoll) {
		return
	}
	if a.busy["tasks:poll"] {
		return
	}
	s.nextPoll = time.Now().Add(2 * time.Second)
	selected := s.selected
	revision := s.revision
	after := s.transcript.Next
	eventAfter := int64(0)
	if len(s.events) > 0 {
		eventAfter = s.events[len(s.events)-1].Seq
	}
	a.action("tasks:poll", func() (string, error) {
		var missions, archived []taskMission
		if err := a.client.call("mission.list", map[string]bool{"all": true}, &missions); err != nil {
			return "", err
		}
		if err := a.client.call("mission.list", map[string]bool{"all": true, "archived": true}, &archived); err != nil {
			return "", err
		}
		var detail taskDetail
		var events []taskEvent
		var artifacts []taskArtifactGroup
		var transcript taskTranscript
		var transcriptError string
		var readErr error
		if selected != "" {
			readErr = a.client.call("mission.show", map[string]string{"id": selected}, &detail)
			if readErr == nil {
				cursor := eventAfter
				for {
					var page []taskEvent
					readErr = a.client.call("events", map[string]any{"mission": selected, "after": cursor, "limit": 1000}, &page)
					if readErr != nil {
						break
					}
					events = append(events, page...)
					if len(page) < 1000 {
						break
					}
					next := page[len(page)-1].Seq
					if next <= cursor {
						break
					}
					cursor = next
				}
			}
			if readErr == nil {
				readErr = a.client.call("artifact.list", map[string]string{"mission": selected}, &artifacts)
			}
			if err := a.client.call("mission.transcript", map[string]any{"mission": selected, "after": after}, &transcript); err != nil {
				transcriptError = err.Error()
			}
			// package.show carries all attempts and their complete instruction/results.
			for i, p := range detail.Packages {
				var full taskPackage
				if err := a.client.call("package.show", map[string]string{"package": p.ID}, &full); err != nil {
					if readErr == nil {
						readErr = err
					}
				} else {
					detail.Packages[i] = full
				}
			}
		}
		a.mu.Lock()
		defer a.mu.Unlock()
		if a.ctx.Err() != nil {
			return "", nil
		}
		sort.SliceStable(archived, func(i, j int) bool { return archived[i].LastActivityAt > archived[j].LastActivityAt })
		s.missions, s.archived = missions, archived
		if s.selected == selected && s.revision == revision {
			s.detail, s.artifacts = detail, artifacts
			if eventAfter == 0 {
				s.events = events
			} else {
				s.events = append(s.events, events...)
			}
			s.transcriptError = transcriptError
			if transcriptError == "" {
				if after == 0 || transcript.Next < after || s.transcript.Session != transcript.Session {
					s.transcript = transcript
				} else {
					s.transcript.Items = append(s.transcript.Items, transcript.Items...)
					s.transcript.Next = transcript.Next
					s.transcript.Path = transcript.Path
				}
				sort.SliceStable(s.transcript.Items, func(i, j int) bool { return s.transcript.Items[i].At < s.transcript.Items[j].At })
			}
		}
		return "", readErr
	}, func(_ string, err error) {
		s.error = ""
		if err != nil {
			s.error = err.Error()
		}
	})
}
func (a *app) selectTask(s *taskState, id string) {
	if s.selected != id {
		s.revision++
		s.selected = id
		s.selectedPackage = ""
		s.detail = taskDetail{}
		s.events = nil
		s.artifacts = nil
		s.transcript = taskTranscript{}
		s.transcriptError = ""
		s.renderedNext = 0
		s.scroll = ui.ScrollState{}
		s.expanded = map[string]bool{}
	}
	s.pane = "chat"
	s.nextPoll = time.Time{}
	a.pollTasks(s, true)
}
func (a *app) taskArchive(s *taskState, id string, archive bool) {
	method := "mission.unarchive"
	if archive {
		method = "mission.archive"
	}
	a.action("tasks:archive:"+id, func() (string, error) { return "", a.client.call(method, map[string]string{"mission": id}, nil) }, func(_ string, err error) {
		if err == nil {
			s.nextPoll = time.Time{}
			a.pollTasks(s, true)
		}
	})
}
func taskArtifactTarget(a taskArtifact) (string, error) {
	if a.Path != "" {
		if st, err := os.Stat(a.Path); err == nil && st.Mode().IsRegular() {
			return a.Path, nil
		}
	}
	if a.URL != "" {
		return a.URL, nil
	}
	return "", fmt.Errorf("本地文件不存在，且未登记线上链接")
}
