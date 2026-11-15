package main

import (
	"os"
	"runtime"
	"testing"
)

func TestReadProcProcess(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("/proc ancestry is Linux-only")
	}
	parent, name, err := readProcProcess(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	if parent != os.Getppid() || name == "" {
		t.Fatalf("process = (parent %d, name %q), want parent %d and a name", parent, name, os.Getppid())
	}
	if _, _, err := readProcProcess(-1); err == nil {
		t.Fatal("nonexistent process was read successfully")
	}
}
