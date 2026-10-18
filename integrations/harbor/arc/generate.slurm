#!/bin/bash
# Stage 1 on VT ARC: the teacher (DeepSeek-V4.1-Flash on ARC's API) solves SWE-rebench training tasks
# in arcode, in Apptainer containers. Resumable: resubmit the same command to continue.
# From the arcode repo root on an OWL login node, after preflight.slurm passes:
#   sbatch --account=<alloc> integrations/harbor/arc/generate.slurm
# Knobs (environment at submit): CONCURRENCY (8), BATCH (16), RUN_ARGS (default: the train run).
#SBATCH --job-name=arcode-gen
#SBATCH --partition=normal_q
#SBATCH --qos=owl_normal_base
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=32
#SBATCH --mem=128G
#SBATCH --time=3-00:00:00
#SBATCH --signal=B:TERM@300
#SBATCH --output=%x-%j.out
set -euo pipefail
cd "$SLURM_SUBMIT_DIR/integrations/harbor" || { echo "submit from the arcode repo root"; exit 1; }
. arc/env.sh

RUN_ARGS=${RUN_ARGS:---split train --model DeepSeek-V4.1-Flash --seed 0}
# Up to 8 GB per task (SWE-rebench's limit): 8 at a time fits --mem=128G with room for Harbor.
setsid "$PY" -u run_rebench.py --backend singularity --sif-dir "$WORK/sif" --tasks-dir "$HOME/arcode-tasks" \
  $RUN_ARGS --batch "${BATCH:-16}" -n "${CONCURRENCY:-8}" --resume &
child=$!
# On the wall-clock warning, stop Harbor and its containers; interrupted trials are ungraded, so
# --resume retries them.
trap 'echo "TERM: stopping; resubmit the same sbatch command to continue"; kill -TERM -- -$child 2>/dev/null; wait $child' TERM
wait $child
"$PY" analyze_run.py runs/rebench-train-DeepSeek-V4.1-Flash-s0 | head -4
