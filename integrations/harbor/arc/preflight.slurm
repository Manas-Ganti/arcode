#!/bin/bash
# Checks everything the generation job relies on, on a real compute node, before a multi-day job:
# ARC API reachable, Docker Hub pull, the container flags Harbor uses (--fakeroot --writable-tmpfs
# --containall), the runtime bind, room in the writable overlay, then 2 real tasks end to end.
# From the arcode repo root on an OWL login node:
#   sbatch --account=<alloc> integrations/harbor/arc/preflight.slurm
#SBATCH --job-name=arcode-preflight
#SBATCH --partition=normal_q
#SBATCH --qos=owl_normal_base
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=32G
#SBATCH --time=02:00:00
#SBATCH --output=%x-%j.out
set -uo pipefail
cd "$SLURM_SUBMIT_DIR/integrations/harbor" || { echo "submit from the arcode repo root"; exit 1; }
. arc/env.sh

fails=0
check() { local name=$1; shift; if "$@"; then echo "PASS  $name"; else echo "FAIL  $name"; fails=$((fails + 1)); fi; }

echo; echo "== 1. ARC API from a compute node"
check "ARC endpoint answers with the key in ~/.arcode/.env" "$PY" -c "import run_rebench as r; r.check_arc()"

echo; echo "== 2. pull one SWE-rebench image (timed)"
IMG=docker://swerebench/sweb.eval.x86_64.boxed_1776_mutmut-403:latest
SIF="$WORK/sif/preflight.sif"
start=$SECONDS
check "singularity pull $IMG" singularity pull --disable-cache "$SIF" "$IMG"
echo "pull took $((SECONDS - start)) s, image $(du -h "$SIF" 2>/dev/null | cut -f1)"

echo; echo "== 3. the container flags Harbor uses, the runtime bind, overlay room"
run_in() { singularity exec --no-mount home,tmp,bind-paths --writable-tmpfs --fakeroot --containall --pid "$SIF" bash -c "$1"; }
check "exec with --fakeroot --writable-tmpfs --containall" run_in 'true'
check "repo at /testbed" run_in 'test -d /testbed/.git'
check "runtime bound at $ARCODE_RUNTIME, node runs (glibc ok)" run_in "$ARCODE_RUNTIME/node/bin/node --version"
check "arcode runs inside the task image" run_in "export PATH=$ARCODE_RUNTIME/node/bin:$ARCODE_RUNTIME/prefix/bin:\$PATH; arcode --help >/dev/null"
check "root inside (fakeroot): can write /usr/local/bin and /logs" run_in 'mkdir -p /logs && touch /usr/local/bin/x'
# Harbor's bootstrap apt-updates, builds a venv and pip-installs its server into /opt, and the task
# writes into /testbed: the writable layer needs a few hundred MB. Try RAM tmpfs (Harbor's default),
# else an on-disk overlay dir (the shim swaps it in), and record what works for generate.slurm.
fill='dd if=/dev/zero of=/opt/fill bs=1M count=300 status=none'
if run_in "$fill"; then
  echo tmpfs > "$RT/overlay_mode"; echo "PASS  writable layer holds 300 MB (tmpfs)"
else
  echo "info  tmpfs overlay too small (cluster sessiondir cap); trying an on-disk overlay"
  export ARCODE_OVERLAY_ROOT="$WORK/overlay"; mkdir -p "$ARCODE_OVERLAY_ROOT"
  if run_in "$fill" && run_in "$ARCODE_RUNTIME/node/bin/node --version >/dev/null"; then
    echo dir > "$RT/overlay_mode"; echo "PASS  writable layer holds 300 MB (on-disk overlay)"
  else
    echo "FAIL  no writable layer of 300 MB (tmpfs or overlay dir): ask ARC help about apptainer sessiondir max size / fakeroot overlays"; fails=$((fails + 1))
  fi
fi
echo "container overlay mode: $(cat "$RT/overlay_mode" 2>/dev/null)"
rm -f "$SIF"

echo; echo "== 4. two real tasks end to end (the first two of the training run, so this is real data)"
"$PY" -u run_rebench.py --backend singularity --sif-dir "$WORK/sif" --tasks-dir "$HOME/arcode-tasks" \
  --split train --model DeepSeek-V4.1-Flash --seed 0 --batch 2 -n 2 --resume --max-tasks 2
"$PY" analyze_run.py runs/rebench-train-DeepSeek-V4.1-Flash-s0 | head -3
last=$("$PY" -c "import json; print(json.load(open('runs/rebench-train-DeepSeek-V4.1-Flash-s0/jobs.json'))[-1])")
check "both trials graded (a reward, not an infrastructure error)" "$PY" - "$last" <<'EOF'
import json, sys
from pathlib import Path
rs = [json.loads(p.read_text()) for p in Path("jobs", sys.argv[1]).glob("*/result.json") if "task_name" in json.loads(p.read_text())]
for r in rs:
    e = r.get("exception_info") or {}
    print(" ", r["task_name"], (r.get("verifier_result") or {}).get("rewards"), e.get("exception_type") or "", (e.get("exception_message") or "")[:300])
sys.exit(0 if rs and all((r.get("verifier_result") or {}).get("rewards", {}).get("reward") is not None for r in rs) else 1)
EOF

echo
if [ "$fails" -eq 0 ]; then echo "PREFLIGHT OK: sbatch --account=<alloc> integrations/harbor/arc/generate.slurm"; else echo "PREFLIGHT: $fails check(s) failed (see above)"; fi
exit "$fails"
