"""
Harbor adapter for arcode: runs arcode headless inside a benchmark task container
(Terminal-Bench 2.0, SWE-rebench, ... any Harbor dataset).

    cd integrations/harbor
    PYTHONPATH=. harbor run -d terminal-bench/terminal-bench-2 \\
        -a arcode_agent:Arcode -m DeepSeek-V4.1-Flash

How it works:
- install(): installs Node (Harbor's nvm helper), then a tarball of *your local
  arcode checkout* (`npm run build && npm pack`), so you benchmark exactly the
  code you have, uncommitted changes included. arcode has no runtime
  dependencies, so nothing else is downloaded.
- run(): `arcode -p <instruction> --yes -m <model>` in the task's working dir.
  The ARC key goes in as an environment variable (Harbor redacts *_API_KEY values
  in its logs); arcode itself never passes it to the commands it runs.
- ARCODE_HOME=/logs/agent/arcode, which Harbor syncs back to the trial dir, so
  arcode's full trajectory.jsonl comes home with every result.
- arcode's exit code (non-zero on max_turns/error) is recorded but doesn't fail the
  trial: the task's own tests decide pass/fail.

API key: ARC_API_KEY (or VTARC_API_KEY) from the environment Harbor runs in, else
from ~/.arcode/.env, the same place arcode reads it. Set ARC_BASE_URL to use
another OpenAI-compatible endpoint.
"""

from __future__ import annotations

import json
import os
import tomllib
import shlex
import subprocess
import tempfile
from pathlib import Path
from typing import Any, override

from pydantic import Field

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.agents.installed.node_install import DEFAULT_NODE_MAJOR, nvm_node_install_snippet
from harbor.agents.options import InstalledAgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

ARCODE_ROOT = Path(__file__).resolve().parents[2]
REMOTE_TARBALL = "/installed-agent/arcode.tgz"
REMOTE_HOME = "/logs/agent/arcode"  # under /logs/agent, which Harbor syncs to the host
NVM = 'export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"'


class ArcodeOptions(InstalledAgentOptions):
    max_turns: int = Field(default=60, description="arcode --max-turns (ARCODE_MAX_TURNS).")
    deadline_s: float | None = Field(default=None, description="Time budget told to arcode (ARCODE_DEADLINE_S). Default: the task's agent timeout minus 30 s.")
    max_output_tokens: int | None = Field(default=None, description="Output cap per model call (ARCODE_MAX_OUTPUT_TOKENS; arcode default 16384).")
    call_timeout_s: int | None = Field(default=None, description="Time limit per model call (ARCODE_CALL_TIMEOUT_S; arcode default 300).")
    temperature: float | None = Field(default=None, description="ARCODE_TEMPERATURE (arcode default 0.2).")
    show_reasoning: bool = Field(default=False, description="Also print reasoning text to arcode.txt.")


def _read_env_file(path: Path) -> dict[str, str]:
    """Minimal KEY=VALUE parser for ~/.arcode/.env (comments and blank lines ignored)."""
    out: dict[str, str] = {}
    if not path.is_file():
        return out
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        out[key.strip()] = value.strip().strip("'\"")
    return out


class Arcode(BaseInstalledAgent):
    """arcode (github.com/Manas-Ganti/arcode), installed from the local checkout."""

    options_model = ArcodeOptions
    options: ArcodeOptions
    _tarball: Path | None = None  # built once per process, shared by all trials

    @staticmethod
    @override
    def name() -> str:
        return "arcode"

    @override
    def get_version_command(self) -> str | None:
        return f"{NVM}; npm ls -g arcode --depth=0 | grep -o 'arcode@[0-9.]*'"

    # ---------------------------------------------------------------- install

    @classmethod
    def _build_tarball(cls) -> Path:
        if cls._tarball and cls._tarball.exists():
            return cls._tarball
        subprocess.run(["npm", "run", "build"], cwd=ARCODE_ROOT, check=True, capture_output=True)
        out_dir = Path(tempfile.mkdtemp(prefix="arcode-pack-"))
        res = subprocess.run(
            ["npm", "pack", "--json", "--pack-destination", str(out_dir)],
            cwd=ARCODE_ROOT, check=True, capture_output=True, text=True,
        )
        cls._tarball = out_dir / json.loads(res.stdout)[0]["filename"]
        return cls._tarball

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await self.ensure_system_dependencies(environment, ("curl",))
        await self.exec_as_agent(environment, command=f"set -euo pipefail; {nvm_node_install_snippet(DEFAULT_NODE_MAJOR)}")
        await environment.upload_file(self._build_tarball(), REMOTE_TARBALL)
        await self.exec_as_root(environment, command=f"chmod a+r {REMOTE_TARBALL}")
        await self.exec_as_agent(
            environment,
            command=f"{NVM}; npm install -g --no-audit --no-fund {REMOTE_TARBALL} && arcode --help > /dev/null",
        )

    # ---------------------------------------------------------------- run

    def _credentials(self) -> dict[str, str]:
        home = Path(os.environ.get("ARCODE_HOME", Path.home() / ".arcode"))
        file_env = _read_env_file(home / ".env")
        get = lambda k: self._extra_env.get(k) or os.environ.get(k) or file_env.get(k)  # noqa: E731
        key = get("ARC_API_KEY") or get("VTARC_API_KEY")
        if not key:
            raise ValueError("No ARC API key: set ARC_API_KEY or put it in ~/.arcode/.env (see the arcode README).")
        env = {"ARC_API_KEY": key}
        if base := get("ARC_BASE_URL"):
            env["ARC_BASE_URL"] = base
        return env

    def _task_deadline(self) -> float | None:
        """The task's agent timeout (from Harbor's task cache), minus a margin, so arcode can pace itself.

        Harbor applies the timeout outside the agent and doesn't pass it in, so read it the way Harbor
        does: the trial's config.json names the task and its content hash, and the cached task.toml
        holds [agent] timeout_sec. Best effort: returns None if anything is missing.
        """
        try:
            trial = json.loads((self.logs_dir.parent / "config.json").read_text())
            name, ref = trial["task"]["name"], trial["task"]["ref"].removeprefix("sha256:")
            toml_path = Path.home() / ".cache" / "harbor" / "tasks" / "packages" / name / ref / "task.toml"
            timeout = tomllib.loads(toml_path.read_text())["agent"]["timeout_sec"]
            agent_cfg = trial.get("agent") or {}
            timeout = agent_cfg.get("override_timeout_sec") or timeout
            timeout *= trial.get("agent_timeout_multiplier") or 1
            return max(60.0, float(timeout) - 30)
        except (OSError, KeyError, TypeError, ValueError):
            return None

    def _model(self) -> str:
        if not self.model_name:
            raise ValueError("Pass a model with -m, e.g. -m DeepSeek-V4.1-Flash")
        # Accept "arc/<model>" or "openai/<model>" too; ARC model ids contain no slash.
        provider, _, rest = self.model_name.partition("/")
        return rest if rest and provider in {"arc", "vtarc", "openai"} else self.model_name

    @override
    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        env = {
            **self._credentials(),
            "ARCODE_HOME": REMOTE_HOME,
            "ARCODE_MAX_TURNS": str(self.options.max_turns),
        }
        if self.options.temperature is not None:
            env["ARCODE_TEMPERATURE"] = str(self.options.temperature)
        deadline = self.options.deadline_s or self._task_deadline()
        if deadline:
            env["ARCODE_DEADLINE_S"] = str(int(deadline))
        if self.options.max_output_tokens:
            env["ARCODE_MAX_OUTPUT_TOKENS"] = str(self.options.max_output_tokens)
        if self.options.call_timeout_s:
            env["ARCODE_CALL_TIMEOUT_S"] = str(self.options.call_timeout_s)
        flags = "--show-reasoning " if self.options.show_reasoning else ""
        await self.exec_as_agent(
            environment,
            command=(
                f"{NVM}; mkdir -p {REMOTE_HOME}; "
                f"arcode -p {shlex.quote(instruction)} --yes {flags}-m {shlex.quote(self._model())} "
                f"2>&1 | tee /logs/agent/arcode.txt; "
                f"echo ${{PIPESTATUS[0]}} > /logs/agent/arcode-exit-code; exit 0"
            ),
            env=env,
        )

    # ---------------------------------------------------------------- results

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        sessions = sorted((self.logs_dir / "arcode" / "sessions").glob("*/meta.json"))
        if not sessions:
            return
        meta = json.loads(sessions[-1].read_text())
        context.n_input_tokens = meta.get("usage", {}).get("prompt")
        context.n_output_tokens = meta.get("usage", {}).get("completion")
        exit_file = self.logs_dir / "arcode-exit-code"
        context.metadata = {
            **(context.metadata or {}),
            "arcode_status": meta.get("status"),
            "arcode_turns": meta.get("turns"),
            "arcode_session": meta.get("id"),
            "arcode_exit_code": exit_file.read_text().strip() if exit_file.exists() else None,
            "arcode_trajectory": str(sessions[-1].parent / "trajectory.jsonl"),
        }
