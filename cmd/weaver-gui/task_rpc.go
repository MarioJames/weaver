package main

import (
	"fmt"
	"math"
	"os"
	"sort"
	"time"
)

// Called while app.mu is held; all RPC work uses captured values and returns
// through app.action, the same busy/error/cancellation boundary as other pages.
// Only the list polls here: an open detail follows its timeline instead.
func (a *app) pollTasks(s *taskState, force bool) {
	if s.selected != "" {
		return
	}
	if !force && time.Now().Before(s.nextPoll) {
		return
	}
	if a.busy["tasks:poll"] {
		return
	}
	s.nextPoll = time.Now().Add(2 * time.Second)
	a.action("tasks:poll", func() (string, error) {
		var missions, archived []taskMission
		if err := a.client.call("mission.list", map[string]bool{"all": true}, &missions); err != nil {
			return "", err
		}
		if err := a.client.call("mission.list", map[string]bool{"all": true, "archived": true}, &archived); err != nil {
			return "", err
		}
		a.mu.Lock()
		defer a.mu.Unlock()
		if a.ctx.Err() != nil {
			return "", nil
		}
		sort.SliceStable(archived, func(i, j int) bool { return archived[i].LastActivityAt > archived[j].LastActivityAt })
		s.missions, s.archived, s.loaded = missions, archived, true
		return "", nil
	}, func(_ string, err error) {
		s.error = ""
		if err != nil {
			s.error = err.Error()
		}
	})
}

// selectTask opens a mission's detail: one timeline read now, then a follow loop.
func (a *app) selectTask(s *taskState, id string) {
	s.revision++
	s.selected = id
	var seed *taskMission
	for _, m := range append(append([]taskMission{}, s.missions...), s.archived...) {
		if m.ID == id {
			m := m
			seed = &m
		}
	}
	s.d = newTaskDetail(seed)
	a.watchTask(s, id, s.revision)
}

// leaveTask returns to the list; the revision bump stops the follow loop and
// keeps its last answer from reaching whatever opens next.
func (a *app) leaveTask(s *taskState) {
	s.revision++
	s.selected = ""
	s.d = taskDetail{}
	s.nextPoll = time.Time{}
	a.pollTasks(s, true)
}

func (s *taskState) current(id string, revision int64) bool {
	return s.selected == id && s.revision == revision
}

// watchTask reads the newest page, then long-polls for the changed suffix with
// the entries it already has. Called with a.mu held.
func (a *app) watchTask(s *taskState, id string, revision int64) {
	a.wg.Add(1)
	go func() {
		defer a.wg.Done()
		for {
			a.mu.Lock()
			if a.ctx.Err() != nil || !s.current(id, revision) {
				a.mu.Unlock()
				return
			}
			in := taskTimelineInput{Mission: id}
			gen := s.d.gen
			if n := len(s.d.entries); n > 0 {
				in.From, in.Wait = s.d.entries[0].Ord, true
				in.Have = make([]string, n)
				for i, e := range s.d.entries {
					in.Have[i] = e.Hash
				}
			}
			a.mu.Unlock()
			var out taskTimeline
			err := a.client.call("mission.timeline", in, &out)
			a.mu.Lock()
			if a.ctx.Err() != nil || !s.current(id, revision) {
				a.mu.Unlock()
				return
			}
			if err != nil {
				s.d.err = err.Error()
				a.notify()
				a.mu.Unlock()
				select {
				case <-a.ctx.Done():
					return
				case <-time.After(2 * time.Second):
				}
				continue
			}
			s.d.err = ""
			// Older entries arrived while this request was out; ask again with the new window.
			if gen == s.d.gen {
				a.applyTimeline(s, in.From != "", &out)
			}
			a.notify()
			a.mu.Unlock()
		}
	}()
}

func (a *app) applyTimeline(s *taskState, suffix bool, out *taskTimeline) {
	d := &s.d
	first := !d.loaded
	// A follow request also returns when its wait runs out with nothing new;
	// only an answer that changes the entries counts as growth.
	changed := !suffix || len(out.Entries) > 0 || out.Keep != len(d.entries)
	if suffix {
		d.entries = taskMergeEntries(d.entries, out.Entries, out.Keep)
	} else {
		d.entries = out.Entries
	}
	d.hasMore = out.HasMore
	if out.Mission != nil {
		d.mission = out.Mission
	}
	d.packages, d.session = out.Packages, out.Session
	d.loaded = true
	d.grew = d.grew || changed
	if first && d.mission != nil && !taskMissionDone(*d.mission) {
		d.pinned = true
	}
}

// loadEarlier prepends the page before the first entry, keeping the reading position.
func (a *app) loadEarlier(s *taskState) {
	d := &s.d
	if d.loadingMore || len(d.entries) == 0 {
		return
	}
	id, revision, before := s.selected, s.revision, d.entries[0].Ord
	d.loadingMore = true
	a.wg.Add(1)
	go func() {
		defer a.wg.Done()
		var out taskTimeline
		err := a.client.call("mission.timeline", taskTimelineInput{Mission: id, Before: before}, &out)
		a.mu.Lock()
		defer a.mu.Unlock()
		if a.ctx.Err() != nil || !s.current(id, revision) {
			return
		}
		d := &s.d
		d.loadingMore = false
		if err != nil {
			d.err = err.Error()
		} else if len(out.Entries) > 0 && len(d.entries) > 0 && d.entries[0].Ord == before {
			// Content grows above the viewport; the next frame keeps the distance to the end.
			d.prepended = true
			d.entries = append(append([]taskEntry{}, out.Entries...), d.entries...)
			d.hasMore = out.HasMore
			d.gen++
		}
		a.notify()
	}()
}

// openText reads a body by its ref and shows it in the full-text drawer.
func (a *app) openText(s *taskState, ref string, header taskHeaderInfo) {
	d := &s.d
	d.textSeq++
	seq, id, revision := d.textSeq, s.selected, s.revision
	d.textOpen, d.textLoading, d.textErr, d.textTitle, d.textBody, d.textHeader = true, true, "", "", "", header
	a.action(fmt.Sprintf("tasks:text:%d", seq), func() (string, error) {
		var out taskTextResult
		err := a.client.call("mission.text", map[string]string{"mission": id, "ref": ref}, &out)
		a.mu.Lock()
		defer a.mu.Unlock()
		if s.current(id, revision) && s.d.textSeq == seq {
			s.d.textLoading = false
			if err != nil {
				s.d.textErr = err.Error()
			} else {
				s.d.textTitle, s.d.textBody = out.Title, out.Text
			}
		}
		return "", nil
	}, nil)
}

// openPackage shows every attempt of one package in the package drawer.
func (a *app) openPackage(s *taskState, key string) {
	d := &s.d
	d.packageSeq++
	seq, id, revision := d.packageSeq, s.selected, s.revision
	d.packageOpen, d.packageLoading, d.packageErr, d.packageKey, d.packageData = true, true, "", key, taskPackage{}
	a.action(fmt.Sprintf("tasks:package:%d", seq), func() (string, error) {
		var out taskPackage
		err := a.client.call("package.show", map[string]string{"package": id + "/" + key}, &out)
		a.mu.Lock()
		defer a.mu.Unlock()
		if s.current(id, revision) && s.d.packageSeq == seq {
			s.d.packageLoading = false
			if err != nil {
				s.d.packageErr = err.Error()
			} else {
				s.d.packageData = out
			}
		}
		return "", nil
	}, nil)
}

// openArtifacts lists the mission's artifacts; nothing is read until the panel opens.
func (a *app) openArtifacts(s *taskState) {
	d := &s.d
	d.artifactsOpen, d.artifactsLoading, d.artifactsErr = true, true, ""
	id, revision := s.selected, s.revision
	a.action("tasks:artifacts:"+id, func() (string, error) {
		var groups []taskArtifactGroup
		err := a.client.call("artifact.list", map[string]string{"mission": id}, &groups)
		a.mu.Lock()
		defer a.mu.Unlock()
		if s.current(id, revision) {
			s.d.artifactsLoading = false
			if err != nil {
				s.d.artifactsErr = err.Error()
			} else {
				s.d.artifacts = groups
			}
		}
		return "", nil
	}, nil)
}

func (a *app) taskArchive(s *taskState, id string, archive bool) {
	method := "mission.unarchive"
	if archive {
		method = "mission.archive"
	}
	a.action("tasks:archive:"+id, func() (string, error) { return "", a.client.call(method, map[string]string{"mission": id}, nil) }, func(_ string, err error) {
		if err != nil {
			return
		}
		if archive && s.selected == id {
			// Back to the list as the reader left it; the task now sits under 已归档.
			s.revision++
			s.selected = ""
			s.d = taskDetail{}
		}
		s.nextPoll = time.Time{}
		a.pollTasks(s, true)
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

// followBottom keeps an open, running task at its newest content until the
// reader scrolls up, and resumes once they are back at the end. It moves the
// page only when the content changed size: writing the offset every frame
// would cancel a mouse wheel's glide on its first small step.
func (d *taskDetail) followBottom() {
	atEnd := d.scroll.Y >= d.scroll.MaxY-4
	if d.prepended {
		// The scroll state still describes the layout before the prepend.
		d.prepended, d.restoreOpen, d.restoreAbove, d.restoreMax = false, true, d.scroll.MaxY-d.scroll.Y, d.scroll.MaxY
	}
	if d.restoreOpen {
		if d.scroll.MaxY != d.restoreMax {
			d.scroll.Y = max(0, d.scroll.MaxY-d.restoreAbove)
			d.restoreOpen = false
		}
		d.seenMax, d.grew = d.scroll.MaxY, false
		return
	}
	if d.mission == nil || taskMissionDone(*d.mission) {
		return
	}
	changed := d.grew || d.scroll.MaxY != d.seenMax
	switch {
	case d.pinned && changed:
		// Still where the end was before the content changed: go to the new end.
		if d.scroll.Y >= d.seenMax-4 {
			d.scroll.Y = math.MaxFloat32
		} else {
			d.pinned = false
		}
	case d.pinned && !atEnd:
		d.pinned = false
	case !d.pinned && atEnd && d.scroll.MaxY > 0:
		d.pinned = true
	}
	d.seenMax, d.grew = d.scroll.MaxY, false
}
