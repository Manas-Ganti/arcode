/**
 * Guards: small checks around the agent loop that turn known failure modes into
 * a short <harness_notice> to the model instead of a lost task. Each was added
 * for a failure seen in evals:
 *   - truncated / overlong model calls (a runaway reasoning stream used 9.5 of 15 minutes)
 *   - time running out unnoticed (every Terminal-Bench pilot failure was a timeout)
 *   - repeating the same tool call (27 bash calls reading library source)
 *   - finishing without re-running tests after edits (a confident wrong "done")
 * agent.ts calls these at fixed points; the policy lives here.
 */
import type { ToolCall } from "./llm.js";

export type NoticeKind = "truncated" | "call_timeout" | "deadline" | "loop" | "verify";
export interface Notice { kind: NoticeKind; text: string }

const TEST_COMMAND = /\b(pytest|unittest|npm (run )?test|yarn test|pnpm test|go test|cargo test|jest|vitest|mocha|make (test|check)|ctest|tox)\b/;
const EDIT_TOOLS = new Set(["edit_file", "write_file"]);

export function noticeMessage(n: Notice): string {
  return `<harness_notice kind="${n.kind}">${n.text}</harness_notice>`;
}

export class Guards {
  private start: number;
  private deadlineNoticesSent = 0;
  private recent: string[] = [];
  private loopWarned = new Set<string>();
  private editedSinceTests = false;
  private verifyNudged = false;

  constructor(
    private opts: { deadlineS?: number; testsAvailable: boolean; maxOutputTokens: number; callTimeoutS: number },
    private now: () => number = Date.now,
  ) {
    this.start = now();
  }

  /** Before a model call: a time warning at 30% and 10% of the deadline remaining. */
  beforeCall(): Notice | undefined {
    if (!this.opts.deadlineS) return undefined;
    const total = this.opts.deadlineS * 1000;
    const left = total - (this.now() - this.start);
    const thresholds = [0.3, 0.1];
    if (this.deadlineNoticesSent >= thresholds.length || left > total * thresholds[this.deadlineNoticesSent]) return undefined;
    while (this.deadlineNoticesSent < thresholds.length && left <= total * thresholds[this.deadlineNoticesSent]) this.deadlineNoticesSent++;
    const min = Math.max(0, Math.round(left / 60_000));
    const final = this.deadlineNoticesSent === thresholds.length;
    return {
      kind: "deadline",
      text: `About ${min} minute${min === 1 ? "" : "s"} left before this task is stopped. ${final
        ? "Stop exploring: make sure the most important change is saved and working, then finish."
        : "Prioritize: finish the core change, verify it, and avoid new side investigations."}`,
    };
  }

  /** A model call was cut off by the output cap without a usable answer. */
  truncated(): Notice {
    return { kind: "truncated", text: `Your previous response hit the ${this.opts.maxOutputTokens}-token output limit before producing an answer or a tool call, so it was discarded. Think more briefly and act in smaller steps: make one tool call now.` };
  }

  /** A model call ran past the per-call time limit and was stopped. */
  callTimeout(): Notice {
    return { kind: "call_timeout", text: `Your previous response took longer than ${this.opts.callTimeoutS}s and was stopped before finishing. Think more briefly and act in smaller steps: make one tool call now.` };
  }

  /** After tool calls run: track edits/tests, and flag the same call repeated 3 times in the last 10. */
  afterTools(calls: { call: ToolCall; ok: boolean }[]): Notice | undefined {
    let notice: Notice | undefined;
    for (const { call } of calls) {
      const name = call.function.name;
      const args = call.function.arguments;
      if (EDIT_TOOLS.has(name)) this.editedSinceTests = true;
      if (name === "run_tests" || (name === "bash" && TEST_COMMAND.test(args))) this.editedSinceTests = false;
      const sig = `${name} ${normalizeArgs(args)}`;
      this.recent = [...this.recent, sig].slice(-10);
      if (!notice && !this.loopWarned.has(sig) && this.recent.filter((s) => s === sig).length >= 3) {
        this.loopWarned.add(sig);
        notice = { kind: "loop", text: `You have now called ${name} with the same arguments 3 times; the result won't change. Step back and try a different approach.` };
      }
    }
    return notice;
  }

  /** The model wants to finish: once per task, ask it to run the tests if it edited files since they last ran. */
  beforeFinish(): Notice | undefined {
    if (!this.opts.testsAvailable || !this.editedSinceTests || this.verifyNudged) return undefined;
    this.verifyNudged = true;
    return { kind: "verify", text: "You edited files after the tests last ran (or never ran them). Run run_tests now to check your changes; fix anything that fails, then finish. If the tests can't be run here, say why and finish." };
  }
}

function normalizeArgs(args: string): string {
  try { return JSON.stringify(JSON.parse(args)); } catch { return args.trim(); }
}
