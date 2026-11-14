// Package daemon is the Weaver service: it owns the database, the kernel and
// the launch layer, and serves the CLI over a Unix socket.
package daemon

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/MarioJames/weaver/internal/engine"
	"github.com/MarioJames/weaver/internal/kernel"
	"github.com/MarioJames/weaver/internal/rpc"
	"github.com/MarioJames/weaver/internal/store"
)

// Version is set at build time.
var Version = "2.0.0-dev"

// Server is one running service instance.
type Server struct {
	home    string
	log     *slog.Logger
	kernel  *kernel.Kernel
	engines *engine.Manager
	started time.Time
}

// Run starts the service and blocks until it is asked to stop.
func Run(home string) error {
	if err := os.MkdirAll(home, 0o700); err != nil {
		return err
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	lock, err := os.OpenFile(filepath.Join(home, "daemon.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return fmt.Errorf("另一个 weaver 服务已经在使用 %s", home)
	}
	db, err := store.Open(filepath.Join(home, "weaver.db"))
	if err != nil {
		return err
	}
	defer db.Close()
	k := kernel.New(kernel.Options{DB: db, Home: home, Push: herdrPush, Check: engine.CheckAccount, Log: log})
	mgr := engine.NewManager(k, log, home, k, k.Setting)
	k.SetEngines(mgr)
	s := &Server{home: home, log: log, kernel: k, engines: mgr, started: time.Now()}

	// Order matters: adopt resident servers before attempts are reattached to
	// them, and sweep orphans only once every live attempt is tracked again.
	mgr.Resident.Resume(k.EngineAccount)
	if err := k.Start(); err != nil {
		return err
	}
	mgr.Sweep()
	go s.keepResidents()

	socket := rpc.SocketPath(home)
	os.Remove(socket)
	listener, err := net.Listen("unix", socket)
	if err != nil {
		return err
	}
	defer os.Remove(socket)
	if err := os.Chmod(socket, 0o600); err != nil {
		return err
	}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-stop
		k.Close()
		listener.Close()
	}()
	log.Info("weaver ready", "home", home, "version", Version)
	for {
		conn, err := listener.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			log.Error("accept failed", "err", err)
			continue
		}
		go s.serve(conn)
	}
}

// keepResidents keeps a resident server running for every account that should have one.
func (s *Server) keepResidents() {
	for {
		if s.kernel.Setting("resident") != "off" {
			if accounts, err := s.kernel.ResidentAccounts(); err == nil {
				for _, a := range accounts {
					s.engines.Resident.Ensure(a)
				}
			}
			// A server that just (re)started has loaded nothing yet.
			if dirs, err := s.kernel.OpenWorkspaces(); err == nil {
				for _, dir := range dirs {
					s.engines.Resident.Warm(dir)
				}
			}
		}
		time.Sleep(5 * time.Second)
	}
}

func herdrPush(session, pane, text string) error {
	args := []string{}
	if session != "" {
		args = append(args, "--session", session)
	}
	args = append(args, "agent", "prompt", pane, text)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "herdr", args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("herdr agent prompt: %v %s", err, firstLine(string(out)))
	}
	return nil
}

func firstLine(s string) string {
	for i, r := range s {
		if r == '\n' || i > 300 {
			return s[:i]
		}
	}
	return s
}

func (s *Server) serve(conn net.Conn) {
	defer conn.Close()
	reader := bufio.NewReaderSize(conn, 64<<10)
	line, err := reader.ReadBytes('\n')
	if err != nil {
		return
	}
	var req rpc.Request
	if err := json.Unmarshal(line, &req); err != nil {
		reply(conn, nil, &kernel.Error{Code: "INVALID", Message: "请求不是合法的 JSON"})
		return
	}
	// The client sends nothing after its request, so a read only returns when it hangs up.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		var b [1]byte
		conn.Read(b[:])
		cancel()
	}()
	handler := methods[req.Method]
	if handler == nil {
		reply(conn, nil, &kernel.Error{Code: "UNKNOWN_METHOD", Message: "未知命令 " + req.Method})
		return
	}
	result, err := handler(s, ctx, req.Params, func(v any) error { return reply(conn, v, nil) })
	if err != nil {
		if ctx.Err() != nil {
			return
		}
		reply(conn, nil, err)
		return
	}
	if result != nil {
		reply(conn, result, nil)
	}
}

func reply(conn net.Conn, result any, err error) error {
	resp := rpc.Response{OK: err == nil}
	if err != nil {
		e := kernel.AsError(err)
		resp.Error = &rpc.Error{Code: e.Code, Message: e.Message}
	} else {
		body, marshalErr := json.Marshal(result)
		if marshalErr != nil {
			return marshalErr
		}
		resp.Result = body
	}
	line, _ := json.Marshal(resp)
	_, writeErr := conn.Write(append(line, '\n'))
	return writeErr
}

func pid() int { return os.Getpid() }
