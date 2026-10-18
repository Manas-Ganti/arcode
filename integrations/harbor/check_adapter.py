"""
Check the arcode Harbor adapter without Docker: import, options, credentials,
packaging, a clean install of the tarball, result parsing, and the HPC (Apptainer)
pieces: runtime mode, task conversion, deadline from a local task, resume rules.

    $(uv tool dir)/harbor/bin/python integrations/harbor/check_adapter.py
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import arcode_agent as m  # noqa: E402
import run_rebench as rr  # noqa: E402
import tomllib  # noqa: E402
from harbor.models.agent.context import AgentContext  # noqa: E402

checks: list[tuple[str, bool]] = []
with tempfile.TemporaryDirectory() as tmp:
    logs = Path(tmp)
    a = m.Arcode(logs_dir=logs, model_name="arc/DeepSeek-V4.1-Flash", max_turns=40)
    checks.append(("constructs; strips arc/ prefix; options parsed", a.name() == "arcode" and a._model() == "DeepSeek-V4.1-Flash" and a.options.max_turns == 40))
    checks.append(("plain model ids pass through", m.Arcode(logs_dir=logs, model_name="GLM-5.3")._model() == "GLM-5.3"))
    try:
        creds = a._credentials()
        checks.append(("API key found (env or ~/.arcode/.env)", bool(creds.get("ARC_API_KEY"))))
    except ValueError as e:
        print(f"note: {e}")
        checks.append(("API key found (env or ~/.arcode/.env)", False))

    tb = m.Arcode._build_tarball()
    checks.append(("npm pack builds a tarball", tb.exists() and tb.stat().st_size > 10_000))
    prefix = logs / "npm-global"
    subprocess.run(["npm", "install", "-g", "--prefix", str(prefix), "--no-audit", "--no-fund", str(tb)], check=True, capture_output=True)
    help_out = subprocess.run([str(prefix / "bin" / "arcode"), "--help"], capture_output=True, text=True).stdout
    checks.append(("tarball installs and runs from a clean prefix", help_out.startswith("arcode - ")))

    session = logs / "arcode" / "sessions" / "s1"
    session.mkdir(parents=True)
    (session / "meta.json").write_text(json.dumps({"id": "s1", "status": "max_turns", "turns": 60, "usage": {"prompt": 1200, "completion": 300}}))
    (logs / "arcode-exit-code").write_text("1\n")
    ctx = AgentContext()
    a.populate_context_post_run(ctx)
    checks.append(("results parsed from synced session", ctx.n_input_tokens == 1200 and ctx.metadata["arcode_status"] == "max_turns" and ctx.metadata["arcode_exit_code"] == "1"))

    # ---- HPC mode (VT ARC, Apptainer): runtime bind instead of nvm, converted local tasks
    m.RUNTIME = "/opt/arcode-rt"
    checks.append(("runtime mode: node + arcode from the bound dir, no nvm", "/opt/arcode-rt/node/bin" in m._path_setup() and "nvm" not in m._path_setup()
                   and "package.json" in (a.get_version_command() or "")))
    m.RUNTIME = None
    checks.append(("default mode still uses nvm", "nvm.sh" in m._path_setup()))

    src = Path(tmp) / "raw" / "demo__repo-1"
    (src / "environment").mkdir(parents=True)
    (src / "tests").mkdir()
    (src / "environment" / "Dockerfile").write_text("FROM swerebench/sweb.eval.x86_64.demo_1776_repo-1:latest\nRUN mkdir -p /logs\n")
    (src / "task.toml").write_text('[task]\nname = "swe-rebench/demo__repo-1"\n\n[agent]\ntimeout_sec = 3000\n\n[environment]\ncpus = 1\nmemory = \'8G\'\n')
    dst = Path(tmp) / "batch" / "demo__repo-1"
    rr.convert_task(src, dst)
    conv = tomllib.loads((dst / "task.toml").read_text())
    checks.append(("convert_task: image into task.toml, workdir /testbed, rest kept",
                   conv["environment"]["docker_image"] == "swerebench/sweb.eval.x86_64.demo_1776_repo-1:latest"
                   and conv["environment"]["memory"] == "8G" and conv["task"]["name"] == "swe-rebench/demo__repo-1"
                   and (dst / "environment" / "Dockerfile").read_text().splitlines()[-1] == "WORKDIR /testbed"
                   and (dst / "tests").is_dir()))
    rr.convert_task(src, dst)  # idempotent
    checks.append(("convert_task: re-running doesn't duplicate docker_image", (dst / "task.toml").read_text().count("docker_image") == 1))

    trial = Path(tmp) / "trial"
    (trial / "agent").mkdir(parents=True)
    (trial / "config.json").write_text(json.dumps({"task": {"path": str(dst), "source": "b1"}, "agent": {}}))
    checks.append(("deadline read from a local task path", m.Arcode(logs_dir=trial / "agent", model_name="x")._task_deadline() == 2970))

    rr.HERE = Path(tmp)
    run = Path(tmp) / "run"
    run.mkdir()
    (run / "jobs.json").write_text(json.dumps(["J"]))
    for t, res in {"graded-fail": {"verifier_result": {"rewards": {"reward": 0.0}}},
                   "graded-pass": {"verifier_result": {"rewards": {"reward": 1.0}}, "exception_info": {"exception_type": "AgentTimeoutError"}},
                   "docker-died": {"verifier_result": None, "exception_info": {"exception_type": "RuntimeError"}},
                   "cancelled": {"exception_info": {"exception_type": "CancelledError"}}}.items():
        (Path(tmp) / "jobs" / "J" / t).mkdir(parents=True)
        (Path(tmp) / "jobs" / "J" / t / "result.json").write_text(json.dumps({"task_name": f"swe-rebench/{t}", "finished_at": "2026-10-17T00:00:00", **res}))
    checks.append(("resume: graded trials are done, ungraded ones are retried", rr.finished(run) == {"graded-fail", "graded-pass"}))

for name, ok in checks:
    print(f"{'PASS' if ok else 'FAIL'}  {name}")
failed = sum(not ok for _, ok in checks)
print(f"\n{failed} failed" if failed else "\nall passed")
sys.exit(1 if failed else 0)
