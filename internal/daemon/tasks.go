package daemon

import "github.com/MarioJames/weaver/internal/kernel"

func init() {
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
