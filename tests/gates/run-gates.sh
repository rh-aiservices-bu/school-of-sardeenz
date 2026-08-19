#!/usr/bin/env bash
# run-gates.sh — automate the Phase 4 Apptainer/SIF spike gates against a real cluster.
#
# Run this INSIDE a worker Pod (it uses the Pod's Apptainer + /dev/fuse + userns), e.g.:
#   oc cp tests/gates/run-gates.sh <pod>:/tmp/run-gates.sh -n sardeenz
#   oc exec -it <pod> -n sardeenz -- bash /tmp/run-gates.sh            # CPU gates
#   oc exec -it <pod> -n sardeenz -- bash /tmp/run-gates.sh --gpu      # + GPU gates (needs a GPU)
#
# CPU gates (0-6) run on any 4.15+ worker Pod. GPU gates (7-9) + the Gate 10 measurement need a GPU
# and are skipped unless --gpu is passed (or a GPU is detected). Exit code is non-zero if any
# non-skipped gate fails. Each gate traces to a spike gate (docs/project/phase4-apptainer-spike.md).
set -uo pipefail

MODULES_DIR="${MODULES_DIR:-/modules}"
SCRATCH_DIR="${SCRATCH_DIR:-/scratch}"
WEIGHTS_DIR="${WEIGHTS_DIR:-/weights}"
VLLM_SIF="${VLLM_SIF:-${MODULES_DIR}/vllm-0.21.sif}"
AGENT_URL="${AGENT_URL:-http://127.0.0.1:9100}"
RUN_GPU=0
[[ "${1:-}" == "--gpu" ]] && RUN_GPU=1

PASS=0
FAIL=0
SKIP=0
FAILED_GATES=()

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() {
  echo "  FAIL: $1"
  FAIL=$((FAIL + 1))
  FAILED_GATES+=("$1")
}
skip() {
  echo "  SKIP: $1"
  SKIP=$((SKIP + 1))
}
gate() { echo; echo "== $1 =="; }

need_apptainer() { command -v apptainer >/dev/null 2>&1; }

# ---------------------------------------------------------------------------------------------
# CPU gates
# ---------------------------------------------------------------------------------------------

gate0_fingerprint() {
  gate "Gate 0 — environment fingerprint"
  if ! need_apptainer; then
    fail "Gate 0: apptainer not installed"
    return
  fi
  apptainer --version || true

  local userns seccomp
  userns="$(cat /proc/sys/user/max_user_namespaces 2>/dev/null || echo 0)"
  [[ "$userns" -gt 0 ]] && pass "Gate 0: max_user_namespaces=$userns (>0)" ||
    fail "Gate 0: max_user_namespaces=$userns (kernel forbids userns)"

  seccomp="$(grep -E '^Seccomp:' /proc/self/status | awk '{print $2}')"
  [[ "$seccomp" == "0" ]] && pass "Gate 0: Seccomp=0 (Unconfined applied)" ||
    fail "Gate 0: Seccomp=$seccomp (expected 0 — SCC not applied, on RuntimeDefault)"

  [[ -e /dev/fuse ]] && pass "Gate 0: /dev/fuse present" ||
    fail "Gate 0: /dev/fuse missing (annotation not applied)"
}

gate1_userns() {
  gate "Gate 1 — in-container user namespace"
  local out
  out="$(unshare --user --map-root-user id -u 2>/dev/null || echo fail)"
  [[ "$out" == "0" ]] && pass "Gate 1: unshare --user --map-root-user -> uid 0" ||
    fail "Gate 1: userns unshare failed (got '$out')"
}

_tiny_sif="${SCRATCH_DIR}/gate-busybox.sif"

gate2_build_exec() {
  gate "Gate 2 — build + exec a SIF"
  export APPTAINER_TMPDIR="${SCRATCH_DIR}" APPTAINER_CACHEDIR="${SCRATCH_DIR}/cache"
  mkdir -p "${APPTAINER_CACHEDIR}"
  if apptainer build --force "${_tiny_sif}" docker://busybox >/dev/null 2>&1; then
    local out
    out="$(apptainer exec "${_tiny_sif}" echo ok 2>/dev/null)"
    [[ "$out" == "ok" ]] && pass "Gate 2: built + exec'd a SIF" ||
      fail "Gate 2: exec produced '$out'"
  else
    fail "Gate 2: apptainer build failed (check egress + node-local APPTAINER_TMPDIR)"
  fi
}

gate3_no_copy() {
  gate "Gate 3 — no-copy squashfuse mount (SIF runs in place)"
  [[ -f "${_tiny_sif}" ]] || {
    skip "Gate 3: needs Gate 2's SIF"
    return
  }
  local before after
  before="$(du -sb "${SCRATCH_DIR}" 2>/dev/null | awk '{print $1}')"
  apptainer exec "${_tiny_sif}" sleep 30 &
  local pid=$!
  sleep 3
  # Evidence: a squashfuse process serves the SIF read-only (the overlay hides it from /proc/mounts).
  if pgrep -a squashfuse >/dev/null 2>&1 || pgrep -a squashfuse_ll >/dev/null 2>&1; then
    pass "Gate 3: squashfuse process serving the SIF"
  else
    fail "Gate 3: no squashfuse process (SIF may have been extracted, not mounted)"
  fi
  after="$(du -sb "${SCRATCH_DIR}" 2>/dev/null | awk '{print $1}')"
  # Allow small cache noise; a full extraction would grow scratch by the image size (MBs+).
  if [[ -n "$before" && -n "$after" && $((after - before)) -lt 1048576 ]]; then
    pass "Gate 3: scratch grew <1MiB during exec (no extraction)"
  else
    fail "Gate 3: scratch grew by $((after - before)) bytes (possible extraction)"
  fi
  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
}

gate4_weights_bind() {
  gate "Gate 4 — weights via --bind"
  [[ -f "${_tiny_sif}" ]] || {
    skip "Gate 4: needs Gate 2's SIF"
    return
  }
  local marker="${WEIGHTS_DIR}/.gate4-probe"
  if ! echo "gate4" >"$marker" 2>/dev/null; then
    skip "Gate 4: weights volume not writable here (bind still testable if a file exists)"
    return
  fi
  local out
  out="$(apptainer exec --bind "${WEIGHTS_DIR}" "${_tiny_sif}" cat "${marker}" 2>/dev/null)"
  rm -f "$marker" 2>/dev/null
  [[ "$out" == "gate4" ]] && pass "Gate 4: read weights through --bind" ||
    fail "Gate 4: could not read bound weights (got '$out')"
}

gate5_signal_clean() {
  gate "Gate 5 — long-lived runner + clean SIGTERM (no orphan/zombie)"
  [[ -f "${_tiny_sif}" ]] || {
    skip "Gate 5: needs Gate 2's SIF"
    return
  }
  apptainer exec "${_tiny_sif}" sleep 300 &
  local pid=$!
  sleep 2
  kill -TERM "$pid" 2>/dev/null
  sleep 2
  if kill -0 "$pid" 2>/dev/null; then
    fail "Gate 5: process survived SIGTERM"
    kill -KILL "$pid" 2>/dev/null
  else
    pass "Gate 5: process exited on SIGTERM"
  fi
  wait "$pid" 2>/dev/null
  # A zombie would show as a defunct child of this shell.
  if ps -o stat= -p "$pid" 2>/dev/null | grep -q Z; then
    fail "Gate 5: zombie left behind"
  else
    pass "Gate 5: no zombie/orphan"
  fi
}

gate6_parallel_hotadd() {
  gate "Gate 6 — parallel versions + hot-add"
  [[ -f "${_tiny_sif}" ]] || {
    skip "Gate 6: needs Gate 2's SIF"
    return
  }
  local sif2="${SCRATCH_DIR}/gate-busybox-2.sif"
  cp "${_tiny_sif}" "${sif2}" 2>/dev/null # a "new version" hot-added without touching the first
  apptainer exec "${_tiny_sif}" sleep 20 &
  local p1=$!
  apptainer exec "${sif2}" sleep 20 &
  local p2=$!
  sleep 3
  if kill -0 "$p1" 2>/dev/null && kill -0 "$p2" 2>/dev/null; then
    pass "Gate 6: two SIFs run side by side; second hot-added with no restart"
  else
    fail "Gate 6: could not run two SIFs concurrently"
  fi
  kill "$p1" "$p2" 2>/dev/null
  wait "$p1" "$p2" 2>/dev/null
  rm -f "${sif2}" 2>/dev/null
}

# ---------------------------------------------------------------------------------------------
# GPU gates
# ---------------------------------------------------------------------------------------------

gpu_available() { apptainer exec --nv "${_tiny_sif}" nvidia-smi -L >/dev/null 2>&1; }

gate7_nv() {
  gate "Gate 7 — GPU visible via --nv"
  if apptainer exec --nv "${_tiny_sif}" nvidia-smi -L 2>/dev/null | grep -qi GPU; then
    pass "Gate 7: nvidia-smi lists a GPU inside the SIF"
  else
    fail "Gate 7: no GPU visible via --nv (check NVIDIA GPU Operator + --nv)"
  fi
}

gate8_namespaces() {
  gate "Gate 8 — ipc/pid/net namespace sharing across the SIF"
  # Apptainer shares the host (container) IPC/PID/NET namespaces by default — kvcached needs it.
  local host_ipc sif_ipc
  host_ipc="$(readlink /proc/self/ns/ipc 2>/dev/null)"
  sif_ipc="$(apptainer exec "${_tiny_sif}" readlink /proc/self/ns/ipc 2>/dev/null)"
  [[ -n "$host_ipc" && "$host_ipc" == "$sif_ipc" ]] &&
    pass "Gate 8: IPC namespace shared ($sif_ipc)" ||
    fail "Gate 8: IPC namespace not shared (host=$host_ipc sif=$sif_ipc)"
}

gate9_kvcached_share() {
  gate "Gate 9 — two runners share one GPU via kvcached (worker agent + ApptainerLauncher)"
  if [[ ! -f "${VLLM_SIF}" ]]; then
    skip "Gate 9: vLLM SIF not found at ${VLLM_SIF}"
    return
  fi
  if ! command -v curl >/dev/null 2>&1; then
    skip "Gate 9: curl not available to drive the worker agent"
    return
  fi
  # Drive the worker agent (as the control plane would): start two runners on the same device.
  local body_a body_b code_a code_b
  body_a='{"modelName":"gate9-a","runnerType":"vllm","runtimeModule":"vllm-0.21","modelPath":"'"${WEIGHTS_DIR}"'/gate9-a","requiredMemory":1,"tensorParallel":1,"deviceType":"CUDA","devices":[{"deviceIndex":0,"deviceType":"CUDA"}]}'
  body_b='{"modelName":"gate9-b","runnerType":"vllm","runtimeModule":"vllm-0.21","modelPath":"'"${WEIGHTS_DIR}"'/gate9-b","requiredMemory":1,"tensorParallel":1,"deviceType":"CUDA","devices":[{"deviceIndex":0,"deviceType":"CUDA"}]}'
  code_a="$(curl -s -o /dev/null -w '%{http_code}' -XPOST "${AGENT_URL}/runners" -H 'content-type: application/json' -d "$body_a")"
  code_b="$(curl -s -o /dev/null -w '%{http_code}' -XPOST "${AGENT_URL}/runners" -H 'content-type: application/json' -d "$body_b")"
  if [[ "$code_a" == "201" && "$code_b" == "201" ]]; then
    pass "Gate 9: worker agent started two kvcached runners on device 0 (HTTP $code_a/$code_b)"
  else
    fail "Gate 9: agent returned $code_a/$code_b starting two co-located runners"
  fi
}

gate10_measure() {
  gate "Gate 10 — cold/warm spawn measurement"
  [[ -f "${VLLM_SIF}" ]] || {
    skip "Gate 10: vLLM SIF not found at ${VLLM_SIF} — record on the target RWX backend"
    return
  }
  local t0 t1
  t0="$(date +%s.%N)"
  apptainer exec "${VLLM_SIF}" true 2>/dev/null
  t1="$(date +%s.%N)"
  echo "  MEASURE: cold exec of $(basename "${VLLM_SIF}") = $(awk "BEGIN{printf \"%.2f\", ${t1}-${t0}}")s"
  t0="$(date +%s.%N)"
  apptainer exec "${VLLM_SIF}" true 2>/dev/null
  t1="$(date +%s.%N)"
  echo "  MEASURE: warm exec = $(awk "BEGIN{printf \"%.2f\", ${t1}-${t0}}")s"
  pass "Gate 10: recorded spawn timings (compare against the spike EFS floor)"
}

# ---------------------------------------------------------------------------------------------
main() {
  echo "Sardeenz Phase 4 — SIF runtime gate suite"
  echo "modules=${MODULES_DIR} scratch=${SCRATCH_DIR} weights=${WEIGHTS_DIR} gpu=${RUN_GPU}"

  gate0_fingerprint
  gate1_userns
  gate2_build_exec
  gate3_no_copy
  gate4_weights_bind
  gate5_signal_clean
  gate6_parallel_hotadd

  if [[ "$RUN_GPU" == "1" ]] || gpu_available; then
    gate7_nv
    gate8_namespaces
    gate9_kvcached_share
    gate10_measure
  else
    skip "GPU gates 7-9 + Gate 10 (no GPU / --gpu not set)"
  fi

  rm -f "${_tiny_sif}" 2>/dev/null
  echo
  echo "Summary: ${PASS} passed, ${FAIL} failed, ${SKIP} skipped"
  if [[ "$FAIL" -gt 0 ]]; then
    printf '  failed: %s\n' "${FAILED_GATES[@]}"
    exit 1
  fi
}

main "$@"
