# arcode

A minimal, readable coding agent for any OpenAI-compatible endpoint. Built against Virginia Tech ARC's hosted models (GLM, DeepSeek), and works with anything that speaks `/v1/chat/completions`.

- **Real tools**: read, exact-string edit, write, grep, list, bash, web search, web fetch
- **Task memory**: a plan (`todo_write`) and notes (`note`) that survive context compaction and session resume
- **Context compaction**: older turns get summarized and recent turns stay verbatim, with tool-call pairs kept intact
- **Trajectory logging**: every model call and tool result goes to an append-only JSONL file per session, ready for evaluation or RL training data
- **Zero runtime dependencies**: Node 20+ only

## Quick start

```bash
npm install
export ARC_API_KEY=sk-...            # llm.arc.vt.edu > Settings > Account > API keys
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

REPL commands: `/plan`, `/notes`, `/compact`, `/model <id>`, `/session`, `/exit`.

Project instructions: put an `ARCODE.md` (or `AGENTS.md` / `CLAUDE.md`) at the repo root, and it's added to the system prompt.

## Configuration

| Env | Default |
|---|---|
| `ARC_BASE_URL` | `https://llm-api.arc.vt.edu/api/v1` |
| `ARC_API_KEY` | (required) |
| `ARCODE_MODEL` | first GLM model listed, then DeepSeek |
| `ARCODE_SUMMARY_MODEL` | same as model |
| `ARCODE_CONTEXT_BUDGET` | `100000` (estimated tokens before compaction) |
| `ARCODE_MAX_TURNS` | `60` |
| `ARCODE_HOME` | `~/.arcode` |

## Tests

```bash
npm run typecheck
npm run test:mock      # offline e2e against a scripted fake endpoint
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and roadmap.

## License

MIT
