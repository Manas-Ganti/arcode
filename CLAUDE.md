# CLAUDE.md: arcode

Guidance for coding agents working on this repository.

## What this is

arcode is a minimal coding-agent harness in TypeScript for OpenAI-compatible endpoints, primarily VT ARC's hosted GLM and DeepSeek models. It has two goals of equal weight:
1. A coding agent good enough for daily use.
2. A research harness: every run produces trajectories usable for evaluation and RL post-training.

Read `docs/ARCHITECTURE.md` before structural changes.

## Ground rules

- **Zero runtime dependencies.** Node built-ins and `fetch` only. Dev dependencies are fine. Adding a runtime dependency needs a clear reason in the commit message.
- **Keep the loop readable.** `src/agent.ts` should stay small enough to read in one sitting. New behavior goes into tools, `context.ts`, or `session.ts`, not into the loop.
- **Tools return strings and never throw to the model.** Return `error: …` with a hint on how to recover.
- **Never break the trajectory format** (`trajectory.jsonl` event shapes). Add fields; don't rename or remove them. Downstream eval/RL tooling depends on them.
- **Don't send `reasoning_content` back to the API.** Log it only.
- **Compaction must keep assistant tool calls paired with their tool results.**
- File tools stay confined to the workspace root.

## Commands

```bash
npm run typecheck      # must pass
npm run test:mock      # offline e2e; must pass. Extend it when adding tools or loop behavior.
npm run probe          # live check against ARC (needs ARC_API_KEY)
npm run dev            # run the CLI from source
```

Before finishing any change: run `typecheck` and `test:mock`, and add a mock-e2e check for new behavior.

## Conventions

- ESM with `NodeNext` resolution: relative imports end in `.js`.
- Strict TypeScript. Avoid `any` outside JSON-boundary code (`llm.ts`, `web.ts`).
- Config comes from env in `config.ts`; no config files yet.

## Shared agent knowledge base (call centre MCP)

Manas's machine runs a centralised "call centre" MCP server where agents record solved problems and open issues, so nobody solves the same thing twice. The tools are:

- `mcp__callcentre__search`: search solved and open issues. **Use first** when you hit an error, an environment or build problem, a VT ARC / cluster job failure, an endpoint quirk (e.g. a model's tool-call format), or an RL / post-training evaluation issue.
- `mcp__callcentre__get`: fetch the full record for a search hit.
- `mcp__callcentre__submit`: record a problem you solved (symptom, root cause, fix, how you verified it).
- `mcp__callcentre__report_outcome`: after applying a fix you found there, report whether it worked.
- `mcp__callcentre__open_issue`: log a problem you could not solve, with what you tried, so another agent can pick it up.
- `mcp__callcentre__claim_issue`: claim an open issue before working on it, to avoid duplicate effort.
- `mcp__callcentre__log_attempt`: record an attempt on an issue, including failed ones.
- `mcp__callcentre__resolve_issue`: close an issue with the working fix.

Workflow: **search before debugging**, **submit after solving** anything non-obvious, and **open an issue** rather than silently giving up. Cluster SLURM logs are curated by Manas; work from the excerpts he provides rather than asking for full logs. Endpoint quirks found with `npm run probe` (which models emit text-only tool calls, reasoning field names, context limits) are good call-centre entries.
