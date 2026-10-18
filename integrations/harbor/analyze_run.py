"""
Summarize a run_rebench.py run: resolve rate with a 95% Wilson interval, how runs ended, turns,
tokens, time, and how often arcode's guards fired. Uses the newest result per task, so a re-run
supersedes an earlier attempt.

    python3 analyze_run.py runs/<run>            # prints a report
    python3 analyze_run.py runs/<run> --json     # also writes runs/<run>/summary.json
"""

import collections
import json
import math
import statistics
import sys
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent

# Trials stopped by the infrastructure, not the agent: no result, rather than a 0.
# (AgentTimeoutError is the task's own time limit, so it stays a genuine failure: the verifier
# still grades it.) A trial the verifier never graded (Docker died, container never started)
# is no result either, whatever the exception is called.
INVALID = ("CancelledError", "Environment")


def graded(r: dict) -> bool:
    return (r.get("verifier_result") or {}).get("rewards", {}).get("reward") is not None


def invalid(r: dict) -> bool:
    exc = (r.get("exception_info") or {}).get("exception_type") or ""
    return exc.startswith(INVALID) or not graded(r)


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    centre = (p + z * z / (2 * n)) / (1 + z * z / n)
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return (centre - half, centre + half)


def main() -> None:
    run_dir = Path(sys.argv[1]).resolve()
    tasks = json.loads((run_dir / "tasks.json").read_text())
    latest: dict[str, tuple[str, Path, dict]] = {}
    for job in json.loads((run_dir / "jobs.json").read_text()):
        for res in (HERE / "jobs" / job).glob("*/result.json"):
            r = json.loads(res.read_text())
            if "task_name" not in r or not r.get("finished_at") or invalid(r):
                continue
            task = r["task_name"].split("/", 1)[1]
            if task not in latest or r["finished_at"] > latest[task][0]:
                latest[task] = (r["finished_at"], res.parent, r)

    rows = []
    for task in tasks:
        if task not in latest:
            rows.append({"task": task, "missing": True})
            continue
        _, trial, r = latest[task]
        meta = (r.get("agent_result") or {}).get("metadata") or {}
        agent = r.get("agent_execution") or {}
        secs = None
        if agent.get("started_at") and agent.get("finished_at"):
            secs = (datetime.fromisoformat(agent["finished_at"].replace("Z", "+00:00")) - datetime.fromisoformat(agent["started_at"].replace("Z", "+00:00"))).total_seconds()
        notices = collections.Counter()
        for traj in trial.glob("agent/arcode/sessions/*/trajectory.jsonl"):
            for line in traj.read_text().splitlines():
                try:
                    e = json.loads(line)
                except json.JSONDecodeError:
                    continue  # a run killed mid-write leaves a partial last line
                if e.get("type") == "notice":
                    notices[e["kind"]] += 1
        rows.append({
            "task": task,
            "resolved": (r.get("verifier_result") or {}).get("rewards", {}).get("reward") == 1.0,
            "status": meta.get("arcode_status"),
            "turns": meta.get("arcode_turns"),
            "input_tokens": (r.get("agent_result") or {}).get("n_input_tokens"),
            "output_tokens": (r.get("agent_result") or {}).get("n_output_tokens"),
            "agent_seconds": secs,
            "exception": (r.get("exception_info") or {}).get("exception_type"),
            "notices": dict(notices),
        })

    done = [x for x in rows if not x.get("missing")]
    k, n = sum(x["resolved"] for x in done), len(done)
    lo, hi = wilson(k, n)
    med = lambda key: statistics.median([x[key] for x in done if x.get(key) is not None])  # noqa: E731
    by_status = collections.Counter((x["status"], x["resolved"]) for x in done)
    fired = collections.Counter()
    tasks_with = collections.Counter()
    for x in done:
        for kind, c in x["notices"].items():
            fired[kind] += c
            tasks_with[kind] += 1

    print(f"run: {run_dir.name}")
    print(f"resolved: {k}/{n} = {k / n:.1%}  (95% Wilson CI {lo:.1%} - {hi:.1%})" + (f"   [{len(rows) - n} task(s) without a result]" if len(rows) > n else ""))
    print(f"median turns {med('turns')}, median agent time {med('agent_seconds') / 60:.1f} min, median tokens in/out {med('input_tokens'):,.0f} / {med('output_tokens'):,.0f}")
    print("how runs ended (arcode status, resolved):")
    for (status, res), c in sorted(by_status.items(), key=lambda kv: (-kv[1], str(kv[0]))):
        print(f"  {str(status):10} {'resolved' if res else 'failed':8} {c}")
    print("guards fired (notices, tasks):", {kind: (fired[kind], tasks_with[kind]) for kind in sorted(fired)} or "none")
    print("failures:")
    for x in done:
        if not x["resolved"]:
            print(f"  {x['task']:46} {x['status']!s:10} turns={x['turns']} notices={x['notices'] or '-'}" + (f" exc={x['exception']}" if x["exception"] else ""))
    if "--json" in sys.argv:
        (run_dir / "summary.json").write_text(json.dumps({"resolved": k, "n": n, "ci95": [lo, hi], "rows": rows}, indent=1))
        print(f"\nwrote {run_dir / 'summary.json'}")


if __name__ == "__main__":
    main()
