package quota

import (
	"math"
	"math/big"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var (
	namePattern      = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9 ._:/-]{0,79}$`)
	timestampPattern = regexp.MustCompile(
		`^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$`)
)

func object(value any) (map[string]any, bool) {
	obj, ok := value.(map[string]any)
	if !ok || obj == nil {
		return nil, false
	}
	return obj, true
}

func number(value any) (float64, bool) {
	f, ok := value.(float64)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) || f < 0 {
		return 0, false
	}
	return f, true
}

func name(value any) string {
	text, ok := value.(string)
	if !ok || !namePattern.MatchString(text) {
		return ""
	}
	return text
}

func firstName(values ...any) string {
	for _, value := range values {
		if text := name(value); text != "" {
			return text
		}
	}
	return ""
}

func durationLabel(minutes int, fallback string) string {
	switch {
	case minutes <= 0:
		return fallback
	case minutes%1440 == 0:
		return strconv.Itoa(minutes/1440) + " 天额度"
	case minutes%60 == 0:
		return strconv.Itoa(minutes/60) + " 小时额度"
	default:
		return strconv.Itoa(minutes) + " 分钟额度"
	}
}

// epochMillis accepts Codex's Unix-second reset values.
func epochMillis(value any) int64 {
	f, ok := value.(float64)
	if !ok || f <= 0 || f != math.Trunc(f) || f > 8_640_000_000_000 {
		return 0
	}
	if f > 9_007_199_254_740_991 {
		return 0
	}
	return int64(f) * 1000
}

// parseProviderTimestamp accepts timezone-qualified timestamps and rejects
// calendar rollover instead of silently normalizing it.
func parseProviderTimestamp(value any) int64 {
	text, ok := value.(string)
	if !ok {
		return 0
	}
	match := timestampPattern.FindStringSubmatch(text)
	if match == nil {
		return 0
	}
	year, _ := strconv.Atoi(match[1])
	month, _ := strconv.Atoi(match[2])
	day, _ := strconv.Atoi(match[3])
	hour, _ := strconv.Atoi(match[4])
	minute, _ := strconv.Atoi(match[5])
	second, _ := strconv.Atoi(match[6])
	if year < 1970 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59 {
		return 0
	}
	if zone := match[7]; zone != "Z" {
		zoneHour, _ := strconv.Atoi(zone[1:3])
		zoneMinute, _ := strconv.Atoi(zone[4:6])
		if zoneHour > 23 || zoneMinute > 59 {
			return 0
		}
	}
	parsed, err := time.Parse(time.RFC3339Nano, text)
	if err != nil {
		return 0
	}
	return parsed.UnixMilli()
}

func daysInMonth(year, month int) int {
	return time.Date(year, time.Month(month)+1, 0, 0, 0, 0, 0, time.UTC).Day()
}

func isTrue(value any) bool {
	flag, ok := value.(bool)
	return ok && flag
}

func unknownSnapshot(detail string) *Snapshot {
	return &Snapshot{Status: statusUnknown, Windows: []Window{}, Detail: detail}
}

func unknownSnapshotWithWindows(windows []Window, detail string) *Snapshot {
	if windows == nil {
		windows = []Window{}
	}
	return &Snapshot{Status: statusUnknown, Windows: windows, Detail: detail}
}

func availableSnapshot(windows []Window, detail string) *Snapshot {
	if windows == nil {
		windows = []Window{}
	}
	return &Snapshot{Status: statusAvailable, Windows: windows, Detail: detail}
}

func exhaustedSnapshot(windows []Window, detail string) *Snapshot {
	if windows == nil {
		windows = []Window{}
	}
	return &Snapshot{Status: statusExhausted, Windows: windows, Detail: detail}
}

// evaluate derives the account status from parseable account windows.
// accountAttempts counts every account-level meter the provider described,
// including meters dropped for an unparseable percentage.
func evaluate(windows []Window, accountAttempts, droppedAccount int, now time.Time, permission *bool, blocked, globalBlocked bool) *Snapshot {
	var accounts []Window
	for _, window := range windows {
		if window.Scope == scopeAccount {
			accounts = append(accounts, window)
		}
	}
	nowMS := now.UnixMilli()
	current := 0
	exhausted := false
	for _, window := range accounts {
		if window.ResetsAt != 0 && window.ResetsAt <= nowMS {
			continue
		}
		current++
		if window.UsedPercent >= 100 {
			exhausted = true
		}
	}
	incomplete := droppedAccount > 0 || current != len(accounts)
	if globalBlocked || exhausted {
		detail := "账户额度窗口已耗尽"
		if globalBlocked {
			detail = "服务端明确报告账户整体消费限制已达到"
		}
		return exhaustedSnapshot(windows, detail)
	}
	permitted := permission == nil || *permission
	if accountAttempts > 0 && !incomplete && permitted && !blocked {
		return availableSnapshot(windows, "已读取账户额度；这不保证模型可以运行")
	}
	return unknownSnapshotWithWindows(windows, universalQuotaDetail)
}

func normalizeCodex(payload any, now time.Time) *Snapshot {
	body, ok := object(payload)
	if !ok {
		return unknownSnapshot("额度响应缺少有效数据")
	}
	if tooManyWindows(body["additional_rate_limits"]) {
		return unknownSnapshot("额度响应包含过多窗口，无法确认账户额度")
	}
	windows := []Window{}
	accountAttempts, droppedAccount := 0, 0
	convert := func(limit map[string]any, prefix, scope, model string) {
		for _, key := range []string{"primary_window", "secondary_window"} {
			raw, ok := object(limit[key])
			if !ok {
				continue
			}
			if scope == scopeAccount {
				accountAttempts++
			}
			percent, ok := number(raw["used_percent"])
			if !ok {
				if scope == scopeAccount {
					droppedAccount++
				}
				continue
			}
			minutes := 0
			if seconds, ok := number(raw["limit_window_seconds"]); ok && seconds > 0 && seconds <= 1_000_000_000 {
				minutes = int(seconds / 60)
			}
			fallback := "主要额度窗口"
			if key == "secondary_window" {
				fallback = "次要额度窗口"
			}
			windows = append(windows, Window{
				ID:              prefix + ":" + key,
				Label:           durationLabel(minutes, fallback),
				Scope:           scope,
				Model:           model,
				UsedPercent:     percent,
				ResetsAt:        epochMillis(raw["reset_at"]),
				DurationMinutes: minutes,
			})
		}
	}
	limit, hasLimit := object(body["rate_limit"])
	if hasLimit {
		convert(limit, "codex:account", scopeAccount, "")
	}
	if additional, ok := body["additional_rate_limits"].([]any); ok {
		if len(additional) > 100 {
			additional = additional[:100]
		}
		for index, item := range additional {
			extra, ok := object(item)
			if !ok {
				continue
			}
			model := firstName(extra["normal_model_slug"], extra["metered_feature"], extra["limit_name"])
			prefix := "codex:model:" + strconv.Itoa(index)
			if model != "" {
				prefix = "codex:model:" + model
			}
			if rateLimit, ok := object(extra["rate_limit"]); ok {
				convert(rateLimit, prefix, scopeModel, model)
			}
		}
	}
	var permission *bool
	if hasLimit {
		if allowed, ok := limit["allowed"].(bool); ok {
			permission = &allowed
		}
	}
	blocked := false
	if hasLimit {
		blocked = isTrue(limit["limit_reached"])
	}
	globalBlocked := false
	if spend, ok := object(body["spend_control"]); ok {
		globalBlocked = isTrue(spend["reached"])
	}
	credits := parseCodexCredits(body["credits"])
	snap := evaluate(windows, accountAttempts, droppedAccount, now, permission, blocked, globalBlocked)
	snap.Credits = credits
	snap.ResetCredits = parseCodexResetCreditsSummary(body["rate_limit_reset_credits"])
	if !globalBlocked && credits.Usable() && snap.Status != statusAvailable {
		snap.Status = statusAvailable
		snap.Detail = "套餐额度已用完，当前可使用 Credits 余额"
	}
	return snap
}

func parseCodexCredits(value any) *Credits {
	raw, ok := object(value)
	if !ok {
		return nil
	}
	_, hasCreditsKey := raw["has_credits"]
	_, hasUnlimitedKey := raw["unlimited"]
	_, hasOverageKey := raw["overage_limit_reached"]
	balance, hasBalance := parseBalanceNumber(raw["balance"])
	if !hasCreditsKey && !hasUnlimitedKey && !hasOverageKey && !hasBalance {
		return nil
	}
	return &Credits{
		HasCredits:          isTrue(raw["has_credits"]),
		Unlimited:           isTrue(raw["unlimited"]),
		OverageLimitReached: isTrue(raw["overage_limit_reached"]),
		Balance:             balance,
		HasBalance:          hasBalance,
	}
}

func parseBalanceNumber(value any) (float64, bool) {
	switch v := value.(type) {
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) || v < 0 {
			return 0, false
		}
		return v, true
	case string:
		text := strings.TrimSpace(v)
		if text == "" || len(text) > 64 {
			return 0, false
		}
		f, err := strconv.ParseFloat(text, 64)
		if err != nil || math.IsNaN(f) || math.IsInf(f, 0) || f < 0 {
			return 0, false
		}
		return f, true
	default:
		return 0, false
	}
}

func parseNonNegativeInt(value any) (int, bool) {
	f, ok := number(value)
	if !ok || f != math.Trunc(f) || f > 1_000_000 {
		return 0, false
	}
	return int(f), true
}

func parseCodexResetCreditsSummary(value any) *ResetCredits {
	raw, ok := object(value)
	if !ok {
		return nil
	}
	if count, ok := parseNonNegativeInt(raw["available_count"]); ok {
		return &ResetCredits{AvailableCount: count}
	}
	if count, ok := parseNonNegativeInt(raw["applicable_available_count"]); ok {
		return &ResetCredits{AvailableCount: count}
	}
	return nil
}

func mergeCodexResetCredits(snap *Snapshot, payload any, now time.Time) {
	if snap == nil {
		return
	}
	body, ok := object(payload)
	if !ok {
		return
	}
	nowMS := now.UnixMilli()
	var earliest int64
	counted := 0
	hasList := false
	if items, ok := body["credits"].([]any); ok {
		hasList = true
		if len(items) > 100 {
			items = items[:100]
		}
		for _, item := range items {
			card, ok := object(item)
			if !ok {
				continue
			}
			status, _ := card["status"].(string)
			if status != "available" {
				continue
			}
			expiresAt := parseProviderTimestamp(card["expires_at"])
			if expiresAt != 0 && expiresAt <= nowMS {
				continue
			}
			counted++
			if expiresAt != 0 && (earliest == 0 || expiresAt < earliest) {
				earliest = expiresAt
			}
		}
	}
	count, hasCount := parseNonNegativeInt(body["available_count"])
	if !hasCount {
		if !hasList {
			return
		}
		count = counted
	}
	snap.ResetCredits = &ResetCredits{
		AvailableCount: count,
		NextExpiresAt:  earliest,
	}
}

func normalizeClaude(payload any, now time.Time) *Snapshot {
	body, ok := object(payload)
	if !ok {
		return unknownSnapshot("额度响应缺少有效数据")
	}
	if tooManyWindows(body["limits"]) {
		return unknownSnapshot("额度响应包含过多窗口，无法确认账户额度")
	}
	windows := []Window{}
	accountAttempts, droppedAccount := 0, 0
	rawLimits, limitsIsArray := body["limits"].([]any)
	authoritative := limitsIsArray && len(rawLimits) > 0
	if authoritative {
		if len(rawLimits) > 100 {
			rawLimits = rawLimits[:100]
		}
		for index, item := range rawLimits {
			limit, ok := object(item)
			if !ok {
				continue
			}
			kind := ""
			if value, ok := limit["kind"].(string); ok {
				kind = value
			} else if value, ok := limit["group"].(string); ok {
				kind = value
			}
			rawScope, scopeIsObject := object(limit["scope"])
			model := ""
			if scopeIsObject {
				if modelObject, ok := object(rawScope["model"]); ok {
					model = firstName(modelObject["id"], modelObject["display_name"])
				}
			}
			modelScoped := false
			surfaceScoped := false
			if scopeIsObject {
				if value, present := rawScope["model"]; present && value != nil {
					modelScoped = true
				}
				if value, present := rawScope["surface"]; present && value != nil {
					surfaceScoped = true
				}
			}
			malformedScope := false
			if value, present := limit["scope"]; present && value != nil && !scopeIsObject {
				malformedScope = true
			}
			scope := scopeUnknown
			switch {
			case modelScoped || kind == "weekly_scoped":
				scope = scopeModel
			case surfaceScoped || malformedScope:
				scope = scopeUnknown
			case kind == "session" || kind == "weekly_all":
				scope = scopeAccount
			}
			kindID := "unknown"
			switch kind {
			case "session", "weekly_all", "weekly_scoped":
				kindID = kind
			}
			scopedModel := ""
			if scope == scopeModel {
				scopedModel = model
			}
			if scope == scopeAccount {
				accountAttempts++
			}
			percent, ok := number(limit["percent"])
			if !ok {
				if scope == scopeAccount {
					droppedAccount++
				}
				continue
			}
			duration := 0
			switch kind {
			case "session":
				duration = 300
			case "weekly_all", "weekly_scoped":
				duration = 10080
			}
			identifier := kindID + ":" + strconv.Itoa(index)
			if scopedModel != "" {
				identifier = kindID + ":" + scopedModel
			}
			windows = append(windows, Window{
				ID:              "claude:" + identifier,
				Label:           durationLabel(duration, "额度窗口"),
				Scope:           scope,
				Model:           scopedModel,
				UsedPercent:     percent,
				ResetsAt:        parseProviderTimestamp(limit["resets_at"]),
				DurationMinutes: duration,
			})
		}
	} else {
		for _, definition := range []struct {
			key      string
			duration int
		}{{"five_hour", 300}, {"seven_day", 10080}} {
			raw, ok := object(body[definition.key])
			if !ok {
				continue
			}
			accountAttempts++
			percent, ok := number(raw["utilization"])
			if !ok {
				droppedAccount++
				continue
			}
			windows = append(windows, Window{
				ID:              "claude:" + definition.key,
				Label:           durationLabel(definition.duration, "额度窗口"),
				Scope:           scopeAccount,
				UsedPercent:     percent,
				ResetsAt:        parseProviderTimestamp(raw["resets_at"]),
				DurationMinutes: definition.duration,
			})
		}
		for _, model := range []string{"sonnet", "opus"} {
			key := "seven_day_" + model
			raw, ok := object(body[key])
			if !ok {
				continue
			}
			percent, ok := number(raw["utilization"])
			if !ok {
				continue
			}
			windows = append(windows, Window{
				ID:              "claude:" + key,
				Label:           "7 天额度",
				Scope:           scopeModel,
				Model:           model,
				UsedPercent:     percent,
				ResetsAt:        parseProviderTimestamp(raw["resets_at"]),
				DurationMinutes: 10080,
			})
		}
	}
	if usage, ok := object(body["extra_usage"]); ok && isTrue(usage["is_enabled"]) {
		if total, ok := number(usage["monthly_limit"]); ok && total > 0 {
			accountAttempts++
			percent, hasPercent := number(usage["utilization"])
			if !hasPercent {
				if used, usedOK := number(usage["used_credits"]); usedOK {
					percent, hasPercent = used/total*100, true
				}
			}
			if !hasPercent {
				droppedAccount++
			} else {
				windows = append(windows, Window{
					ID:          "claude:extra_usage:monthly",
					Label:       "月度额度",
					Scope:       scopeAccount,
					UsedPercent: percent,
				})
			}
		}
	}
	return evaluate(windows, accountAttempts, droppedAccount, now, nil, false, false)
}

func tooManyWindows(value any) bool {
	array, ok := value.([]any)
	return ok && len(array) > 100
}

func normalizeOpenCodeGo(payload any, now time.Time) *Snapshot {
	body, ok := object(payload)
	if !ok {
		return unknownSnapshot("额度响应缺少有效数据")
	}
	usage, _ := object(body["usage"])
	windows := []Window{}
	incomplete := false
	rateLimited := false
	nowMS := now.UnixMilli()
	definitions := []struct {
		key      string
		label    string
		duration int
	}{
		{"rolling", "5 小时额度", 300},
		{"weekly", "7 天额度", 10080},
		{"monthly", "每月额度", 43200},
	}
	for _, definition := range definitions {
		slot, ok := object(usage[definition.key])
		if !ok {
			incomplete = true
			continue
		}
		status, _ := slot["status"].(string)
		if status != "ok" && status != "rate-limited" {
			incomplete = true
			continue
		}
		percent, ok := number(slot["percent"])
		if !ok {
			incomplete = true
			continue
		}
		resetsAt := parseProviderTimestamp(slot["resetsAt"])
		if resetsAt == 0 {
			incomplete = true
			continue
		}
		if status == "rate-limited" && resetsAt > nowMS {
			rateLimited = true
		}
		windows = append(windows, Window{
			ID:              "opencode:" + definition.key,
			Label:           definition.label,
			Scope:           scopeAccount,
			UsedPercent:     percent,
			ResetsAt:        resetsAt,
			DurationMinutes: definition.duration,
		})
	}
	exhausted := rateLimited
	for _, window := range windows {
		if window.ResetsAt > nowMS && window.UsedPercent >= 100 {
			exhausted = true
		}
	}
	const exhaustedDetail = "OpenCode Go 套餐窗口已耗尽；这仅指 Go 套餐窗口，不代表余额、免费模型或其他路线不可用。实际限额按对应模型反馈处理"
	if exhausted {
		return exhaustedSnapshot(windows, exhaustedDetail)
	}
	if incomplete {
		return unknownSnapshot("Go 套餐窗口缺失，无法确认账户额度")
	}
	for _, window := range windows {
		if window.ResetsAt <= nowMS {
			return unknownSnapshotWithWindows(windows, "Go 套餐窗口已过期，需要刷新额度")
		}
	}
	return availableSnapshot(windows, "已读取 Go 套餐窗口；这不保证模型可以运行")
}

func normalizeConsole(payload any) *Snapshot {
	body, ok := object(payload)
	if !ok {
		return unknownSnapshot("额度响应缺少有效数据")
	}
	access, _ := object(body["access"])
	meters, ok := object(access["meters"])
	if !ok {
		return unknownSnapshot("Go 套餐窗口缺失，无法确认账户额度")
	}
	definitions := []struct {
		key      string
		id       string
		label    string
		duration int
	}{
		{"fiveHour", "opencode:rolling", "5 小时额度", 300},
		{"week", "opencode:weekly", "7 天额度", 10080},
		{"month", "opencode:monthly", "每月额度", 43200},
	}
	windows := []Window{}
	incomplete := false
	for _, definition := range definitions {
		slot, ok := object(meters[definition.key])
		if !ok {
			incomplete = true
			continue
		}
		used, usedOK := microCents(slot["usedMicroCents"])
		limit, limitOK := microCents(slot["limitMicroCents"])
		if !usedOK || !limitOK || limit == 0 {
			incomplete = true
			continue
		}
		resetsAt := parseProviderTimestamp(slot["resetsAt"])
		if resetsAt == 0 {
			rawReset := slot["resetsAt"]
			if definition.key != "fiveHour" || used != 0 || rawReset != nil {
				incomplete = true
				continue
			}
			windows = append(windows, Window{
				ID:              definition.id,
				Label:           definition.label,
				Scope:           scopeAccount,
				UsedPercent:     0,
				DurationMinutes: definition.duration,
			})
			continue
		}
		windows = append(windows, Window{
			ID:              definition.id,
			Label:           definition.label,
			Scope:           scopeAccount,
			UsedPercent:     meterPercent(used, limit),
			ResetsAt:        resetsAt,
			DurationMinutes: definition.duration,
		})
	}
	const exhaustedDetail = "OpenCode Go 套餐窗口已耗尽；这仅指 Go 套餐窗口，不代表余额、免费模型或其他路线不可用。实际限额按对应模型反馈处理"
	for _, window := range windows {
		if window.UsedPercent >= 100 {
			return exhaustedSnapshot(windows, exhaustedDetail)
		}
	}
	if incomplete {
		return unknownSnapshot("Go 套餐窗口缺失，无法确认账户额度")
	}
	return availableSnapshot(windows, "已读取 Go 套餐窗口；这不保证模型可以运行")
}

// normalizeAgy converts retrieveUserQuotaSummary groups ("Gemini Models",
// "Claude and GPT models") into model-scoped quota windows so Gemini and 3p
// pools never cross-block each other during scheduling.
func normalizeAgy(payload any, now time.Time) *Snapshot {
	body, ok := object(payload)
	if !ok {
		return unknownSnapshot("额度响应缺少有效数据")
	}
	rawGroups, ok := body["groups"].([]any)
	if !ok || len(rawGroups) == 0 {
		return unknownSnapshot(universalQuotaDetail)
	}
	windows := []Window{}
	nowMS := now.UnixMilli()
	anyAvailable := false
	anyCurrent := false
	for gi, item := range rawGroups {
		if gi >= 20 {
			break
		}
		group, ok := object(item)
		if !ok {
			continue
		}
		displayName, _ := group["displayName"].(string)
		modelPool := agyModelPool(displayName)
		rawBuckets, ok := group["buckets"].([]any)
		if !ok {
			continue
		}
		for bi, rawBucket := range rawBuckets {
			if bi >= 20 {
				break
			}
			bucket, ok := object(rawBucket)
			if !ok {
				continue
			}
			rem, ok := number(bucket["remainingFraction"])
			if !ok {
				continue
			}
			if rem > 1 {
				rem = 1
			}
			used := math.Round((1-rem)*1000) / 10
			if used < 0 {
				used = 0
			}
			if used > 100 {
				used = 100
			}
			winKey, _ := bucket["window"].(string)
			minutes, fallback := agyWindowSpec(winKey)
			bucketID := firstName(bucket["bucketId"])
			if bucketID == "" {
				bucketID = strconv.Itoa(gi) + ":" + strconv.Itoa(bi)
			}
			if modelPool == "" {
				modelPool = agyModelPool(bucketID)
			}
			scope := scopeModel
			if modelPool == "" {
				scope = scopeAccount
			}
			resetsAt := parseProviderTimestamp(bucket["resetTime"])
			windows = append(windows, Window{
				ID:              "agy:" + bucketID,
				Label:           durationLabel(minutes, fallback),
				Scope:           scope,
				Model:           modelPool,
				UsedPercent:     used,
				ResetsAt:        resetsAt,
				DurationMinutes: minutes,
			})
			if resetsAt == 0 || resetsAt > nowMS {
				anyCurrent = true
				if used < 100 {
					anyAvailable = true
				}
			}
		}
	}
	if len(windows) == 0 {
		return unknownSnapshot(universalQuotaDetail)
	}
	if anyCurrent && !anyAvailable {
		return exhaustedSnapshot(windows, "Antigravity 各模型池额度窗口均已耗尽")
	}
	if anyAvailable || !anyCurrent {
		return availableSnapshot(windows, "已读取 Antigravity 额度窗口；按模型池分别计入")
	}
	return unknownSnapshotWithWindows(windows, universalQuotaDetail)
}

func agyModelPool(label string) string {
	lower := strings.ToLower(strings.TrimSpace(label))
	switch {
	case strings.Contains(lower, "gemini"):
		return "gemini"
	case strings.Contains(lower, "claude") || strings.Contains(lower, "gpt") || strings.HasPrefix(lower, "3p"):
		return "claude/gpt"
	default:
		return ""
	}
}

func agyWindowSpec(window string) (minutes int, fallback string) {
	switch strings.ToLower(strings.TrimSpace(window)) {
	case "5h":
		return 300, "5 小时额度"
	case "weekly", "7d":
		return 10080, "7 天额度"
	case "daily", "24h":
		return 1440, "1 天额度"
	default:
		return 0, "额度窗口"
	}
}

func redactSnapshot(snapshot *Snapshot, engine string, secrets ...string) {
	if snapshot == nil {
		return
	}
	for index := range snapshot.Windows {
		window := &snapshot.Windows[index]
		hit := false
		for _, secret := range secrets {
			if secret == "" {
				continue
			}
			if strings.Contains(window.ID, secret) || strings.Contains(window.Label, secret) || strings.Contains(window.Model, secret) {
				hit = true
				break
			}
		}
		if hit {
			window.ID = engine + ":redacted:" + strconv.Itoa(index)
			window.Label = "额度窗口"
			if window.Scope == scopeModel {
				window.Scope = scopeUnknown
			}
			window.Model = ""
		}
	}
}

// meterPercentExact is the big.Int implementation used only when a direct
// multiplication could overflow uint64.
func meterPercentExact(used, limit uint64) float64 {
	scaled := new(big.Int).SetUint64(used)
	scaled.Mul(scaled, big.NewInt(10000))
	scaled.Div(scaled, new(big.Int).SetUint64(limit))
	return float64(scaled.Uint64()) / 100
}
