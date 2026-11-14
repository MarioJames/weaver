package engine

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var (
	reQuota = regexp.MustCompile(`(?i)FreeUsageLimitError|GoUsageLimitError|insufficient[_ ](?:balance|quota)|\b402\b|(?:usage|spending|credit|quota)[_ ]limit|(?:quota|(?:free|go)[_ ]usage).{0,30}(?:exceeded|exhausted)|(?:out of|insufficient|zero|no) (?:credits|balance)|balance.{0,20}(?:exhausted|insufficient)`)
	reRate  = regexp.MustCompile(`(?i)rate[_ -]?limit|too many requests|\b429\b`)
	reAuth  = regexp.MustCompile(`(?i)authentication[_ ](?:failed|error)|invalid[_ ]api[_ ]key|unauthorized|\b401\b`)

	engineQuota = map[string]*regexp.Regexp{
		"opencode": regexp.MustCompile(`(?i)FreeUsageLimitError|GoUsageLimitError|usage limit`),
		"codex":    regexp.MustCompile(`(?i)usage limit|you.?ve hit your limit|limit reached`),
		"claude":   regexp.MustCompile(`(?i)usage limit|you.?ve hit your limit|limit reached`),
		"dsh":      regexp.MustCompile(`\bQUOTA\b`),
	}

	reQuotedError = regexp.MustCompile(`\berror\.error=("(?:\\.|[^"\\])*")`)
	reErrorPrefix = regexp.MustCompile(`(?i)^(?:(?:AI_APICallError|AI_RetryError):\s*)+`)
	reSpaces      = regexp.MustCompile(`\s+`)
	reRetryHint   = regexp.MustCompile(`(?i)\b(retry[-_ ]?after(?:[-_ ](?:milliseconds|ms))?|retrying\s+in|reset[_ ]?at|resets?\s+at)["'\s:=]+([^"'\r\n}\]]+)`)
	reDuration    = regexp.MustCompile(`(?i)^(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|s|minutes?|m|hours?|h)?`)
	reISO         = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})`)
)

// vendorMessage turns raw vendor error text into one readable, redacted line.
func vendorMessage(message string) string {
	if m := reQuotedError.FindStringSubmatch(message); m != nil {
		var quoted string
		if json.Unmarshal([]byte(m[1]), &quoted) == nil {
			message = quoted
		}
	}
	message = reErrorPrefix.ReplaceAllString(Redact(message), "")
	return strings.TrimSpace(reSpaces.ReplaceAllString(message, " "))
}

// classify recognises a vendor limit or authentication failure in error
// text. It is only ever applied to text the engine reported as an error,
// never to model output. kind is "" when the text is an ordinary failure.
func classify(engine, message string, now time.Time) (kind string, retryAt time.Time) {
	switch {
	case reQuota.MatchString(message):
		kind = FailQuota
	case reRate.MatchString(message):
		kind = FailRateLimit
	case reAuth.MatchString(message):
		kind = FailAuth
	default:
		if re := engineQuota[engine]; re != nil && re.MatchString(message) {
			kind = FailQuota
		}
	}
	if kind == "" || kind == FailAuth {
		return kind, time.Time{}
	}
	return kind, retryHint(message, now)
}

// retryHint reads "retry after 30s", "retry-after-ms: 1500" or "reset_at: <RFC 3339>" style hints.
// Only a time in the future counts.
func retryHint(message string, now time.Time) time.Time {
	for _, m := range reRetryHint.FindAllStringSubmatch(message, -1) {
		label, value := strings.ToLower(m[1]), strings.TrimSpace(m[2])
		if iso := reISO.FindString(value); iso != "" {
			if at, err := time.Parse(time.RFC3339Nano, iso); err == nil && at.After(now) {
				return at
			}
			continue
		}
		if strings.HasPrefix(label, "reset") {
			continue
		}
		d := reDuration.FindStringSubmatch(value)
		if d == nil {
			continue
		}
		amount, err := strconv.ParseFloat(d[1], 64)
		if err != nil {
			continue
		}
		unit := strings.ToLower(d[2])
		// "retrying in 3 attempt 2" style counters carry no unit and are not durations.
		if unit == "" && strings.HasPrefix(label, "retrying") {
			continue
		}
		scale := time.Second
		switch {
		case unit == "" && (strings.HasSuffix(label, "ms") || strings.HasSuffix(label, "milliseconds")):
			scale = time.Millisecond
		case strings.HasPrefix(unit, "ms") || strings.HasPrefix(unit, "milli"):
			scale = time.Millisecond
		case strings.HasPrefix(unit, "m"):
			scale = time.Minute
		case strings.HasPrefix(unit, "h"):
			scale = time.Hour
		}
		if at := now.Add(time.Duration(amount * float64(scale))); at.After(now) {
			return at
		}
	}
	return time.Time{}
}
