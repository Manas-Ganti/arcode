"""
Run arcode on a SWE-rebench monthly split through Harbor, in batches that clean up after themselves.

    cd integrations/harbor
    python3 run_rebench.py --split 2026_03 --model DeepSeek-V4.1-Flash --sample 50 --seed 0 --batch 10 -n 2

- Task ids come from the split on Hugging Face (nebius/SWE-rebench-leaderboard); the chosen list is
  saved to runs/<run>/tasks.json, so a run can be reproduced or resumed (--resume skips finished tasks).
- Checks the ARC endpoint first: off the VT network ARC answers 403, and every task would score a fake 0.
- Each batch is one `harbor run` job under jobs/. After a batch, Docker images that the batch added are
  removed (pre-existing images are never touched): SWE-rebench images are several GB each. Docker's
  build cache is pruned too (removing images alone doesn't free it; it filled a 228 GB disk in ~50 tasks).
- Stops before a batch if the disk is low (--min-free-gb), instead of failing mid-batch.
- `--backend singularity` runs on an HPC cluster with Apptainer instead of Docker (VT ARC: see
  arc/README.md). Each task is downloaded with `harbor download`, converted for Apptainer (image name
  into task.toml, workdir /testbed: see convert_task), and run from a local copy; images are pulled to
  --sif-dir and deleted after each batch.
- Standard library only; uses the `harbor` and `docker` (or `apptainer`) CLIs.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
HF_ROWS = "https://datasets-server.huggingface.co/rows?dataset=nebius/SWE-rebench-leaderboard&config=default&split={split}&offset={offset}&length=100"
HF_SPLITS = "https://datasets-server.huggingface.co/splits?dataset=nebius/SWE-rebench-leaderboard"
DATASET = "swe-rebench/swe-rebench-leaderboard"
ARC_MODELS = "https://llm-api.arc.vt.edu/api/v1/models"


def split_ids(split: str) -> list[str]:
    ids: list[str] = []
    while True:
        with urllib.request.urlopen(HF_ROWS.format(split=split, offset=len(ids)), timeout=60) as r:
            page = json.load(r)
        ids += [row["row"]["instance_id"] for row in page["rows"]]
        if not page["rows"] or len(ids) >= page["num_rows_total"]:
            return ids


def resolve_splits(spec: str, holdout: list[str]) -> list[str]:
    """`train` = every monthly split (YYYY_MM) except the held-out ones; otherwise a comma list."""
    if spec != "train":
        return spec.split(",")
    with urllib.request.urlopen(HF_SPLITS, timeout=60) as r:
        names = [s["split"] for s in json.load(r)["splits"]]
    return [s for s in names if s[:2] == "20" and s not in holdout]


def arc_key() -> str | None:
    if os.environ.get("ARC_API_KEY"):
        return os.environ["ARC_API_KEY"]
    env = Path(os.environ.get("ARCODE_HOME", Path.home() / ".arcode")) / ".env"
    for line in env.read_text().splitlines() if env.exists() else []:
        if line.startswith(("ARC_API_KEY=", "VTARC_API_KEY=")):
            return line.split("=", 1)[1].strip().strip("'\"")
    return None


def check_arc() -> None:
    if os.environ.get("ARC_BASE_URL"):
        return  # another endpoint; nothing ARC-specific to check
    req = urllib.request.Request(ARC_MODELS, headers={"Authorization": f"Bearer {arc_key()}"})
    try:
        urllib.request.urlopen(req, timeout=20)
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")[:200]
        sys.exit(f"ARC endpoint check failed: HTTP {e.code}: {body}\n(403 usually means you're off the VT network: connect to the VT VPN.)")


def images() -> set[str]:
    out = subprocess.run(["docker", "image", "ls", "-q", "--no-trunc"], capture_output=True, text=True, check=True).stdout
    return set(out.split())


def check_disk(min_free_gb: float, where: Path | None = None) -> None:
    free = shutil.disk_usage(where or Path.home()).free / 2**30
    if free < min_free_gb:
        sys.exit(f"only {free:.0f} GB free (< --min-free-gb {min_free_gb:g}); free space, then rerun with --resume")


def convert_task(src: Path, dst: Path) -> None:
    """Make a Harbor SWE-rebench task runnable with Harbor's Singularity/Apptainer backend.

    That backend runs a prebuilt image (task.toml [environment] docker_image) instead of building the
    Dockerfile. The SWE-rebench Dockerfile is `FROM swerebench/...` plus uv and /logs; the adapter's
    HPC mode restores those two at install time. The backend takes the container's working dir from
    the Dockerfile's WORKDIR (default /app, an empty dir); SWE-rebench repos live in /testbed.
    """
    dockerfile = (src / "environment" / "Dockerfile").read_text()
    image = next((l.split()[1] for l in dockerfile.splitlines() if l.upper().startswith("FROM ")), None)
    if not image:
        raise ValueError(f"{src}: no FROM line in environment/Dockerfile")
    toml = (src / "task.toml").read_text()
    if "\n[environment]\n" not in toml:
        raise ValueError(f"{src}: task.toml has no [environment] table")
    if "docker_image" not in toml:
        toml = toml.replace("\n[environment]\n", f'\n[environment]\ndocker_image = "{image}"\n', 1)
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst)
    (dst / "task.toml").write_text(toml)
    (dst / "environment" / "Dockerfile").write_text(dockerfile.rstrip("\n") + "\nWORKDIR /testbed\n")


def stage_batch(batch: list[str], tasks_dir: Path, batch_dir: Path) -> None:
    """Download (once, into tasks_dir/raw) and convert this batch's tasks into batch_dir."""
    for t in batch:
        raw = tasks_dir / "raw" / t
        if not (raw / "task.toml").exists():
            subprocess.run(["harbor", "download", f"swe-rebench/{t}", "--export", "-o", str(tasks_dir / "raw")],
                           check=True, capture_output=True, text=True)
        convert_task(raw, batch_dir / t)


def finished(run_dir: Path) -> set[str]:
    done = set()
    for job in json.loads((run_dir / "jobs.json").read_text()) if (run_dir / "jobs.json").exists() else []:
        for res in (HERE / "jobs" / job).glob("*/result.json"):
            r = json.loads(res.read_text())
            # Finished = graded. Ungraded trials (Docker died, image pull failed, cancelled) are retried.
            if r.get("finished_at") and (r.get("verifier_result") or {}).get("rewards", {}).get("reward") is not None:
                done.add(r["task_name"].split("/", 1)[1])
    return done


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--split", default="2026_03", help="a split, a comma list, or `train` (all months except --holdout)")
    p.add_argument("--holdout", default="2026_02,2026_03", help="months excluded by --split train (validation/test)")
    p.add_argument("--model", required=True)
    p.add_argument("--sample", type=int, help="random sample size (default: whole split)")
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--batch", type=int, default=10, help="tasks per harbor job (images removed after each)")
    p.add_argument("--min-free-gb", type=float, default=25, help="stop before a batch if less disk is free")
    p.add_argument("--backend", choices=["docker", "singularity"], default="docker", help="singularity = Apptainer on HPC (see arc/README.md)")
    p.add_argument("--tasks-dir", type=Path, default=HERE / "arc-tasks", help="singularity: where downloaded and converted tasks go")
    p.add_argument("--sif-dir", type=Path, help="singularity: image cache, emptied after each batch (default: $TMPDIR/arcode-sif)")
    p.add_argument("--max-tasks", type=int, help="run at most this many of the remaining tasks (smoke tests)")
    p.add_argument("-n", "--concurrency", type=int, default=2)
    p.add_argument("--run", help="run name (default: <split>-<model>-s<seed>)")
    p.add_argument("--resume", action="store_true", help="skip tasks already finished in this run")
    p.add_argument("--ak", action="append", default=[], help="agent option passed to harbor (repeatable)")
    p.add_argument("--dry-run", action="store_true", help="print the plan and the first harbor command, run nothing")
    a = p.parse_args()
    docker = a.backend == "docker"
    if docker:
        # Docker Desktop's CLI lives in ~/.docker/bin, which isn't always on PATH.
        if not shutil.which("docker"):
            os.environ["PATH"] = f"{Path.home() / '.docker' / 'bin'}{os.pathsep}{os.environ['PATH']}"
        if not shutil.which("docker"):
            sys.exit("docker not found (is Docker Desktop installed and running?)")
    else:
        if not shutil.which("singularity"):
            sys.exit("singularity not found: Harbor calls `singularity` (Apptainer provides it; see arc/README.md)")
        if not os.environ.get("ARCODE_RUNTIME"):
            sys.exit("ARCODE_RUNTIME is not set: run through arc/generate.slurm, which binds the Node + arcode runtime")
        a.sif_dir = a.sif_dir or Path(os.environ.get("TMPDIR", "/tmp")) / "arcode-sif"
        a.sif_dir.mkdir(parents=True, exist_ok=True)

    run = a.run or f"rebench-{a.split.replace(',', '+')}-{a.model}-s{a.seed}"
    run_dir = HERE / "runs" / run
    run_dir.mkdir(parents=True, exist_ok=True)
    tasks_file = run_dir / "tasks.json"
    if tasks_file.exists():
        tasks = json.loads(tasks_file.read_text())
    else:
        splits = resolve_splits(a.split, a.holdout.split(","))
        tasks = [t for s in splits for t in split_ids(s)]
        if a.sample and a.sample < len(tasks):
            tasks = sorted(random.Random(a.seed).sample(tasks, a.sample))
        elif len(splits) > 1:
            random.Random(a.seed).shuffle(tasks)  # a partial run stays representative across months
        tasks_file.write_text(json.dumps(tasks, indent=1))
        (run_dir / "splits.json").write_text(json.dumps({"splits": splits, "holdout": a.holdout.split(",")}, indent=1))
    todo = [t for t in tasks if t not in finished(run_dir)] if a.resume else tasks
    if a.max_tasks is not None:
        todo = todo[: a.max_tasks]
    print(f"run {run}: {len(tasks)} tasks from {a.split}, {len(todo)} to do, batches of {a.batch}, -n {a.concurrency}")
    if a.dry_run:
        if docker:
            first = " ".join(f"-i swe-rebench/{t}" for t in todo[: a.batch])
            print(f"first batch: PYTHONPATH=. harbor run -d {DATASET} -a arcode_agent:Arcode -m {a.model} -n {a.concurrency} -o jobs {first}")
        else:
            print(f"first batch ({a.backend}): {' '.join(todo[: a.batch])}; images in {a.sif_dir}; tasks in {a.tasks_dir}")
        return

    check_arc()
    env = {**os.environ, "PYTHONPATH": str(HERE)}
    jobs_file = run_dir / "jobs.json"
    for b in range(0, len(todo), a.batch):
        batch = todo[b : b + a.batch]
        check_disk(a.min_free_gb, None if docker else a.sif_dir)
        before = images() if docker else set()
        job = time.strftime("%Y-%m-%d__%H-%M-%S")
        cmd = ["harbor", "run", "-a", "arcode_agent:Arcode", "-m", a.model, "-n", str(a.concurrency), "-o", "jobs", "--job-name", job]
        if docker:
            cmd += ["-d", DATASET]
            for t in batch:
                cmd += ["-i", f"swe-rebench/{t}"]
        else:
            batch_dir = a.tasks_dir / "batches" / job
            stage_batch(batch, a.tasks_dir, batch_dir)
            cmd += ["-p", str(batch_dir), "-e", "singularity", "--ek", f"singularity_image_cache_dir={a.sif_dir}"]
        jobs = json.loads(jobs_file.read_text()) if jobs_file.exists() else []
        jobs_file.write_text(json.dumps([*jobs, job], indent=1))
        for kv in a.ak:
            cmd += ["--ak", kv]
        print(f"\n[batch {b // a.batch + 1}/{-(-len(todo) // a.batch)}] {len(batch)} tasks -> jobs/{job}", flush=True)
        subprocess.run(cmd, cwd=HERE, env=env)
        if docker:
            added = images() - before
            if added:
                subprocess.run(["docker", "image", "rm", "-f", *added], capture_output=True)
                print(f"removed {len(added)} image(s) added by this batch", flush=True)
            subprocess.run(["docker", "builder", "prune", "-f"], capture_output=True)
        else:
            sifs = list(a.sif_dir.glob("*.sif"))
            for f in sifs:
                f.unlink(missing_ok=True)
            subprocess.run(["singularity", "cache", "clean", "-f"], capture_output=True)  # pulled layers
            if os.environ.get("ARCODE_OVERLAY_ROOT"):  # on-disk container layers (arc/env.sh, overlay mode "dir")
                for d in Path(os.environ["ARCODE_OVERLAY_ROOT"]).glob("ov.*"):
                    shutil.rmtree(d, ignore_errors=True)
            print(f"removed {len(sifs)} image(s) and the layer cache", flush=True)
        check_arc()  # stop early if the VPN dropped mid-run, instead of scoring fake zeros

    print(f"\ndone. jobs: {jobs_file.read_text()}")


if __name__ == "__main__":
    main()
