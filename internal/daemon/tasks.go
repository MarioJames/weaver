package daemon

import (
	"context"
	"encoding/json"

	"github.com/MarioJames/weaver/internal/kernel"
)

func init() {
	methods["mission.timeline"] = func(s *Server, ctx context.Context, params json.RawMessage, _ func(any) error) (any, error) {
		in, err := decode[kernel.TimelineInput](params)
		if err != nil {
			return nil, err
		}
		return s.kernel.Timeline(ctx, in)
	}
	methods["mission.text"] = simple(func(s *Server, p struct {
		Mission string `json:"mission"`
		Ref     string `json:"ref"`
	}) (any, error) {
		return s.kernel.MissionText(p.Mission, p.Ref)
	})
	methods["mission.owner"] = simple(func(s *Server, p struct {
		Mission string `json:"mission"`
		Engine  string `json:"engine"`
		Session string `json:"session"`
	}) (any, error) {
		return s.kernel.SetMissionOwner(p.Mission, p.Engine, p.Session)
	})
	methods["mission.transcript"] = simple(func(s *Server, p struct {
		Mission string `json:"mission"`
		After   int64  `json:"after"`
	}) (any, error) {
		return s.kernel.MissionTranscript(p.Mission, p.After)
	})
	methods["mission.archive"] = simple(func(s *Server, p struct {
		Mission string `json:"mission"`
	}) (any, error) {
		return s.kernel.ArchiveMission(p.Mission, true)
	})
	methods["mission.unarchive"] = simple(func(s *Server, p struct {
		Mission string `json:"mission"`
	}) (any, error) {
		return s.kernel.ArchiveMission(p.Mission, false)
	})
	methods["artifact.add"] = simple(func(s *Server, p kernel.ArtifactInput) (any, error) { return s.kernel.AddArtifact(p) })
	methods["artifact.list"] = simple(func(s *Server, p struct {
		Mission string `json:"mission"`
	}) (any, error) {
		return s.kernel.Artifacts(p.Mission)
	})
	methods["artifact.remove"] = simple(func(s *Server, p struct {
		ID string `json:"id"`
	}) (any, error) {
		return ok{true}, s.kernel.RemoveArtifact(p.ID)
	})
}
