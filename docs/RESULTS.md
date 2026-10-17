# Results

Every number here is recomputed from files in this repo. Each result names the arcode commit it ran on and its caveats. Results measure **arcode + model**: they are not model-only scores, and they are not comparable to leaderboard entries that used a different harness, model or task subset.

All runs: VT ARC hosted models, temperature 0.2, 1 attempt per task.

## SWE-rebench (March 2026 issues): 44/50

| | |
|---|---|
| **Result** | **arcode + DeepSeek-V4.1-Flash resolves 44/50 = 88% (95% Wilson CI 76–94%)** |
| Benchmark | [SWE-rebench](https://arxiv.org/abs/2505.20411) split `2026_03` (110 real GitHub issues, Mar–May 2026, 74 Python repos), via [Harbor](https://github.com/harbor-framework/harbor) |
| Tasks | Seeded random sample of 50 (`run_rebench.py --sample 50 --seed 0`), list in `tasks.json` |
| Grading | Hidden tests: the issue's FAIL_TO_PASS tests must now pass and its PASS_TO_PASS tests must still pass |
| Grader check | Harbor's `nop` (do-nothing) agent scores 0 on resolved tasks (`moto-9903`, `conan-19735`) |
| Harness | Batch 1 on `43fcd55`; batches 2–5 and the `copier-2646` re-run on `b411aa8` |
| Date | 2026-10-16 |
| Records | [`integrations/harbor/runs/rebench-2026_03-DeepSeek-V4.1-Flash-s0/`](../integrations/harbor/runs/rebench-2026_03-DeepSeek-V4.1-Flash-s0/) (`summary.json` has per-task rows) |

How runs ended: 32 finished and resolved, 12 hit the 60-turn cap after the fix was already in (resolved), 4 finished but wrong, 2 hit the cap unresolved. Median per task: 50 turns, 7.5 min, 1.47M input / 18.6k output tokens.

Notes:
- `copier-2646` first failed without running, because its issue text starts with a path (`/tmp/...`) and arcode read it as a `/command`. Fixed in `b411aa8` and re-run (resolved); only the re-run counts.
- `rapid-mlx-228` failed because of an endpoint artifact: the model's reasoning mentioned `</think>`, ARC's reasoning parser split there, and the mid-thought remainder came back as the final answer. It is counted as a failure.
- **Contamination**: the issues are from March–May 2026, so a model trained later may have seen some fixes. SWE-rebench's freshness guarantee holds only for models older than the split.

## Terminal-Bench 2.0 (pilot): 7/10

| | |
|---|---|
| **Result** | **arcode + DeepSeek-V4.1-Flash: 7/10 valid attempts (95% CI 40–89%)** |
| Benchmark | [Terminal-Bench 2.0](https://www.tbench.ai) (89 tasks), via Harbor |
| Tasks | **Hand-picked pilot** of 11: 4 easy, 5 medium and 2 hard, skipping the heaviest builds. This is not representative: the full set is about 4% easy and a third hard. **Not a Terminal-Bench score.** |
| Harness | `e68953a` (before the guards) |
| Date | 2026-10-15 |
| Records | [`integrations/harbor/runs/terminal-bench-2-pilot-DeepSeek-V4.1-Flash/`](../integrations/harbor/runs/terminal-bench-2-pilot-DeepSeek-V4.1-Flash/) |

Resolved: `fix-git`, `overfull-hbox`, `prove-plus-comm`, `build-pmars`, `crack-7z-hash`, `cancel-async-tasks` (hard), `fix-code-vulnerability` (hard). Failed, all on the task time limit: `cobol-modernization`, `chess-best-move` (the board is an image arcode can't see, and one call streamed for 9.5 of its 15 minutes), `count-dataset-tokens`. No result: `adaptive-rejection-sampler` (cut off when the run was stopped; the re-run hit ARC's off-VPN 403).

These failures motivated the guards (`src/guards.ts`, from `43fcd55`): output cap, per-call timeout and deadline notices. The pilot ran before them, so their effect on Terminal-Bench is unmeasured.

## In-house eval (`arcode eval`)

| Run | Tasks | GLM-5.3 | DeepSeek-V4.1-Flash | gpt-oss-120b | Harness |
|---|---|---|---|---|---|
| M2 baseline | 42 (34 polyglot + 8 hand-written) | 40/42 | **42/42** | 38/42 | `a00483b` |
| ↳ hand-written only | 8 | 7/8 | 8/8 | 6/8 | |
| M1 smoke | 5 | 5/5 | 5/5 | 5/5 | `8d89687` (dirty) |

No pairwise difference in M2 is significant (exact McNemar p ≥ 0.125). The set is near-saturated, and the polyglot exercises are public, so likely memorized. DeepSeek was fastest (median 26 s per task, against 95 s for GLM) and used the fewest tokens per run (22k, against 45k for GLM and 74k for gpt-oss). Records: [`evals/results/`](../evals/results/).

## Not yet measured
- The full 89-task Terminal-Bench run, and the guards' effect on it.
- GLM-5.3 on the same 50 SWE-rebench tasks (model comparison).
- A reference harness (e.g. mini-swe-agent) with the same model on the same tasks: this isolates arcode's own contribution.
- More than one attempt per task (pass@k, run-to-run variance).
