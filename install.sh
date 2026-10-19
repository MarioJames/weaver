#!/usr/bin/env bash
# Install, update or remove the Weaver standalone executable from a GitHub Release.
#   curl -fsSL https://raw.githubusercontent.com/MarioJames/weaver/main/install.sh | bash
# It downloads one file for this platform, checks it against the release SHA256SUMS,
# and places it at ~/.local/bin/weaver. No Node, npm or sudo. State is never touched.
set -euo pipefail

repository="MarioJames/weaver"
version=latest
bin_dir="$HOME/.local/bin"
dist_dir=""
action=install
force=0

die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'USAGE'
install.sh [--version TAG] [--bin-dir DIR] [--dist-dir DIR] [--uninstall]
  --version TAG   install a specific release, e.g. v0.1.0 (default: latest)
  --bin-dir DIR   where to place the weaver executable (default: ~/.local/bin)
  --dist-dir DIR  install from already built artifacts (weaver-<os>-<arch> + SHA256SUMS)
  --force         replace an existing --bin-dir/weaver that is not a Weaver executable
  --uninstall     remove the executable only; ~/.local/share/weaver is kept
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || die "--version requires a value"; version="$2"; shift 2 ;;
    --version=*) version="${1#*=}"; shift ;;
    --bin-dir) [ $# -ge 2 ] || die "--bin-dir requires a value"; bin_dir="$2"; shift 2 ;;
    --bin-dir=*) bin_dir="${1#*=}"; shift ;;
    --dist-dir) [ $# -ge 2 ] || die "--dist-dir requires a value"; dist_dir="$2"; shift 2 ;;
    --dist-dir=*) dist_dir="${1#*=}"; shift ;;
    --force) force=1; shift ;;
    --uninstall) action=uninstall; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
done
case "$bin_dir" in /*) ;; *) die "--bin-dir must be an absolute path" ;; esac
target="$bin_dir/weaver"

if [ "$action" = uninstall ]; then
  if [ -e "$target" ] || [ -L "$target" ]; then
    "$target" --version 2>/dev/null | grep -q '^weaver ' || die "$target is not a Weaver executable; leaving it alone"
    rm -f -- "$target"
    printf 'removed %s (state in ~/.local/share/weaver is kept)\n' "$target"
  else
    printf 'nothing to remove at %s\n' "$target"
  fi
  exit 0
fi

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) die "unsupported OS $(uname -s); published builds: linux-x64, linux-arm64, darwin-arm64" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) die "unsupported CPU $(uname -m)" ;;
esac
asset="weaver-$os-$arch"
[ "$asset" != weaver-darwin-x64 ] || die "no build for Intel macOS; published builds: linux-x64, linux-arm64, darwin-arm64"

if command -v sha256sum >/dev/null; then sha() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null; then sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
else die "sha256sum or shasum is required to verify the download"; fi

# Never replace someone else's "weaver" by accident (an older npm link also lacks --version).
if [ "$force" = 0 ] && { [ -e "$target" ] || [ -L "$target" ]; }; then
  "$target" --version 2>/dev/null | grep -q '^weaver ' || die "$target exists and is not a Weaver release executable; move it away or pass --force"
fi

mkdir -p "$bin_dir"
work="$(mktemp -d "$bin_dir/.weaver-install.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT

if [ -n "$dist_dir" ]; then
  cp -- "$dist_dir/$asset" "$work/$asset" || die "$dist_dir/$asset not found"
  cp -- "$dist_dir/SHA256SUMS" "$work/SHA256SUMS" || die "$dist_dir/SHA256SUMS not found"
else
  command -v curl >/dev/null || die "curl is required"
  if [ "$version" = latest ]; then base="https://github.com/$repository/releases/latest/download"
  else base="https://github.com/$repository/releases/download/v${version#v}"; fi
  printf 'downloading %s/%s\n' "$base" "$asset"
  curl -fsSL --retry 3 -o "$work/$asset" "$base/$asset" || die "download failed: $base/$asset"
  curl -fsSL --retry 3 -o "$work/SHA256SUMS" "$base/SHA256SUMS" || die "download failed: $base/SHA256SUMS"
fi

expected="$(awk -v name="$asset" '$2 == name { print $1 }' "$work/SHA256SUMS")"
[ -n "$expected" ] || die "SHA256SUMS has no entry for $asset"
actual="$(sha "$work/$asset")"
[ "$expected" = "$actual" ] || die "checksum mismatch for $asset (expected $expected, got $actual)"
chmod 755 "$work/$asset"
installed="$("$work/$asset" --version)" || die "the downloaded executable does not run on this machine"
# Same directory, so the rename is atomic and a running weaver keeps its old file.
mv -f -- "$work/$asset" "$target"
printf 'installed %s at %s\n' "$installed" "$target"
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) printf 'note: %s is not on PATH; add it, e.g. export PATH="%s:$PATH"\n' "$bin_dir" "$bin_dir" ;;
esac
