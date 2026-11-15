# Weaver (Go). The 0.x TypeScript sources under src/ are no longer built or released.
#   make test      vet and race-tested unit tests
#   make dist      CLI binaries, GUI archives and SHA256SUMS in dist/release
#   make install   build and install CLI + GUI; restart a running weaver.service
SHELL := bash
GO ?= go
OUT := dist/release
PKGS := ./cmd/weaver-gui/... ./cmd/weaver/... ./internal/... ./skills/...
# A v* tag on HEAD is the version; anything else is a dev build named after the commit.
VERSION ?= $(shell v=$$(git describe --tags --exact-match --match 'v[0-9]*' 2>/dev/null) && echo "$${v\#v}" || echo "2.0.0-dev.$$(git rev-parse --short HEAD)$$(git diff --quiet HEAD -- . ':!dist' || echo .dirty)")
LDFLAGS := -s -w -X github.com/MarioJames/weaver/internal/daemon.Version=$(VERSION)

# Keep these pins in sync with mygo v0.9.0 plugins/terminal/mygo-plugin.json.
GHOSTTY_BASE := https://github.com/egoist/mygo/releases/download/libghostty-vt-befcdfd2c3a1
GHOSTTY_amd64 := 9dcd8af0de67778a561f436cb673a9fb1738be8fa00849dad49606baed1e57d7
GHOSTTY_arm64 := fb163f8f123206956751f1c4f0303b40899513b7dc171a8ab8d85ba7cd541bc0

.PHONY: test dist install

test:
	$(GO) vet $(PKGS)
	$(GO) test -race $(PKGS)

# The engine layer needs systemd and inotify, so only Linux is built. SQLite is pure Go: no cgo, static binaries.
dist:
	rm -rf $(OUT) && mkdir -p $(OUT)
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 $(GO) build -trimpath -ldflags '$(LDFLAGS)' -o $(OUT)/weaver-linux-x64 ./cmd/weaver
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 $(GO) build -trimpath -ldflags '$(LDFLAGS)' -o $(OUT)/weaver-linux-arm64 ./cmd/weaver
	$(MAKE) gui-dist ARCH=amd64 LABEL=x64 GHOSTTY_SHA=$(GHOSTTY_amd64)
	$(MAKE) gui-dist ARCH=arm64 LABEL=arm64 GHOSTTY_SHA=$(GHOSTTY_arm64)
	cd $(OUT) && sha256sum weaver-linux-* weaver-gui-linux-*.tar.gz > SHA256SUMS
	@echo "built weaver $(VERSION) in $(OUT)"

# Cache native libraries outside release/ so subsequent builds do not download again.
.PHONY: gui-dist
gui-dist:
	@set -euo pipefail; \
	cache="dist/native/$(GHOSTTY_SHA)/libghostty-vt.so"; \
	mkdir -p "$$(dirname "$$cache")"; \
	if [ ! -f "$$cache" ] || ! echo "$(GHOSTTY_SHA)  $$cache" | sha256sum --check --status; then \
	  tmp=$$(mktemp "$$cache.XXXXXX"); trap 'rm -f "$$tmp"' EXIT; \
	  curl -fsSL --retry 3 '$(GHOSTTY_BASE)/libghostty-vt-linux-$(ARCH).so' -o "$$tmp"; \
	  echo "$(GHOSTTY_SHA)  $$tmp" | sha256sum --check --status; \
	  mv -f "$$tmp" "$$cache"; \
	fi; \
	stage=$$(mktemp -d dist/gui-$(ARCH).XXXXXX); trap 'rm -rf "$$stage"' EXIT; \
	CGO_ENABLED=0 GOOS=linux GOARCH=$(ARCH) $(GO) build -trimpath -ldflags '$(LDFLAGS)' -o "$$stage/weaver-gui" ./cmd/weaver-gui; \
	cp "$$cache" "$$stage/libghostty-vt.so"; \
	cp cmd/weaver-gui/assets/weaver-icon.png "$$stage/weaver-gui.png"; \
	tar -czf $(OUT)/weaver-gui-linux-$(LABEL).tar.gz -C "$$stage" weaver-gui libghostty-vt.so weaver-gui.png

install: dist
	./install.sh --dist-dir $(OUT) --gui
