# arcode

A minimal, readable coding agent for any OpenAI-compatible endpoint. Built against Virginia Tech ARC's hosted models (GLM, DeepSeek), and works with anything that speaks `/v1/chat/completions`.

- **Real tools**: read, exact-string edit, write, grep, list, bash, run_tests, web search, web fetch
- **Eval harness**: `arcode eval` scores the agent on test-graded tasks with hidden tests, and writes the reward into each trajectory
- **Task memory**: a plan (`todo_write`) and notes (`note`) that survive context compaction and session resume
- **Context compaction**: older turns get summarized and recent turns stay verbatim, with tool-call pairs kept intact
- **Trajectory logging**: every model call and tool result goes to an append-only JSONL file per session, ready for evaluation or RL training data
- **Zero runtime dependencies**: Node 20+ only

## Setup

You need Node 20+ and an API key for an OpenAI-compatible endpoint. arcode is built for **Virginia Tech ARC's hosted models** (free for VT accounts), but any `/v1/chat/completions` endpoint works.

**1. Install**

```bash
git clone https://github.com/Manas-Ganti/arcode.git && cd arcode
npm install
npm run build && npm link      # optional: puts an `arcode` command on your PATH
```

**2. Get an ARC API key**

Sign in at [llm.arc.vt.edu](https://llm.arc.vt.edu) with your VT account, then open your profile > **Settings > Account > API keys** and create a key. One key works for every model ARC hosts (GLM, DeepSeek, gpt-oss, ...); you pick the model inside arcode.

**3. Put the key where arcode reads it: `~/.arcode/.env`**

```bash
mkdir -p ~/.arcode && cp .env.example ~/.arcode/.env && chmod 600 ~/.arcode/.env
# then edit ~/.arcode/.env and replace sk-your-key-here with your key
```

**4. Check it works**

```bash
npm run probe        # lists the endpoint's models and checks chat + tool calling for each
```

### How arcode finds the key

- At startup, arcode loads `~/.arcode/.env` (or `$ARCODE_HOME/.env` if you set `ARCODE_HOME`) with Node's built-in `process.loadEnvFile`, then reads `ARC_API_KEY`, falling back to `VTARC_API_KEY` (`src/config.ts`).
- Variables already set in your shell win over the file, so `export ARC_API_KEY=...` also works (handy for CI or a cluster job).
- A `.env` file **inside a repo is never read**, including this one. arcode works on other people's repos, and their `.env` belongs to them, not to arcode. It also keeps your key out of every project folder, so it can't be committed by accident (`.gitignore` covers `.env`, `.env.*` and `*.env` too).
- The key is only sent as the `Authorization: Bearer` header to `ARC_BASE_URL`. It is **not** passed to commands the agent runs (`bash`, `run_tests`, `!command`) or to MCP servers, so a model running `env` can't copy it into a trajectory.
- Using a different provider: set `ARC_BASE_URL` (e.g. a local vLLM server at `http://localhost:8000/v1`) and put that provider's key in `ARC_API_KEY`.

**If it doesn't work:** `ARC_API_KEY is not set` means the file isn't at `~/.arcode/.env` or the variable name is wrong. A `401` from `npm run probe` means the key is invalid or revoked; make a new one on llm.arc.vt.edu.

## Quick start

```bash
arcode                                        # interactive, in the current directory (or: npm run dev)
arcode -p "add a --verbose flag to cli.ts" --yes   # headless
```

Optional web search for the agent: add one of `BRAVE_API_KEY`, `TAVILY_API_KEY` or `SEARXNG_URL` to `~/.arcode/.env`.

## Usage

```
arcode                         interactive session
arcode -p "task" [--yes]       one task, headless
arcode --continue              resume latest session for this directory
arcode --resume <id>           resume a specific session
arcode --sessions | --models
-m <model>  --show-reasoning  --max-turns <n>
```

Replies stream token by token and their markdown (bold, code, headings, lists, code blocks) is styled in the terminal; piped output stays raw markdown.

While the model works, a spinner shows elapsed time and how much hidden reasoning has streamed, and says so when no tokens are arriving or a request is being retried. At an approval prompt, `a` auto-approves edits and commands for the rest of the session, including the task already running.

REPL commands: `/plan`, `/notes`, `/compact`, `/model`, `/session`, and `exit` (or `/exit`, Ctrl+D) to quit. With no model configured, interactive mode opens a model picker (↑/↓ to move, Enter to select, Esc keeps the default). Press **Ctrl+O** (or type `/model`) to reopen it mid-session; pressed while the agent is working, it opens when the current task finishes. `/model 3` or `/model DeepSeek-V4.1-Flash` switches directly. Option+M also works in terminals that pass it through. (Cmd+M and Shift+M can't be used: the terminal keeps Cmd shortcuts, and Shift+M is just a capital M.) One key covers every model, and the compaction model and context budget follow the switch.

### Shell commands and custom commands

- `!<command>` runs a shell command directly (no model, no approval prompt), e.g. `!git status` or `!pytest -x`. Its output is shown and also sent to the model with your next message.
- `/<name> [args]` runs a saved prompt from a markdown file: `.arcode/commands/<name>.md` in the project, or `~/.arcode/commands/<name>.md` for every project (the project file wins on a name clash; built-in commands can't be overridden). `$ARGUMENTS` in the file is replaced by what you type after the name; if the file doesn't use it, the arguments are appended. `/commands` lists them. Also works headless: `arcode -p "/review src/llm.ts"`.

```markdown
<!-- ~/.arcode/commands/review.md -->
---
description: Review a file for bugs without editing it
---
Review $ARGUMENTS for bugs. Run the tests first. Report findings as a list; don't edit files.
```

### MCP servers

arcode can use tools from [MCP](https://modelcontextprotocol.io) servers (local stdio servers for now). List them in `~/.arcode/mcp.json`, in the same format Claude Code and Claude Desktop use:

```json
{
  "mcpServers": {
    "callcentre": { "command": "uv", "args": ["run", "/path/to/server.py"] },
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "..." } }
  }
}
```

Servers start with arcode and their tools appear as `mcp__<server>__<tool>`; `/mcp` lists them. A server that fails to start is reported and skipped. Calls go through the approval prompt unless the server marks a tool read-only. The config is read only from your home folder, never from a repo, because each entry is a command arcode runs. arcode's own API keys aren't passed to servers; give a server the variables it needs in its `env`. Evals (`arcode eval`) never load MCP tools, so results don't depend on what's installed.

Project instructions: put an `ARCODE.md` (or `AGENTS.md` / `CLAUDE.md`) at the repo root, and it's added to the system prompt.

## Configuration

| Env | Default |
|---|---|
| `ARC_BASE_URL` | `https://llm-api.arc.vt.edu/api/v1` |
| `ARC_API_KEY` | (required; `VTARC_API_KEY` also accepted) |
| `ARCODE_MODEL` | first GLM model listed, then DeepSeek |
| `ARCODE_SUMMARY_MODEL` | same as model |
| `ARCODE_CONTEXT_BUDGET` | 75% of the model's context window (`src/models.ts`), in estimated tokens before compaction |
| `ARCODE_MAX_OUTPUT_TOKENS` | `16384`. Output cap per model call, reasoning included; a cut-off response is discarded and the agent is told to act in smaller steps |
| `ARCODE_CALL_TIMEOUT_S` | `300`. Time limit per model call; the run continues with a notice |
| `ARCODE_DEADLINE_S` | none. Optional time budget for a task; the agent is told when 30% and 10% remain (the Harbor adapter sets it from each task's timeout) |
| `ARCODE_REQUEST_TIMEOUT_S` | `180`. A model request with no data for this long is aborted and retried (up to 6 attempts) |
| `ARCODE_STREAM` | `1`. Agent turns stream token by token; `0` waits for whole replies |
| `ARCODE_TEST_CMD` | auto-detected (npm test, pytest, go test, cargo test). Command used by `run_tests` |
| `ARCODE_TEMPERATURE` | `0.2`. Logged in every `llm_call` event |
| `ARCODE_EXTRA_BODY` | none. JSON merged into every request, e.g. `{"reasoning_effort":"high"}` or `{"chat_template_kwargs":{"enable_thinking":false}}` |
| `ARCODE_MAX_TURNS` | `60` |
| `ARCODE_HOME` | `~/.arcode` |

Any of these can go in `$ARCODE_HOME/.env` instead of your shell profile; real environment variables win. The `.env` in the repo you're working on is never read.

### Models on VT ARC

Pick thinking effort with the model id (`gpt-oss-120b-thinking-high`, `DeepSeek-V4.1-Flash-thinking-max`, …); the gateway applies it. Measured 2026-10-13: the gpt-oss variants change reasoning length about 8x; the DeepSeek and GLM variants showed no clear difference on a single sample. The non-streaming proxy caps `max_tokens` at 8000.

## Evaluation

```bash
arcode eval --check-tasks                                    # validate tasks: baseline fails, solution passes
arcode eval --models GLM-5.3,DeepSeek-V4.1-Flash --samples 3 --concurrency 4   # results in evals/results/<run>/
```

The task set (`evals/tasks/`, sources in [NOTICE.md](evals/tasks/NOTICE.md)): 34 Python exercises from Aider's polyglot benchmark (`poly-*`, public and possibly memorized), 8 hand-written multi-file tasks (`m2-*`, new), and 5 small smoke tasks. The summary reports resolve rates per group. `--run-timeout` caps each run's wall-clock time (default 900 s).

Each task in `evals/tasks/<id>/` has `task.json`, `repo/` (all the agent sees), `hidden/` (grading tests, overlaid after the agent stops) and `solution/` (reference fix, used only by `--check-tasks`). Before grading, test files and test config are restored to the original, so editing tests can't buy a pass; such edits are flagged as `touched_protected`. Web tools are withheld during evals. Every run appends an `eval_result` event (with `reward`) to its trajectory, and `results.jsonl` gets one row per run. Re-using `--run <id>` resumes.

Evals run the agent with auto-approved `bash`, unsandboxed. Only run tasks you trust until the container runner lands.

## Results

Current measured results, with commits and caveats, are in [docs/RESULTS.md](docs/RESULTS.md). Headline: **arcode + DeepSeek-V4.1-Flash resolves 44/50 (88%, 95% CI 76–94%) on a seeded 50-task sample of SWE-rebench's March 2026 issues.**

## Benchmarks (Harbor)

`integrations/harbor/` runs arcode on containerized benchmarks such as Terminal-Bench 2.0 and SWE-rebench through [Harbor](https://github.com/harbor-framework/harbor). It installs your local build into each task container and brings arcode's trajectories back with the results. See [integrations/harbor/README.md](integrations/harbor/README.md).

## Training data (`arcode export`)

```bash
arcode export integrations/harbor/jobs evals/results -o sft.jsonl \
  --exclude integrations/harbor/runs/rebench-2026_03-DeepSeek-V4.1-Flash-s0/tasks.json \
  --max-tool-chars 8000
```

Turns sessions into chat-format fine-tuning data: one JSON object per line with `messages` (OpenAI format, tool calls included, no reasoning), `tools` and `meta` (task, reward, model, turns). Rewards come from Harbor's `result.json` or from `arcode eval`'s `eval_result` event; infrastructure-interrupted runs and compacted sessions are skipped. **Always `--exclude` held-out test tasks.** `--min-reward 0` keeps failures too (e.g. for preference data). Use the same `--max-tool-chars` cap when evaluating a model trained on the output.

Generating training trajectories on SWE-rebench months that don't overlap the test sample: `python3 integrations/harbor/run_rebench.py --split train --model DeepSeek-V4.1-Flash --batch 10 -n 2` (all monthly splits except `--holdout 2026_02,2026_03`, seeded shuffle, resumable).

## Tests

```bash
npm run typecheck
npm run test:mock      # offline e2e against a scripted fake endpoint
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and roadmap.

## License

MIT
