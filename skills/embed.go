// Package skills embeds the agent skill that ships with the weaver binary.
package skills

import _ "embed"

// Weaver is the skill parent agents follow to drive Weaver. It keeps the name
// agents-weaver so that an upgrade replaces the skill agents already load.
//
//go:embed agents-weaver/SKILL.md
var Weaver string
