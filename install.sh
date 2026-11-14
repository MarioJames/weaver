#!/usr/bin/env bash
# Install, update or remove the Weaver executable.
#   curl -fsSL https://raw.githubusercontent.com/MarioJames/weaver/main/install.sh | bash
# It takes one file for this platform, checks it against SHA256SUMS and renames it
# into place. When weaver.service is running it is restarted onto the new file:
# running agents and resident engines live in their own scopes and keep going.
# Over a Weaver 0.x it is the upgrade to 2: the 0.x state in ~/.local/share/weaver
# is left as it was, and 2 keeps its own in ~/.local/share/weaver/v2.
set -euo pipefail

repository="MarioJames/weaver"
version=""
bin_dir="$HOME/.local/bin"
dist_dir=""
action=install
force=0
restart=1
unit=weaver.service

die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'USAGE'
install.sh [--version TAG] [--bin-dir DIR] [--dist-dir DIR] [--no-restart] [--uninstall]
  --version TAG   install a specific release, e.g. v2.0.0 (default: latest)
  --bin-dir DIR   where to place the weaver executable (default: ~/.local/bin)
  --dist-dir DIR  install from already built artifacts (weaver-linux-<arch> + SHA256SUMS), e.g. dist/release after "make dist"
  --no-restart    leave a running weaver.service on the old executable until its next restart
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
    --no-restart) restart=0; shift ;;
    --force) force=1; shift ;;
    --uninstall) action=uninstall; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
done
case "$bin_dir" in /*) ;; *) die "--bin-dir must be an absolute path" ;; esac
target="$bin_dir/weaver"

# 0.x answers "weaver --version" with "weaver 0.7.19", 2.x with the bare number.
weaver_version() {
  local v
  v="$("$1" --version 2>/dev/null | head -n 1)" || v=""
  v="${v#weaver }"
  printf '%s\n' "$v" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+' && printf '%s\n' "$v"
}
# The service this script may touch is the one that runs this very executable.
# "daemon" tells a Weaver 2 service from a 0.x one ("weaver web ..."), which the new executable cannot run.
service_exec() { command -v systemctl >/dev/null && systemctl --user show -p ExecStart --value "$unit" 2>/dev/null; }
service_uses_target() { service_exec | grep -Fq "path=$(readlink -f "$target") "; }
service_is_v2() { service_exec | grep -Fq "argv[]=$(readlink -f "$target") daemon ;"; }

if [ "$action" = uninstall ]; then
  if [ -e "$target" ] || [ -L "$target" ]; then
    weaver_version "$target" >/dev/null || die "$target is not a Weaver executable; leaving it alone"
    if service_uses_target; then die "$unit still runs $target; run \"$target service uninstall\" first"; fi
    rm -f -- "$target"
    printf 'removed %s (state in ~/.local/share/weaver is kept)\n' "$target"
  else
    printf 'nothing to remove at %s\n' "$target"
  fi
  exit 0
fi

[ "$(uname -s)" = Linux ] || die "unsupported OS $(uname -s); Weaver runs agents under systemd and is built for linux-x64 and linux-arm64"
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) die "unsupported CPU $(uname -m)" ;;
esac
asset="weaver-linux-$arch"
command -v sha256sum >/dev/null || die "sha256sum is required to verify the executable"

# Never replace someone else's "weaver" by accident.
previous=""
if [ -e "$target" ] || [ -L "$target" ]; then
  previous="$(weaver_version "$target")" || previous=""
  [ -n "$previous" ] || [ "$force" = 1 ] || die "$target exists and is not a Weaver executable; move it away or pass --force"
fi

mkdir -p "$bin_dir"
work="$(mktemp -d "$bin_dir/.weaver-install.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT

if [ -n "$dist_dir" ]; then
  cp -- "$dist_dir/$asset" "$work/$asset" || die "$dist_dir/$asset not found"
  cp -- "$dist_dir/SHA256SUMS" "$work/SHA256SUMS" || die "$dist_dir/SHA256SUMS not found"
else
  command -v curl >/dev/null || die "curl is required"
  if [ -z "$version" ]; then
    base="https://github.com/$repository/releases/latest/download"
  else
    base="https://github.com/$repository/releases/download/v${version#v}"
  fi
  printf 'downloading %s/%s\n' "$base" "$asset"
  curl -fsSL --retry 3 -o "$work/$asset" "$base/$asset" || die "download failed: $base/$asset"
  curl -fsSL --retry 3 -o "$work/SHA256SUMS" "$base/SHA256SUMS" || die "download failed: $base/SHA256SUMS"
fi

expected="$(awk -v name="$asset" '$2 == name { print $1 }' "$work/SHA256SUMS")"
[ -n "$expected" ] || die "SHA256SUMS has no entry for $asset"
actual="$(sha256sum "$work/$asset" | cut -d' ' -f1)"
[ "$expected" = "$actual" ] || die "checksum mismatch for $asset (expected $expected, got $actual)"
chmod 755 "$work/$asset"
installed="$("$work/$asset" version)" || die "the executable does not run on this machine"
# Same directory, so the rename is atomic and a running service keeps its old file until restarted.
mv -f -- "$work/$asset" "$target"
printf 'installed weaver %s at %s\n' "$installed" "$target"

# Agents follow the installed skill, so an installed copy moves with the executable.
if [ -e "$HOME/.agents/skills/agents-weaver" ]; then
  "$target" skill install >/dev/null && printf 'updated the agents-weaver skill in ~/.agents/skills\n'
else
  printf 'note: install the skill for your agents with: weaver skill install\n'
fi

if service_uses_target && ! service_is_v2; then
  printf 'note: %s still belongs to Weaver %s and cannot run this executable; replace it with: weaver service install\n' "$unit" "${previous:-0.x}"
elif service_is_v2 && systemctl --user is-active --quiet "$unit"; then
  if [ "$restart" = 0 ]; then
    printf 'note: %s still runs the previous executable; restart it with: systemctl --user restart %s\n' "$unit" "$unit"
  else
    systemctl --user restart "$unit" || die "could not restart $unit; see: journalctl --user -u $unit"
    running=""
    for _ in $(seq 50); do
      pid="$(systemctl --user show -p MainPID --value "$unit")"
      if [ "${pid:-0}" != 0 ] && [ "$(readlink -f "/proc/$pid/exe" 2>/dev/null)" = "$(readlink -f "$target")" ]; then running="$pid"; break; fi
      sleep 0.2
    done
    [ -n "$running" ] || die "$unit did not come back on the new executable; see: journalctl --user -u $unit"
    printf 'restarted %s on weaver %s (pid %s); running agents were not interrupted\n' "$unit" "$installed" "$running"
  fi
fi
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) printf 'note: %s is not on PATH; add it, e.g. export PATH="%s:$PATH"\n' "$bin_dir" "$bin_dir" ;;
esac
