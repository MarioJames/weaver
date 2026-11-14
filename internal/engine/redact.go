package engine

import (
	"regexp"
	"strings"
)

const redacted = "[REDACTED]"

var (
	reKeyValue   = regexp.MustCompile(`(?i)(["']?(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|authorization|credential)["']?\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|(?:(?:Bearer|Basic)\s+)?\S+)`)
	reKeyHead    = regexp.MustCompile(`(?i)^["']?(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|authorization|credential)["']?\s*[=:]\s*`)
	reToken      = regexp.MustCompile(`\b(?:(?:sk|rk|xai|pplx|r8)-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})|\bAKIA[A-Z0-9]{16}\b`)
	rePrivateKey = regexp.MustCompile(`(?is)-----BEGIN [^-]*PRIVATE KEY-----.*?(?:-----END [^-]*PRIVATE KEY-----|$)`)
	reBearer     = regexp.MustCompile(`(?i)\b(Bearer\s+)[A-Za-z0-9._~+/=-]+`)
	reBasic      = regexp.MustCompile(`\b([Bb]asic\s+)([A-Za-z0-9+/]{8,}={0,2})`)
	reUserinfo   = regexp.MustCompile(`(?i)\b([a-z][a-z0-9+.-]*://)[^\s/@]+:[^\s/@]+@`)
)

// Redact strips credential-shaped text: key=value pairs keep the key, auth
// headers keep the scheme, URLs keep the host, private keys and bare tokens
// disappear. It is best effort and idempotent.
func Redact(s string) string {
	s = rePrivateKey.ReplaceAllString(s, redacted)
	s = reUserinfo.ReplaceAllString(s, "${1}"+redacted+"@")
	s = reKeyValue.ReplaceAllStringFunc(s, func(match string) string {
		head := reKeyHead.FindString(match)
		rest := match[len(head):]
		if len(rest) >= 2 && (rest[0] == '"' || rest[0] == '\'') && rest[len(rest)-1] == rest[0] {
			return head + string(rest[0]) + redacted + string(rest[0])
		}
		return head + redacted
	})
	s = reBearer.ReplaceAllString(s, "${1}"+redacted)
	s = reBasic.ReplaceAllStringFunc(s, func(match string) string {
		parts := reBasic.FindStringSubmatch(match)
		// Base64 credentials carry digits or symbols; plain prose such as "Basic usage" does not.
		if !strings.ContainsAny(parts[2], "0123456789+/") {
			return match
		}
		return parts[1] + redacted
	})
	return reToken.ReplaceAllString(s, redacted)
}

// clip shortens s to at most max bytes on a rune boundary.
func clip(s string, max int) string {
	if len(s) <= max {
		return s
	}
	cut := max
	for cut > 0 && (s[cut]&0xC0) == 0x80 {
		cut--
	}
	return s[:cut] + "…"
}

// lastBytes keeps the final max bytes of s on a rune boundary.
func lastBytes(s string, max int) string {
	if len(s) <= max {
		return s
	}
	cut := len(s) - max
	for cut < len(s) && (s[cut]&0xC0) == 0x80 {
		cut++
	}
	return s[cut:]
}
