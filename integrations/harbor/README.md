# arcode on Harbor benchmarks

[Harbor](https://github.com/harbor-framework/harbor) runs agents on containerized benchmarks such as [Terminal-Bench 2.0](https://www.tbench.ai) and SWE-rebench. `arcode_agent.py` plugs arcode into it as a custom agent.

## Setup

1. Docker running (Docker Desktop or similar).
2. Harbor: `uv tool install harbor` (tested with 0.24.0).
3. Your ARC key in `~/.arcode/.env` or exported as `ARC_API_KEY` (see the main README's Setup).
4. Optional check that needs no Docker:
   ```bash
   $(uv tool dir)/harbor/bin/python integrations/harbor/check_adapter.py
   ```

## Run

From this folder, with `PYTHONPATH=.` so Harbor can import `arcode_agent` (Harbor's own Python doesn't look in the current folder):

```bash
cd integrations/harbor

# smoke test: 3 tasks
PYTHONPATH=. harbor run -d terminal-bench/terminal-bench-2 -a arcode_agent:Arcode \
  -m DeepSeek-V4.1-Flash -l 3 -n 1 -o jobs

# one named task
PYTHONPATH=. harbor run -d terminal-bench/terminal-bench-2 -a arcode_agent:Arcode \
  -m GLM-5.3 -i terminal-bench/fix-git -o jobs

# full benchmark (89 tasks), 4 at a time
PYTHONPATH=. harbor run -d terminal-bench/terminal-bench-2 -a arcode_agent:Arcode \
  -m DeepSeek-V4.1-Flash -n 4 -o jobs
```

Task names carry the dataset prefix (`terminal-bench/fix-git`). Agent options go through `--ak`: `--ak max_turns=80`, `--ak temperature=0`, `--ak show_reasoning=true`, `--ak max_output_tokens=8000`, `--ak call_timeout_s=180`, `--ak deadline_s=600`. By default the adapter reads each task's agent timeout from Harbor's task cache and passes it (minus 30 s) as arcode's deadline, so arcode is told when time is running low.

## SWE-rebench

[SWE-rebench](https://arxiv.org/abs/2505.20411) is real GitHub issues collected after model training cutoffs, released in monthly splits (`nebius/SWE-rebench-leaderboard`; 860 tasks on Harbor, 443 repos). Each task is an issue plus the repo at its base commit, in a prebuilt x86 image; hidden tests grade it (50 min agent limit, up to 8 GB RAM). `run_rebench.py` runs a split in batches and removes each batch's Docker images afterwards (they're several GB each):

```bash
cd integrations/harbor
python3 run_rebench.py --split 2026_03 --model DeepSeek-V4.1-Flash --sample 50 --seed 0 --batch 10 -n 2 --dry-run   # plan only
python3 run_rebench.py --split 2026_03 --model DeepSeek-V4.1-Flash --sample 50 --seed 0 --batch 10 -n 2
python3 run_rebench.py ... --resume      # continue an interrupted run, skipping finished tasks
```

It checks the ARC endpoint before starting and after every batch (403 = off the VT network), saves the task list and job names under `runs/<run>/`, and only removes images the batch itself added. Splits so far: `2025_01` ... `2026_03` (110 tasks, issues from March to May 2026); `test` is the whole set. Note the newest split predates some current models, so it isn't guaranteed contamination-free for them.

## What the adapter does

- **Installs the code you have**: it runs `npm run build && npm pack` in this repo and installs that tarball in the task container (after installing Node 22 with Harbor's nvm helper). Uncommitted changes are included, so commit before a run you want to report, and note the commit.
- **Runs** `arcode -p "<task instruction>" --yes -m <model>` in the task's working directory. `-m` accepts ARC model ids (`DeepSeek-V4.1-Flash`) or `arc/<id>`.
- **Key handling**: the key is passed as an environment variable, which Harbor redacts in its logs, and arcode never passes it on to the commands it runs.
- **Trajectories come back**: `ARCODE_HOME` is set to `/logs/agent/arcode`, which Harbor syncs to `jobs/<job>/<trial>/agent/arcode/sessions/*/trajectory.jsonl`. arcode's console output is in `agent/arcode.txt`.
- **Grading is the task's**: arcode exits non-zero when it hits `max_turns`; the adapter records that in `agent/arcode-exit-code` and lets the task's tests decide. Token counts, status and turns go into the trial's agent context.

## Verified

Smoke run, 2026-10-15: `terminal-bench/fix-git` with DeepSeek-V4.1-Flash, reward 1.0 in 12 turns (1 min 22 s including the container build and install), trajectory synced back.

## Notes

- Terminal-Bench 2.0 images are x86_64; on Apple Silicon they run under emulation (slower, but fine).
- VT ARC allows ~60 requests/min shared across concurrent trials; `-n 4` is a reasonable ceiling.
- Results measure **arcode + model**. Compare models within arcode, or arcode against another harness on the same model; don't compare against leaderboard entries that used different scaffolding as if only the model changed.
