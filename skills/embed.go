// Package skills embeds the agent skill that ships with the weaver binary.
package skills

import _ "embed"

// Weaver2 is the skill parent agents follow to drive Weaver 2.
//
//go:embed weaver2/SKILL.md
var Weaver2 string
