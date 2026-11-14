package engine

import "sort"

// Kinds lists the supported engine kinds.
func Kinds() []string {
	out := make([]string, 0, len(specs))
	for kind := range specs {
		out = append(out, kind)
	}
	sort.Strings(out)
	return out
}

// Known reports whether kind is a supported engine.
func Known(kind string) bool { _, ok := specs[kind]; return ok }
