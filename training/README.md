# Training a student model on arcode's trajectories

Stage 2 of the RL loop: rejection-sampling fine-tuning. A large **teacher** (DeepSeek-V4.1-Flash, 763B, MIT, via VT ARC's hosted API) solves tasks inside arcode; only runs whose hidden tests pass become training data for a small **student** (default Qwen3-8B, Apache-2.0), trained with LoRA on one ARC GPU. The student is then served with vLLM and benchmarked in arcode against its untrained base on held-out tasks.

```
teacher (ARC API) --arcode + Harbor--> trajectories + rewards --arcode export--> SFT JSONL
  --prepare_sft.py--> train/val --train_sft.py (1x H200, LoRA)--> adapter
  --serve.slurm (vLLM)--> arcode benchmark: base vs sft on held-out SWE-rebench tasks
```

## 1. Data

Generation runs on ARC: see [`integrations/harbor/arc/README.md`](../integrations/harbor/arc/README.md) (Apptainer instead of Docker, one resumable SLURM job, export on ARC). On a Mac with Docker, the same steps are:

```bash
# Training trajectories (resumable; months 2025_01..2026_01, test months held out)
python3 integrations/harbor/run_rebench.py --split train --model DeepSeek-V4.1-Flash --batch 10 -n 2 --resume

# Export resolved runs; never include the held-out test tasks
arcode export integrations/harbor/jobs -o sft.jsonl --max-tool-chars 8000 \
  --exclude integrations/harbor/runs/rebench-2026_03-DeepSeek-V4.1-Flash-s0/tasks.json

# Tokenize-aware split + checks (needs transformers + datasets)
python training/prepare_sft.py sft.jsonl --model Qwen/Qwen3-8B --max-length 32768 --out training/data
```

`prepare_sft.py` splits by task, drops examples longer than `--max-length` (by real token count), stores `tools` as a JSON string, and refuses to continue if the `datasets` round trip would change what the chat template renders. Arrow merges every tool's parameter schema into one struct otherwise, and the student would train on tool definitions it never sees at run time.

## 2. Train (VT ARC)

Two conda envs, never one (their `transformers` pins conflict; see the call-centre ARC runbook):
- training env: `trl==1.9.2 transformers==5.15.0 peft datasets accelerate` + torch 2.6.0+cu126
- vLLM env: the cluster's tested vLLM (0.8.5) for serving

```bash
# on ARC, from the arcode repo root (scp/rsync training/data over first)
ACCOUNT=<alloc> SFT_ENV=$HOME/envs/arcode-sft DATA=$PWD/training/data \
  sbatch --account=$ACCOUNT training/slurm/sft.slurm
```

Defaults: LoRA r=64 on all linear layers, lr 1e-4 cosine, 2 epochs, effective batch 16, 32k context, loss on assistant turns only (TRL patches Qwen3's template with `{% generation %}` markers and the script checks the mask). Resumable: resubmit with the same `OUT=` after a timeout. Output: `$OUT/adapter`, `run_config.json` (base model, arcode commit, data stats).

## 3. Serve and benchmark

```bash
# ARC: base model as "base", adapter as "sft"
ACCOUNT=<alloc> VLLM_ENV=$HOME/envs/arcode-vllm ADAPTER=$HOME/arcode-runs/<run>/adapter \
  sbatch --account=$ACCOUNT training/slurm/serve.slurm
# Mac: tunnel to the node printed in the log
ssh -N -L 8000:<node>:8000 <pid>@tinkercliffs1.arc.vt.edu
```

Then run the same 50 held-out SWE-rebench tasks for both models. Docker containers reach the tunnel on your Mac as `host.docker.internal`:

```bash
cd integrations/harbor
for m in base sft; do
  ARC_BASE_URL=http://host.docker.internal:8000/v1 ARC_API_KEY=local \
  python3 run_rebench.py --split 2026_03 --sample 50 --seed 0 --model $m --run heldout-$m --batch 10 -n 2 \
    --ak max_tool_chars=8000 --ak 'extra_body={"chat_template_kwargs":{"enable_thinking":false}}'
done
python3 analyze_run.py runs/heldout-base && python3 analyze_run.py runs/heldout-sft
```

Keep the evaluation identical to training: the same `--max-tool-chars` cap (8000) and thinking off (the training template renders an empty `<think></think>` per turn). The comparison that matters is **base vs sft on the same held-out tasks**; the teacher's 44/50 is the ceiling.

## Checks before spending GPU hours

- `python training/prepare_sft.py ...` prints `arrow_roundtrip_changes_rendering: 0`.
- `train_sft.py` prints the trained fraction of the first example (should be well under 100%: agent turns only).
- A CPU smoke run with a tiny model (no GPU needed):
  `python training/train_sft.py --model trl-internal-testing/tiny-Qwen3ForCausalLM --chat-template-from Qwen/Qwen3-8B --data <smoke data> --out /tmp/smoke --max-length 3000 --max-steps 3 --grad-accum 1 --lora-r 8`
