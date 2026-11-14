// Package rpc is the wire protocol between the weaver CLI and the service:
// one JSON request line and one or more JSON response lines over a Unix socket.
package rpc

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"time"
)

// Request is one command.
type Request struct {
	Method string          `json:"method"`
	Params json.RawMessage `json:"params,omitempty"`
}

// Response is one reply line. A streaming method sends several.
type Response struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *Error          `json:"error,omitempty"`
}

// Error is a failure reported by the service.
type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string { return e.Message }

// ErrUnavailable means the service could not be reached at all.
var ErrUnavailable = errors.New("service unavailable")

// Home returns the data directory: $WEAVER_HOME, or ~/.local/share/weaver2.
func Home() string {
	if dir := os.Getenv("WEAVER_HOME"); dir != "" {
		return dir
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local", "share", "weaver2")
}

// SocketPath returns the service socket inside a data directory.
func SocketPath(home string) string { return filepath.Join(home, "weaver.sock") }

// Conn is an open exchange with the service.
type Conn struct {
	conn   net.Conn
	reader *bufio.Reader
}

// Dial sends a request and returns the connection to read replies from.
func Dial(home, method string, params any) (*Conn, error) {
	conn, err := net.DialTimeout("unix", SocketPath(home), 2*time.Second)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	body, err := json.Marshal(params)
	if err != nil {
		conn.Close()
		return nil, err
	}
	line, _ := json.Marshal(Request{Method: method, Params: body})
	if _, err := conn.Write(append(line, '\n')); err != nil {
		conn.Close()
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	return &Conn{conn: conn, reader: bufio.NewReaderSize(conn, 64<<10)}, nil
}

// Next reads one reply. A dropped connection is reported as ErrUnavailable.
func (c *Conn) Next() (json.RawMessage, error) {
	line, err := c.reader.ReadBytes('\n')
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	var resp Response
	if err := json.Unmarshal(line, &resp); err != nil {
		return nil, err
	}
	if !resp.OK {
		if resp.Error == nil {
			resp.Error = &Error{Code: "INTERNAL", Message: "unknown error"}
		}
		return nil, resp.Error
	}
	return resp.Result, nil
}

func (c *Conn) Close() { c.conn.Close() }

// Call performs one request and returns its single reply.
func Call(home, method string, params any) (json.RawMessage, error) {
	c, err := Dial(home, method, params)
	if err != nil {
		return nil, err
	}
	defer c.Close()
	return c.Next()
}
