# Weaver (Go). The 0.x TypeScript sources under src/ are no longer built or released.
#   make test      vet and race-tested unit tests
#   make dist      dist/release/weaver-linux-{x64,arm64} and SHA256SUMS
#   make install   build, then install ~/.local/bin/weaver and restart a running weaver.service
SHELL := bash
GO ?= go
OUT := dist/release
PKGS := ./cmd/weaver/... ./internal/... ./skills/...
# A v* tag on HEAD is the version; anything else is a dev build named after the commit.
VERSION ?= $(shell v=$$(git describe --tags --exact-match --match 'v[0-9]*' 2>/dev/null) && echo "$${v\#v}" || echo "2.0.0-dev.$$(git rev-parse --short HEAD)$$(git diff --quiet HEAD -- . ':!dist' || echo .dirty)")
LDFLAGS := -s -w -X github.com/MarioJames/weaver/internal/daemon.Version=$(VERSION)

.PHONY: test dist install

test:
	$(GO) vet $(PKGS)
	$(GO) test -race $(PKGS)

# The engine layer needs systemd and inotify, so only Linux is built. SQLite is pure Go: no cgo, static binaries.
dist:
	rm -rf $(OUT) && mkdir -p $(OUT)
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 $(GO) build -trimpath -ldflags '$(LDFLAGS)' -o $(OUT)/weaver-linux-x64 ./cmd/weaver
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 $(GO) build -trimpath -ldflags '$(LDFLAGS)' -o $(OUT)/weaver-linux-arm64 ./cmd/weaver
	cd $(OUT) && sha256sum weaver-linux-x64 weaver-linux-arm64 > SHA256SUMS
	@echo "built weaver $(VERSION) in $(OUT)"

install: dist
	./install.sh --dist-dir $(OUT)
