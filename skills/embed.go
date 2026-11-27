// Package skills embeds the agent skill that ships with the weaver binary.
package skills

import (
	"embed"
	"io/fs"
	"sort"
	"strings"
)

// Weaver is the skill parent agents follow to drive Weaver. It keeps the name
// agents-weaver so that an upgrade replaces the skill agents already load.
//
//go:embed agents-weaver/SKILL.md
var Weaver string

// references holds what SKILL.md points to: text an agent reads only for the
// step it is about to take, so the skill itself stays short.
//
//go:embed agents-weaver/references/*.md
var references embed.FS

const referenceDir = "agents-weaver/references"

// References lists the reference names, without the .md suffix.
func References() []string {
	entries, _ := fs.ReadDir(references, referenceDir)
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, strings.TrimSuffix(entry.Name(), ".md"))
	}
	sort.Strings(names)
	return names
}

// Reference returns one reference by name.
func Reference(name string) (string, bool) {
	body, err := references.ReadFile(referenceDir + "/" + name + ".md")
	return string(body), err == nil
}
