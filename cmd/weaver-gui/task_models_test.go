package main

import (
	"reflect"
	"testing"

	"github.com/MarioJames/weaver/internal/kernel"
)

func TestTaskPlanCardsMatching(t *testing.T) {
	const at int64 = 1_000_000
	submit := func(offset int64, mission string) taskItem {
		return taskItem{At: at + offset, Role: "tool", Weaver: &kernel.WeaverCall{Command: "plan submit", Mission: mission}}
	}
	plan := func(offset int64) taskEvent {
		return taskEvent{At: at + offset, Kind: "plan", Mission: "main-full"}
	}
	pkg := func(key string, offset int64) taskPackage {
		return taskPackage{ID: "main-full/" + key, MissionID: "main-full", Key: key, CreatedAt: at + offset}
	}
	for _, tc := range []struct {
		name     string
		items    []taskItem
		events   []taskEvent
		packages []taskPackage
		want     map[int][]string
	}{
		{"future submit", []taskItem{submit(100_000, "main-full")}, []taskEvent{plan(0)}, []taskPackage{pkg("slow", 0)}, map[int][]string{-1: {"slow"}}},
		{"wrong mission", []taskItem{submit(0, "other")}, []taskEvent{plan(0)}, []taskPackage{pkg("slow", 0)}, map[int][]string{-1: {"slow"}}},
		{"mission prefix", []taskItem{submit(0, "main")}, []taskEvent{plan(0)}, []taskPackage{pkg("slow", 0)}, map[int][]string{0: {"slow"}}},
		{"no mission", []taskItem{submit(0, "")}, []taskEvent{plan(0)}, []taskPackage{pkg("slow", 0)}, map[int][]string{0: {"slow"}}},
		{"clock skew boundary", []taskItem{submit(5_000, "main-full")}, []taskEvent{plan(0)}, []taskPackage{pkg("slow", 0)}, map[int][]string{0: {"slow"}}},
		{"beyond clock skew", []taskItem{submit(5_001, "main-full")}, []taskEvent{plan(0)}, []taskPackage{pkg("slow", 0)}, map[int][]string{-1: {"slow"}}},
		{"lookback boundary", []taskItem{submit(-120_000, "main-full")}, []taskEvent{plan(0)}, []taskPackage{pkg("slow", 0)}, map[int][]string{0: {"slow"}}},
		{"too old", []taskItem{submit(-120_001, "main-full")}, []taskEvent{plan(0)}, []taskPackage{pkg("slow", 0)}, map[int][]string{-1: {"slow"}}},
		{"separate submits", []taskItem{submit(-1_000, "main-full"), submit(99_000, "main-full")}, []taskEvent{plan(0), plan(100_000)}, []taskPackage{pkg("slow", 0), pkg("fast", 100_000)}, map[int][]string{0: {"slow"}, 1: {"fast"}}},
		{"one submit claims nearest event", []taskItem{submit(-1_000, "main-full")}, []taskEvent{plan(10_000), plan(0)}, []taskPackage{pkg("later", 10_000), pkg("first", 0), pkg("sibling", 0)}, map[int][]string{-1: {"later"}, 0: {"first", "sibling"}}},
		{"nearest eligible submit", []taskItem{submit(-2_000, "main-full"), submit(-1_000, "main-full"), submit(0, "other")}, []taskEvent{plan(0)}, []taskPackage{pkg("slow", 0)}, map[int][]string{1: {"slow"}}},
		{"no plan", []taskItem{submit(0, "main-full")}, nil, []taskPackage{pkg("slow", 0)}, map[int][]string{-1: {"slow"}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := map[int][]string{}
			for index, packages := range taskPlanCards(tc.items, tc.events, tc.packages) {
				for _, p := range packages {
					got[index] = append(got[index], p.Key)
				}
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("card groups = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestTaskPlanCardsUnmatchedFallbackGroup(t *testing.T) {
	f, _, tt := tasksTester(t, 1440, 1000)
	f.taskMu.Lock()
	f.items[3].At = f.events[0].At + 100_000
	f.taskMu.Unlock()
	openTasksMain(t, tt)
	if _, exists := tt.Find("子 Agent"); !exists {
		t.Fatal("unmatched cards did not enter the 子 Agent group")
	}
	tasksContains(t, tt, "shell", "server")
}
