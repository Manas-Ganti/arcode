# Generating training data on VT ARC

Stage 1 of the RL loop (the teacher solving SWE-rebench training tasks in arcode) running on ARC instead of a laptop. ARC has no Docker, so tasks run in **Apptainer** through Harbor's Singularity backend. The scripts here deal with the differences:

| On a Mac with Docker | On ARC with Apptainer |
|---|---|
| Harbor builds each task's Dockerfile | the converter (`run_rebench.py --backend singularity`) puts the image name into `task.toml` and runs the image as pulled |
| the image's working dir | pinned to `/testbed`, where SWE-rebench repos live (otherwise it's an empty `/app`) |
| the adapter installs Node and arcode into every container | Node and arcode are built once (`setup.sh`) and mounted read-only at `/opt/arcode-rt` |
| the Dockerfile adds `uv` and `/logs` | the adapter's HPC mode adds them at install time |
| a Docker disk image that grows (it filled the Mac) | images go to node-local scratch and are deleted after every batch; the job deletes its scratch at exit |

Tasks the infrastructure interrupts (failed image pull, wall-clock kill, cancelled) are **ungraded**, so `--resume` retries them instead of counting them as failures.

## What goes where, and how

| What | How it gets to ARC | Size |
|---|---|---|
| the code | `git clone` from GitHub (push from the Mac first) | small |
| trajectories already collected on the Mac | `rsync` from the Mac (one command below) | ~60 MB |
| the ARC API key | `scp` of `~/.arcode/.env`, then `chmod 600` | 1 line |
| task definitions, container images, Node, Harbor | downloaded on ARC directly (campus network; nothing to copy) | GBs, pulled per batch |

## Steps

**1. From the Mac** (VPN on), after the code is pushed:
```bash
ssh owl1.arc.vt.edu 'git clone https://github.com/Manas-Ganti/arcode.git ~/arcode && mkdir -p ~/.arcode && chmod 700 ~/.arcode'
scp ~/.arcode/.env owl1.arc.vt.edu:.arcode/.env && ssh owl1.arc.vt.edu 'chmod 600 ~/.arcode/.env'
rsync -az ~/portfolio-projects/arcode/integrations/harbor/jobs/ owl1.arc.vt.edu:arcode/integrations/harbor/jobs/
```
The rsync brings the runs finished so far, so `--resume` skips them and the export includes them.

Optional, recommended: Docker Hub rate-limits anonymous pulls per IP, and the cluster's nodes share IPs. With a free Docker Hub account, create an access token and put it on ARC in `~/.arcode/dockerhub.env` (mode 600):
```
APPTAINER_DOCKER_USERNAME=<docker hub user>
APPTAINER_DOCKER_PASSWORD=<access token>
```

**2. On ARC** (an OWL login node), once, and again after each `git pull`:
```bash
cd ~/arcode && bash integrations/harbor/arc/setup.sh
```
Installs uv and Harbor 0.24.0, Node 22, and arcode built from this checkout into `~/arcode-rt` (~250 MB), plus the `singularity` wrapper.

**3. Preflight** (~30–60 min; runs 2 real training tasks, which count as data):
```bash
sbatch --account=<alloc> integrations/harbor/arc/preflight.slurm
tail -f arcode-preflight-<jobid>.out
```
It checks:
- the ARC API from a compute node;
- a timed image pull;
- the exact container flags Harbor uses (`--fakeroot --writable-tmpfs --containall`);
- the runtime mount and Node working inside a task image;
- the size of the writable layer (it picks a RAM tmpfs or an on-disk overlay and records the choice);
- two real tasks graded end to end.

It ends with `PREFLIGHT OK` or a list of `FAIL` lines.

**4. Generate** (one node, 8 tasks at a time, up to 3 days, resumable):
```bash
sbatch --account=<alloc> integrations/harbor/arc/generate.slurm
python3 integrations/harbor/analyze_run.py integrations/harbor/runs/rebench-train-DeepSeek-V4.1-Flash-s0   # progress
```
To continue after a timeout or a failure, submit the same command again. Knobs at submit time:
- `CONCURRENCY=12` (default 8; each task may use up to 8 GB, and the job asks for 128 GB);
- `BATCH=16` (default 16);
- `RUN_ARGS='--split train --model GLM-5.3 --seed 0'` for a different teacher or run.

**5. Export and train, also on ARC** (no copying back):
```bash
PATH=$HOME/arcode-rt/node/bin:$PATH node dist/cli.js export integrations/harbor/jobs -o sft.jsonl \
  --max-tool-chars 8000 --exclude integrations/harbor/runs/rebench-2026_03-DeepSeek-V4.1-Flash-s0/tasks.json
```
Then continue with `training/README.md` (`prepare_sft.py`, then `sft.slurm` on a Tinkercliffs H200). Submit GPU jobs from `tinkercliffs1`. ARC's `/home` should be the same on both clusters; check `ls ~/arcode` there.

## Known risks (preflight checks each one)

- **`--fakeroot`**: Harbor always passes it. If the cluster doesn't allow it, the "exec with --fakeroot" check fails. Ask ARC help; Harbor would need patching.
- **Writable layer size**: Apptainer caps `--writable-tmpfs` (64 MB by default; set by the cluster), which is too small for Harbor's server and a task. The `singularity` wrapper from `setup.sh` swaps in an on-disk overlay, and preflight picks whichever mode works (`~/arcode-rt/overlay_mode`).
- **Docker Hub limits**: a failed pull leaves the task ungraded, so it's retried on resume. If the log shows many `toomanyrequests` errors, add the login above.
- **ARC API load**: at 8 concurrent tasks, watch the log for `llm_retry` events. Lower `CONCURRENCY` if retries pile up.
- **Partition/QOS**: `normal_q` with `owl_normal_base` (7 days, 1x billing) is the call-centre known-good OWL setup as of Oct 2026. Check with `sacctmgr show qos format=name%28,priority,maxwall`.
