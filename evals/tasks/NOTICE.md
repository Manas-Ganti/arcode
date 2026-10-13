# Task sources

- `poly-*`: the 34 Python exercises of [Aider's polyglot benchmark](https://github.com/Aider-AI/polyglot-benchmark) (commit `7e0611e`), imported with `scripts/import-polyglot.ts`. Exercise content is copyright © [Exercism](https://exercism.org), from the MIT-licensed [Exercism Python track](https://github.com/exercism/python).
  Unlike Aider's harness, which hides the tests on the first attempt, arcode's agent sees the test file from the start, so scores are **not comparable** with Aider's leaderboard. These exercises are public and likely in model training data.
- `m2-*`: hand-written multi-file tasks for arcode, new for this benchmark (MIT, like the rest of the repo).
- The other tasks (`pager-off-by-one`, `calc-unary-decimal`, …) are arcode's M1 smoke tasks: small and solved by every model tested, so they're useful as a sanity check, not for comparisons.
