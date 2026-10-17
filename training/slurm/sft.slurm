#!/bin/bash
# Stage 2: LoRA SFT on one H200 (VT ARC Tinkercliffs). Submit from a login node:
#   ACCOUNT=<your_allocation> SFT_ENV=$HOME/envs/arcode-sft DATA=$HOME/arcode/training/data \
#     sbatch --account=$ACCOUNT training/slurm/sft.slurm
# Follows the call-centre ARC runbook: short QOS (highest priority, 1-day cap), explicit --mem
# (never --mem=0 on a partial node), env by absolute path, HF_HOME explicit, TERM before the wall.
#SBATCH --job-name=arcode-sft
#SBATCH --partition=h200_normal_q
#SBATCH --qos=tc_h200_normal_short
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=8
#SBATCH --mem=120G
#SBATCH --time=23:00:00
#SBATCH --signal=B:TERM@300
#SBATCH --output=%x-%j.out
set -euo pipefail

: "${SFT_ENV:?set SFT_ENV to the training conda env (absolute path)}"
: "${DATA:?set DATA to the prepare_sft.py output dir}"
MODEL=${MODEL:-Qwen/Qwen3-8B}
OUT=${OUT:-$HOME/arcode-runs/sft-$(basename "$MODEL")-$SLURM_JOB_ID}
export HF_HOME=${HF_HOME:-$HOME/hf_cache}
export PYTHONNOUSERSITE=1 TOKENIZERS_PARALLELISM=false
export PATH="$SFT_ENV/bin:$PATH"

module load CUDA/12.6.0 2>/dev/null || true
PY="$SFT_ENV/bin/python"
"$PY" -c "import sys, torch, trl, transformers, peft; print(sys.executable, 'torch', torch.__version__, 'cuda', torch.cuda.is_available(), 'trl', trl.__version__, 'transformers', transformers.__version__)"
[ "$(nvidia-smi -L | wc -l)" -ge 1 ] || { echo "no GPU visible"; exit 1; }

trap 'echo "TERM received: checkpoint is in $OUT; resubmit with OUT=$OUT to resume"; kill -TERM $child; wait $child' TERM
# SLURM runs a copy of this file from its spool dir, so locate the repo via the submit dir.
cd "$SLURM_SUBMIT_DIR/training" || { echo "submit from the arcode repo root"; exit 1; }
"$PY" train_sft.py --model "$MODEL" --data "$DATA" --out "$OUT" ${EXTRA_ARGS:-} &
child=$!
wait $child
echo "done: adapter in $OUT/adapter"
