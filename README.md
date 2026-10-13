# arcode

A minimal, readable coding agent for any OpenAI-compatible endpoint. Built against Virginia Tech ARC's hosted models (GLM, DeepSeek), and works with anything that speaks `/v1/chat/completions`.

- **Real tools**: read, exact-string edit, write, grep, list, bash, run_tests, web search, web fetch
- **Eval harness**: `arcode eval` scores the agent on test-graded tasks with hidden tests, and writes the reward into each trajectory
- **Task memory**: a plan (`todo_write`) and notes (`note`) that survive context compaction and session resume
- **Context compaction**: older turns get summarized and recent turns stay verbatim, with tool-call pairs kept intact
- **Trajectory logging**: every model call and tool result goes to an append-only JSONL file per session, ready for evaluation or RL training data
- **Zero runtime dependencies**: Node 20+ only

## Quick start

```bash
npm install
mkdir -p ~/.arcode && (umask 077; echo 'ARC_API_KEY=sk-...' > ~/.arcode/.env)   # llm.arc.vt.edu > Settings > Account > API keys
npm run probe                        # check tool calling works for each model
npm run dev                          # interactive, in the current directory
npm run dev -- -p "add a --verbose flag to cli.ts" --yes   # headless
```

Optional web search (pick one):

```bash
export BRAVE_API_KEY=...      # or
export TAVILY_API_KEY=...     # or
export SEARXNG_URL=http://localhost:8080
```

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

REPL commands: `/plan`, `/notes`, `/compact`, `/model`, `/session`, and `exit` (or `/exit`, Ctrl+D) to quit. With no model configured, interactive mode opens a numbered model picker (Enter takes the default GLM). `/model` reopens it mid-session; `/model 3` or `/model DeepSeek-V4.1-Flash` switches directly. One key covers every model, and the compaction model and context budget follow the switch.

Project instructions: put an `ARCODE.md` (or `AGENTS.md` / `CLAUDE.md`) at the repo root, and it's added to the system prompt.

## Configuration

| Env | Default |
|---|---|
| `ARC_BASE_URL` | `https://llm-api.arc.vt.edu/api/v1` |
| `ARC_API_KEY` | (required; `VTARC_API_KEY` also accepted) |
| `ARCODE_MODEL` | first GLM model listed, then DeepSeek |
| `ARCODE_SUMMARY_MODEL` | same as model |
| `ARCODE_CONTEXT_BUDGET` | 75% of the model's context window (`src/models.ts`), in estimated tokens before compaction |
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

## Tests

```bash
npm run typecheck
npm run test:mock      # offline e2e against a scripted fake endpoint
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and roadmap.

## License

MIT
