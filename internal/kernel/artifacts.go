package kernel

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"golang.org/x/net/html"
)

type ArtifactInput struct {
	Mission string `json:"mission"`
	Kind    string `json:"kind"`
	Title   string `json:"title"`
	Path    string `json:"path"`
	URL     string `json:"url"`
	Package string `json:"package"`
}
type Artifact struct {
	ID         string          `json:"id"`
	MissionID  string          `json:"missionId"`
	PackageKey string          `json:"packageKey,omitempty"`
	Kind       string          `json:"kind"`
	Title      string          `json:"title"`
	GroupKey   string          `json:"groupKey"`
	Path       string          `json:"path,omitempty"`
	URL        string          `json:"url,omitempty"`
	SHA256     string          `json:"sha256,omitempty"`
	Size       int64           `json:"size"`
	Summary    json.RawMessage `json:"summary"`
	CreatedAt  int64           `json:"createdAt"`
}
type ArtifactGroup struct {
	GroupKey string      `json:"groupKey"`
	Items    []*Artifact `json:"items"`
}

var versionSuffix = regexp.MustCompile(`-v[0-9]+$`)

func attr(n *html.Node, key string) string {
	for _, a := range n.Attr {
		if a.Key == key {
			return a.Val
		}
	}
	return ""
}
func class(n *html.Node, c string) bool {
	for _, s := range strings.Fields(attr(n, "class")) {
		if s == c {
			return true
		}
	}
	return false
}
func nodeText(n *html.Node) string {
	if n.Type == html.TextNode {
		return n.Data
	}
	var b strings.Builder
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		b.WriteString(nodeText(c))
	}
	return strings.TrimSpace(b.String())
}
func inspectHTML(r io.Reader) (string, map[string]any, map[string]int, string) {
	root, err := html.Parse(r)
	if err != nil {
		return "", nil, nil, ""
	}
	title, verdict := "", ""
	decisions, checks := 0, 0
	statuses := map[string]int{}
	var walk func(*html.Node, bool)
	walk = func(n *html.Node, inVerdict bool) {
		if n.Type == html.ElementNode {
			if n.Data == "title" {
				title = nodeText(n)
			}
			if class(n, "decision") {
				decisions++
			}
			for _, a := range n.Attr {
				if a.Key == "data-check-id" {
					checks++
				}
				if a.Key == "data-status" {
					statuses[a.Val]++
				}
			}
			inVerdict = inVerdict || class(n, "verdict")
			if inVerdict && class(n, "chip") && verdict == "" {
				verdict = nodeText(n)
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c, inVerdict)
		}
	}
	walk(root, false)
	return title, map[string]any{"decisions": decisions, "checks": checks}, statuses, verdict
}
func (k *Kernel) AddArtifact(in ArtifactInput) (*Artifact, error) {
	if in.Path == "" && in.URL == "" {
		return nil, errf("INVALID", "产物需要 path 或 url")
	}
	a := &Artifact{ID: newID("art_"), MissionID: in.Mission, PackageKey: in.Package, Kind: in.Kind, Title: in.Title, Path: in.Path, URL: in.URL, Summary: json.RawMessage(`{}`)}
	name := ""
	var design map[string]any
	var statuses map[string]int
	var verdict, htmlTitle string
	if in.URL != "" {
		u, err := url.Parse(in.URL)
		if err != nil {
			return nil, errf("INVALID", "产物 URL 不合法")
		}
		name = filepath.Base(u.Path)
	}
	if in.Path != "" {
		if !filepath.IsAbs(in.Path) {
			return nil, errf("INVALID", "产物路径必须是存在的绝对路径")
		}
		f, err := os.Open(in.Path)
		if err != nil {
			return nil, errf("INVALID", "产物路径不存在：%s", in.Path)
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil || !info.Mode().IsRegular() {
			return nil, errf("INVALID", "产物路径必须是文件")
		}
		name = filepath.Base(in.Path)
		h := sha256.New()
		a.Size, err = io.Copy(h, f)
		if err != nil {
			return nil, err
		}
		a.SHA256 = hex.EncodeToString(h.Sum(nil))
		if strings.EqualFold(filepath.Ext(name), ".html") || strings.EqualFold(filepath.Ext(name), ".htm") {
			if _, err = f.Seek(0, 0); err != nil {
				return nil, err
			}
			htmlTitle, design, statuses, verdict = inspectHTML(f)
		}
	}
	if a.Kind == "" {
		switch {
		case strings.EqualFold(name, "REPORT.html") || len(statuses) > 0:
			a.Kind = "report"
		case design != nil && design["decisions"].(int) > 0 && design["checks"].(int) > 0:
			a.Kind = "design"
		default:
			switch strings.ToLower(filepath.Ext(name)) {
			case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".tif", ".tiff", ".avif", ".ico", ".heic", ".log", ".json", ".jsonl", ".ndjson":
				a.Kind = "evidence"
			default:
				a.Kind = "doc"
			}
		}
	}
	switch a.Kind {
	case "design":
		if design == nil {
			design = map[string]any{"decisions": 0, "checks": 0}
		}
		a.Summary, _ = json.Marshal(design)
	case "report":
		summary := map[string]any{}
		for key, n := range statuses {
			summary[key] = n
		}
		if verdict != "" {
			summary["verdict"] = verdict
		}
		a.Summary, _ = json.Marshal(summary)
	case "evidence", "doc":
	default:
		return nil, errf("INVALID", "未知产物类型 %s", a.Kind)
	}
	if a.Title == "" {
		a.Title = htmlTitle
		if a.Title == "" {
			a.Title = name
		}
	}
	a.GroupKey = versionSuffix.ReplaceAllString(strings.TrimSuffix(name, filepath.Ext(name)), "")
	if a.GroupKey == "" {
		a.GroupKey = a.Title
	}
	err := k.write(func(t *tx) error {
		if _, err := getMission(t, in.Mission); err != nil {
			return err
		}
		a.CreatedAt = t.now
		if a.URL != "" {
			var oldPath, oldHash string
			var oldSize int64
			err := t.QueryRow(`SELECT id,created_at,path,sha256,size FROM artifacts WHERE mission_id=? AND url=?`, a.MissionID, a.URL).Scan(&a.ID, &a.CreatedAt, &oldPath, &oldHash, &oldSize)
			if err != nil && err != sql.ErrNoRows {
				return err
			}
			if err == nil && a.Path == "" {
				a.Path, a.SHA256, a.Size = oldPath, oldHash, oldSize
			}
		}
		_, err := t.Exec(`INSERT INTO artifacts(id,mission_id,package_key,kind,title,group_key,path,url,sha256,size,summary,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET package_key=excluded.package_key,kind=excluded.kind,title=excluded.title,group_key=excluded.group_key,path=excluded.path,sha256=excluded.sha256,size=excluded.size,summary=excluded.summary`, a.ID, a.MissionID, a.PackageKey, a.Kind, a.Title, a.GroupKey, a.Path, a.URL, a.SHA256, a.Size, string(a.Summary), a.CreatedAt)
		return err
	})
	return a, err
}
func (k *Kernel) Artifacts(mission string) ([]ArtifactGroup, error) {
	out := []ArtifactGroup{}
	err := k.read(func() error {
		if _, err := getMission(k.db, mission); err != nil {
			return err
		}
		rows, err := k.db.Query(`SELECT id,mission_id,package_key,kind,title,group_key,path,url,sha256,size,summary,created_at FROM artifacts WHERE mission_id=? ORDER BY group_key,created_at DESC,rowid DESC`, mission)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			a := &Artifact{}
			var summary string
			if err := rows.Scan(&a.ID, &a.MissionID, &a.PackageKey, &a.Kind, &a.Title, &a.GroupKey, &a.Path, &a.URL, &a.SHA256, &a.Size, &summary, &a.CreatedAt); err != nil {
				return err
			}
			a.Summary = json.RawMessage(summary)
			if len(out) == 0 || out[len(out)-1].GroupKey != a.GroupKey {
				out = append(out, ArtifactGroup{GroupKey: a.GroupKey, Items: []*Artifact{}})
			}
			out[len(out)-1].Items = append(out[len(out)-1].Items, a)
		}
		return rows.Err()
	})
	return out, err
}
func (k *Kernel) RemoveArtifact(id string) error {
	return k.write(func(t *tx) error {
		r, err := t.Exec(`DELETE FROM artifacts WHERE id=?`, id)
		if err != nil {
			return err
		}
		n, err := r.RowsAffected()
		if err == nil && n == 0 {
			return errf("NOT_FOUND", "产物不存在")
		}
		return err
	})
}
