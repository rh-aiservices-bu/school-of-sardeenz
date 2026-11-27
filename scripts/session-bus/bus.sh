#!/usr/bin/env bash
# Session bus, dev-merge claim and join banner for parallel agent sessions on this checkout.
# Documented in docs/development/parallel-sessions.md.
#
# State lives in $BUS_DIR (default /workspace/logs/session-bus): a gitignored directory that
# MUST be the main checkout's logs/, never a worktree's — a worktree has its own untracked
# logs/, so a lock or a bus log there is invisible to the other sessions.
set -euo pipefail

dir="${BUS_DIR:-/workspace/logs/session-bus}"
log="${dir}/bus.log"
lock="${dir}/.bus.lock"
claim="${dir}/dev-merge-claim"
stale_after="${BUS_CLAIM_STALE_SECONDS:-7200}"
poll="${BUS_POLL_SECONDS:-20}"
mkdir -p "${dir}"
touch "${log}"

now() { date -u +%FT%TZ; }

usage() {
  cat >&2 <<'EOF'
usage:
  bus.sh post <me> <to|all> <text>   append one message (at most 500 characters)
  bus.sh read <me>                   print unread messages for <me> (and those to=all)
  bus.sh watch <me> [secs]           poll every $BUS_POLL_SECONDS (20), exit when a message arrives
  bus.sh join <me>                   claim + who is listening + the next two commands
  bus.sh claim <me> <reason>         take the dev-merge claim (owner-authorized merges only)
  bus.sh renew <me>                  holder only: restart the claim's age
  bus.sh release <me>                holder only: drop the claim
  bus.sh status                      claim + the last 10 messages
  bus.sh who                         sessions and when each last read the bus

<me> is a stable session name, [A-Za-z0-9._-] only (e.g. m21, m22, workspace-a3).
State directory: $BUS_DIR (default /workspace/logs/session-bus). Never point it at a worktree.
EOF
  exit 2
}

die() { echo "bus: $*" >&2; exit 2; }
valid_name() { case "${1:-}" in '' | *[!A-Za-z0-9._-]*) return 1 ;; *) return 0 ;; esac; }

# Seconds since a file last changed (GNU stat, BSD stat fallback).
age_of() {
  local m
  m="$(stat -c %Y "$1" 2>/dev/null || stat -f %m "$1")"
  echo $(( $(date +%s) - m ))
}

# One line describing the claim: holder, reason, age, and STALE past $stale_after.
claim_line() {
  if [ ! -f "${claim}" ]; then
    echo "none"
    return
  fi
  local age
  age="$(age_of "${claim}")"
  if [ "${age}" -gt "${stale_after}" ]; then
    echo "$(cat "${claim}") (age $((age / 60)) min, STALE: post to the holder and tell the owner; only the owner removes it)"
  else
    echo "$(cat "${claim}") (age $((age / 60)) min)"
  fi
}

# Prints the unread lines for $1 and moves its cursor, holding the lock so nothing is lost.
# A session with no cursor yet gets only its messages of the last 24 h, not the whole log.
read_unread() {
  local me="$1" cursor="${dir}/.cursor-$1" seen total since
  (
    flock 9
    total="$(wc -l < "${log}")"
    if [ -f "${cursor}" ]; then
      seen="$(cat "${cursor}")"
      tail -n "+$((seen + 1))" "${log}" | head -n "$((total - seen))" \
        | awk -v me="${me}" 'index($0, " to=" me " |") || (index($0, " to=all |") && !index($0, " from=" me " to="))'
    else
      since="$(date -u -d '24 hours ago' +%FT%TZ)"
      head -n "${total}" "${log}" | awk -v me="${me}" -v since="${since}" '
        $1 >= since && (index($0, " to=" me " |") || (index($0, " to=all |") && !index($0, " from=" me " to="))) { print; next }
        { skipped++ }
        END { if (skipped) printf "bus: first read for %s; %d older messages skipped (bus.sh status shows the last 10)\n", me, skipped }'
    fi
    printf '%s\n' "${total}" > "${cursor}"
  ) 9>"${lock}"
}

cmd="${1:-}"
[ -n "${cmd}" ] || usage
shift

case "${cmd}" in
  post)
    [ "$#" -eq 3 ] || usage
    valid_name "$1" || die "invalid session name: $1"
    text="$(printf '%s' "$3" | tr '\n\r' '  ')"
    n="$(printf '%s' "${text}" | LC_ALL=C.UTF-8 wc -m)"
    if [ "${n}" -gt 500 ]; then
      echo "bus post refused: ${n} chars > 500. Put the detail in a file under /workspace/logs/ and post its path." >&2
      exit 1
    fi
    ( flock 9; printf '%s from=%s to=%s | %s\n' "$(now)" "$1" "$2" "${text}" >> "${log}" ) 9>"${lock}"
    ;;
  read)
    [ "$#" -eq 1 ] || usage
    valid_name "$1" || die "invalid session name: $1"
    read_unread "$1"
    ;;
  watch)
    [ "$#" -ge 1 ] || usage
    valid_name "$1" || die "invalid session name: $1"
    me="$1"
    deadline=$((SECONDS + ${2:-21600}))
    while [ "${SECONDS}" -lt "${deadline}" ]; do
      out="$(read_unread "${me}")"
      if [ -n "${out}" ]; then
        printf '%s\n' "${out}"
        exit 0
      fi
      sleep "${poll}"
    done
    echo "bus watch: no message for ${me}; re-arm it"
    ;;
  join)
    [ "$#" -eq 1 ] || usage
    valid_name "$1" || die "invalid session name: $1"
    echo "session bus: ${dir} (you are ${1})"
    echo "claim: $(claim_line)"
    bash "$0" who || true
    echo "next: bash $0 read ${1}"
    echo "then: run 'bash $0 watch ${1}' in the background and restart it whenever it exits"
    echo "rules: docs/development/parallel-sessions.md"
    ;;
  claim)
    [ "$#" -eq 2 ] || usage
    valid_name "$1" || die "invalid session name: $1"
    if ( set -o noclobber; printf '%s %s | %s\n' "$1" "$(now)" "$2" > "${claim}" ) 2>/dev/null; then
      echo "claimed: $(cat "${claim}")"
    else
      echo "held by: $(claim_line)" >&2
      exit 1
    fi
    ;;
  renew)
    [ "$#" -eq 1 ] || usage
    valid_name "$1" || die "invalid session name: $1"
    if [ -f "${claim}" ] && [ "$(cut -d' ' -f1 "${claim}")" = "$1" ]; then
      touch "${claim}"
      echo "renewed: $(claim_line)"
    else
      echo "not yours; holder: $(claim_line)" >&2
      exit 1
    fi
    ;;
  release)
    [ "$#" -eq 1 ] || usage
    valid_name "$1" || die "invalid session name: $1"
    if [ -f "${claim}" ] && [ "$(cut -d' ' -f1 "${claim}")" = "$1" ]; then
      rm -f "${claim}"
      echo "released"
    else
      echo "not yours; holder: $(claim_line)" >&2
      exit 1
    fi
    ;;
  status)
    echo "dir: ${dir}"
    echo "claim: $(claim_line)"
    tail -n 10 "${log}"
    ;;
  who)
    # A running watcher reads every 20 s, so a recent read means the session is listening.
    # Cursors idle more than 7 days are deleted; sessions idle more than 24 h are counted, not listed.
    (
      flock 9
      find "${dir}" -maxdepth 1 -type f -name '.cursor-*' -mmin +10080 -delete
      found=0
      hidden=0
      for cursor in "${dir}"/.cursor-*; do
        [ -f "${cursor}" ] || continue
        found=1
        age="$(age_of "${cursor}")"
        if [ "${age}" -gt 86400 ]; then
          hidden=$((hidden + 1))
          continue
        fi
        name="${cursor##*/.cursor-}"
        last_post="$(grep -F " from=${name} to=" "${log}" | tail -n 1 | cut -d' ' -f1 || true)"
        if [ "${age}" -le 60 ]; then state="listening"; else state="not listening"; fi
        printf '%s: last read %s s ago (%s); last post %s\n' "${name}" "${age}" "${state}" "${last_post:-never}"
      done
      [ "${found}" -eq 1 ] || echo "no session has read the bus yet"
      [ "${hidden}" -eq 0 ] || echo "${hidden} sessions idle > 24 h not shown"
    ) 9>"${lock}"
    ;;
  *)
    usage
    ;;
esac
