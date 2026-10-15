"""
Check the arcode Harbor adapter without Docker: import, options, credentials,
packaging, a clean install of the tarball, and result parsing.

    $(uv tool dir)/harbor/bin/python integrations/harbor/check_adapter.py
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import arcode_agent as m  # noqa: E402
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

for name, ok in checks:
    print(f"{'PASS' if ok else 'FAIL'}  {name}")
failed = sum(not ok for _, ok in checks)
print(f"\n{failed} failed" if failed else "\nall passed")
sys.exit(1 if failed else 0)
