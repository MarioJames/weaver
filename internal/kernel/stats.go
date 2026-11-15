package kernel

import (
	"database/sql"
	"math"
	"sort"
	"time"

	"github.com/MarioJames/weaver/internal/engine"
)

// PerformanceStats describes first-attempt acceptance and completed run duration.
type PerformanceStats struct {
	Samples             int     `json:"samples"`
	FirstAcceptanceRate float64 `json:"firstAcceptanceRate"`
	MedianSeconds       float64 `json:"medianSeconds"`
}
type BandStats struct {
	Band int `json:"band"`
	PerformanceStats
}
type WorkerStats struct {
	PerformanceStats
	Bands []BandStats `json:"bands"`
}
type statSample struct {
	n, accepted int
	durations   []float64
}

func (s *statSample) view() PerformanceStats {
	v := PerformanceStats{Samples: s.n, FirstAcceptanceRate: float64(s.accepted+4) / float64(s.n+5), MedianSeconds: 600}
	if len(s.durations) > 0 {
		values := append([]float64(nil), s.durations...)
		sort.Float64s(values)
		mid := len(values) / 2
		v.MedianSeconds = values[mid]
		if len(values)%2 == 0 {
			v.MedianSeconds = (values[mid-1] + values[mid]) / 2
		}
	}
	return v
}

type statBuckets struct {
	overall statSample
	bands   map[int]*statSample
}

func (t *tx) loadStats() (map[string]*statBuckets, *statSample, error) {
	rows, err := t.Query(`SELECT a.worker, a.n, a.state, a.failure_kind, a.started_at, a.finished_at, p.auto_accept, p.intelligence
 FROM attempts a JOIN packages p ON p.id=a.package_id JOIN workers w ON w.id=a.worker
 WHERE a.finished_at>=? AND a.finished_at<=? AND a.model=w.model AND a.effort=w.effort`, t.now-int64(30*24*time.Hour/time.Millisecond), t.now)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	all := &statSample{}
	workers := map[string]*statBuckets{}
	for rows.Next() {
		var id, state, failure string
		var n int
		var auto bool
		var start sql.NullInt64
		var finish int64
		var intelligence float64
		if err := rows.Scan(&id, &n, &state, &failure, &start, &finish, &auto, &intelligence); err != nil {
			return nil, nil, err
		}
		w := workers[id]
		if w == nil {
			w = &statBuckets{bands: map[int]*statSample{}}
			workers[id] = w
		}
		targets := []*statSample{all, &w.overall}
		if intelligence > 0 {
			band := int(math.Floor(intelligence))
			s := w.bands[band]
			if s == nil {
				s = &statSample{}
				w.bands[band] = s
			}
			targets = append(targets, s)
		}
		for _, s := range targets {
			if n == 1 && !auto && (state == StateAccepted || state == StateReturned || state == StateFailed) && failure != engine.FailQuota && failure != engine.FailRateLimit && failure != engine.FailAuth {
				s.n++
				if state == StateAccepted {
					s.accepted++
				}
			}
			if (state == StateAccepted || state == StateReturned) && start.Valid && finish >= start.Int64 {
				s.durations = append(s.durations, float64(finish-start.Int64)/1000)
			}
		}
	}
	return workers, all, rows.Err()
}
func (s *statBuckets) view() WorkerStats {
	v := WorkerStats{PerformanceStats: s.overall.view(), Bands: []BandStats{}}
	for b, sample := range s.bands {
		v.Bands = append(v.Bands, BandStats{Band: b, PerformanceStats: sample.view()})
	}
	sort.Slice(v.Bands, func(i, j int) bool { return v.Bands[i].Band < v.Bands[j].Band })
	return v
}

// Routing falls back independently for acceptance and duration.
func (s *statBuckets) performance(requirement float64, all *statSample) PerformanceStats {
	var choices []*statSample
	if s != nil {
		choices = append(choices, s.bands[int(math.Floor(requirement))], &s.overall)
	}
	choices = append(choices, all)
	v := PerformanceStats{FirstAcceptanceRate: 0.8, MedianSeconds: 600}
	rateFound, durationFound := false, false
	for _, sample := range choices {
		if sample == nil {
			continue
		}
		if !rateFound && sample.n >= 5 {
			raw := sample.view()
			v.FirstAcceptanceRate = raw.FirstAcceptanceRate
			v.Samples = raw.Samples
			rateFound = true
		}
		if !durationFound && len(sample.durations) >= 5 {
			v.MedianSeconds = sample.view().MedianSeconds
			durationFound = true
		}
	}
	if !rateFound && s != nil {
		raw := s.overall.view()
		v.FirstAcceptanceRate = raw.FirstAcceptanceRate
		v.Samples = raw.Samples
	}
	return v
}
