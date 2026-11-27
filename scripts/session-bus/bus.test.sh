#!/usr/bin/env bash
# Self-check for scripts/session-bus/bus.sh. Runs entirely inside a throwaway BUS_DIR:
#   bash scripts/session-bus/bus.test.sh
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
bus="${here}/bus.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT
export BUS_DIR="${tmp}/bus"
export BUS_POLL_SECONDS=1

pass=0
fail=0
ok() { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
no() { fail=$((fail + 1)); printf '  FAIL %s\n' "$1"; }
check() { # check <description> <expected> <actual>
  if [ "$2" = "$3" ]; then ok "$1"; else no "$1 (expected [$2], got [$3])"; fi
}
contains() { # contains <description> <needle> <haystack>
  case "$3" in *"$2"*) ok "$1" ;; *) no "$1 (missing [$2] in [$3])" ;; esac
}
msgs() { # msgs <session>: read, keeping value lines only (drop the first-read notice)
  bash "${bus}" read "$1" | grep -v '^bus: ' || true
}

echo "bus.test.sh: BUS_DIR=${BUS_DIR}"

# --- post / read / cursor ---------------------------------------------------
bash "${bus}" post alice bob "hello bob" >/dev/null
contains "read delivers an addressed message" "| hello bob" "$(bash "${bus}" read bob)"
check "second read shows nothing (cursor advanced)" "" "$(msgs bob)"
check "message to bob is not shown to carol" "" "$(msgs carol)"

bash "${bus}" post alice all "everyone" >/dev/null
contains "to=all reaches carol" "| everyone" "$(bash "${bus}" read carol)"
check "to=all is not echoed back to its sender" "" "$(msgs alice)"

bash "${bus}" post carol bob "second" >/dev/null
contains "delivered messages keep sender and time" "from=carol to=bob | second" "$(bash "${bus}" read bob)"

# common-prefix names must not cross-deliver
bash "${bus}" post carol m2 "for m2" >/dev/null
check "m21 does not receive m2's message" "" "$(bash "${bus}" read m21 | grep ' to=m2 ' || true)"

# length limit
long="$(printf 'x%.0s' $(seq 1 501))"
if bash "${bus}" post alice bob "${long}" >/dev/null 2>&1; then no "501 chars refused"; else ok "501 chars refused"; fi
long="$(printf 'x%.0s' $(seq 1 500))"
if bash "${bus}" post alice bob "${long}" >/dev/null 2>&1; then ok "500 chars accepted"; else no "500 chars accepted"; fi

# invalid names
if bash "${bus}" read 'bad name' >/dev/null 2>&1; then no "name with a space refused"; else ok "name with a space refused"; fi

# --- claim ------------------------------------------------------------------
bash "${bus}" claim m21 "PR 1" >/dev/null
if bash "${bus}" claim m22 "PR 2" >/dev/null 2>&1; then no "second claim refused"; else ok "second claim refused"; fi
contains "refusal names the holder" "held by: m21" "$(bash "${bus}" claim m22 "PR 2" 2>&1)"
if bash "${bus}" release m22 >/dev/null 2>&1; then no "non-holder cannot release"; else ok "non-holder cannot release"; fi
bash "${bus}" renew m21 >/dev/null && ok "holder renews" || no "holder renews"
contains "status shows the holder" "m21" "$(bash "${bus}" status)"
bash "${bus}" release m21 >/dev/null && ok "holder releases" || no "holder releases"
check "claim gone after release" "claim: none" "$(bash "${bus}" status | head -n 2 | tail -n 1)"

# --- who / join -------------------------------------------------------------
bash "${bus}" read bob >/dev/null
contains "who lists a listening session" "bob: last read" "$(bash "${bus}" who)"
contains "join prints the next commands" "bus.sh watch m21" "$(bash "${bus}" join m21)"

# --- watch ------------------------------------------------------------------
( sleep 0.2; bash "${bus}" post alice m21 "wake up" >/dev/null ) &
out="$(bash "${bus}" watch m21 10)"
contains "watch exits on arrival with the message" "| wake up" "${out}"
wait

echo "bus.test.sh: ${pass} passed, ${fail} failed"
[ "${fail}" -eq 0 ]
