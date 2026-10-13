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

REPL commands: `/plan`, `/notes`, `/compact`, `/model`, `/session`, `/exit`. With no model configured, interactive mode opens a numbered model picker (Enter takes the default GLM). `/model` reopens it mid-session; `/model 3` or `/model DeepSeek-V4.1-Flash` switches directly. One key covers every model, and the compaction model and context budget follow the switch.

Project instructions: put an `ARCODE.md` (or `AGENTS.md` / `CLAUDE.md`) at the repo root, and it's added to the system prompt.

## Configuration

| Env | Default |
|---|---|
| `ARC_BASE_URL` | `https://llm-api.arc.vt.edu/api/v1` |
| `ARC_API_KEY` | (required; `VTARC_API_KEY` also accepted) |
| `ARCODE_MODEL` | first GLM model listed, then DeepSeek |
| `ARCODE_SUMMARY_MODEL` | same as model |
| `ARCODE_CONTEXT_BUDGET` | 75% of the model's context window (`src/models.ts`), in estimated tokens before compaction |
| `ARCODE_EXTRA_BODY` | none. JSON merged into every request, e.g. `{"reasoning_effort":"high"}` or `{"chat_template_kwargs":{"enable_thinking":false}}` |
| `ARCODE_MAX_TURNS` | `60` |
| `ARCODE_HOME` | `~/.arcode` |

Any of these can go in `$ARCODE_HOME/.env` instead of your shell profile; real environment variables win. The `.env` in the repo you're working on is never read.

### Models on VT ARC

Pick thinking effort with the model id (`gpt-oss-120b-thinking-high`, `DeepSeek-V4.1-Flash-thinking-max`, …); the gateway applies it. Measured 2026-10-13: the gpt-oss variants change reasoning length about 8x; the DeepSeek and GLM variants showed no clear difference on a single sample. The non-streaming proxy caps `max_tokens` at 8000.

## Tests

```bash
npm run typecheck
npm run test:mock      # offline e2e against a scripted fake endpoint
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and roadmap.

## License

MIT
