#!/bin/bash
# Serve the base student and the trained LoRA adapter with vLLM (OpenAI-compatible) on one H200,
# so arcode (on your Mac, through an SSH tunnel) can be benchmarked against both.
#   ACCOUNT=<alloc> VLLM_ENV=$HOME/envs/arcode-vllm ADAPTER=$HOME/arcode-runs/sft-.../adapter \
#     sbatch --account=$ACCOUNT training/slurm/serve.slurm
# Then read the node name from the log and, on your Mac:
#   ssh -N -L 8000:<node>:8000 <pid>@tinkercliffs1.arc.vt.edu
# Model names to use with arcode: "base" and "sft" (see training/README.md).
#SBATCH --job-name=arcode-serve
#SBATCH --partition=h200_normal_q
#SBATCH --qos=tc_h200_normal_short
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=8
#SBATCH --mem=96G
#SBATCH --time=23:00:00
#SBATCH --output=%x-%j.out
set -euo pipefail

: "${VLLM_ENV:?set VLLM_ENV to the vLLM conda env (absolute path; keep it separate from the training env)}"
MODEL=${MODEL:-Qwen/Qwen3-8B}
PORT=${PORT:-8000}
MAX_LEN=${MAX_LEN:-32768}
export HF_HOME=${HF_HOME:-$HOME/hf_cache}
export PYTHONNOUSERSITE=1
export PATH="$VLLM_ENV/bin:$PATH"
module load CUDA/12.6.0 2>/dev/null || true

LORA_ARGS=()
if [ -n "${ADAPTER:-}" ]; then
  LORA_ARGS=(--enable-lora --max-lora-rank 64 --lora-modules "sft=$ADAPTER")
fi
echo "serving $MODEL (as 'base')${ADAPTER:+ + adapter $ADAPTER (as 'sft')} on $(hostname):$PORT"
echo "tunnel from your Mac:  ssh -N -L $PORT:$(hostname):$PORT $USER@tinkercliffs1.arc.vt.edu"
# Qwen3 emits <tool_call> JSON (Hermes format); vLLM parses it into tool_calls for arcode.
exec "$VLLM_ENV/bin/python" -m vllm.entrypoints.openai.api_server \
  --model "$MODEL" --served-model-name base \
  --host 0.0.0.0 --port "$PORT" --max-model-len "$MAX_LEN" \
  --enable-auto-tool-choice --tool-call-parser hermes \
  "${LORA_ARGS[@]}"
