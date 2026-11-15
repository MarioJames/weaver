package engine

import (
	"strings"
	"testing"
	"time"
)

// Recorded on 2026-11-15: codex 0.x printed this while retrying a dropped
// stream, then carried on; Weaver used to treat it as the turn's failure.
const codexReconnect = `{"type":"error","message":"Reconnecting... 2/5 (stream disconnected before completion: tls handshake eof)"}`

func TestCodexReconnectIsProgressNotFailure(t *testing.T) {
	n := newNormalizer("codex")
	n.push(`{"type":"thread.started","thread_id":"th_1"}`)
	sig := n.push(codexReconnect)
	if n.failure != "" {
		t.Fatalf("a reconnect notice became failure %q", n.failure)
	}
	if len(sig.notes) != 1 || !strings.Contains(sig.notes[0], "重连") || !strings.Contains(sig.notes[0], "2/5") {
		t.Fatalf("notes = %q, want one reconnect note", sig.notes)
	}
	n.push(`{"type":"item.completed","item":{"type":"agent_message","text":"all done"}}`)
	n.push(`{"type":"turn.completed","usage":{"input_tokens":7,"output_tokens":3}}`)
	if !n.succeeded() || n.result() != "all done" {
		t.Fatalf("succeeded=%v result=%q", n.succeeded(), n.result())
	}
}

func TestCodexTurnFailedKeepsTheLastErrorAsItsReason(t *testing.T) {
	n := newNormalizer("codex")
	n.push(codexReconnect)
	n.push(`{"type":"error","message":"stream disconnected before completion: tls handshake eof"}`)
	n.push(`{"type":"turn.failed","error":{}}`)
	if n.succeeded() || n.failure == "" {
		t.Fatal("turn.failed did not fail the run")
	}
	if n.failureDetail != "stream disconnected before completion: tls handshake eof" {
		t.Fatalf("detail = %q, want the last error", n.failureDetail)
	}
}

func TestCodexErrorWithoutTurnFailedSurfacesOnNonZeroExit(t *testing.T) {
	scripted(t, "codex", `echo '{"type":"thread.started","thread_id":"th_1"}'
echo '{"type":"error","message":"You'"'"'ve hit your usage limit. Try again in 2 hours."}'
exit 1
`)
	cold, sink := newCold(t)
	r := run(t, "codex", "p_rc2.1")
	cold.Launch(r)
	o := sink.waitFinished(t, r.AttemptID, 3*time.Second)
	if o.Success || o.FailureKind != FailQuota {
		t.Fatalf("outcome = %+v, want quota from the error event", o)
	}
}

func TestColdCodexRecoversAfterReconnect(t *testing.T) {
	scripted(t, "codex", `echo '{"type":"thread.started","thread_id":"th_1"}'
echo '`+codexReconnect+`'
sleep 1
`+codexTurn)
	cold, sink := newCold(t)
	r := run(t, "codex", "p_rc.1")
	cold.Launch(r)
	o := sink.waitFinished(t, r.AttemptID, 5*time.Second)
	if !o.Success || o.Text != "all done" {
		t.Fatalf("outcome = %+v, want the answer given after reconnecting", o)
	}
}

// Claude Code stream-json announces each API retry as system/api_retry
// (SDKAPIRetryMessage) and keeps going; the parent should see it as progress.
func TestClaudeAPIRetryIsProgressNotFailure(t *testing.T) {
	n := newNormalizer("claude")
	n.push(`{"type":"system","subtype":"init","session_id":"s"}`)
	sig := n.push(`{"type":"system","subtype":"api_retry","attempt":2,"max_retries":10,"retry_delay_ms":1200,"error_status":null,"error":"Connection error.","session_id":"s"}`)
	if n.failure != "" {
		t.Fatalf("an API retry became failure %q", n.failure)
	}
	if len(sig.notes) != 1 || !strings.Contains(sig.notes[0], "重连") || !strings.Contains(sig.notes[0], "2/10") || !strings.Contains(sig.notes[0], "Connection error") {
		t.Fatalf("notes = %q, want one reconnect note", sig.notes)
	}
	n.push(`{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"s"}`)
	if !n.succeeded() {
		t.Fatal("the run did not succeed after the retry")
	}
}
