/**
 * Arrow-key list picker for the terminal: ↑/↓ (or k/j) move, Enter selects,
 * Esc / q / Ctrl+C cancel, 1-9 jump. No dependencies: raw-mode keypress events.
 */
import { stdin, stdout } from "node:process";

export interface Key { name?: string; ctrl?: boolean; meta?: boolean; sequence?: string }
export type PickerResult = { index: number } | { done: number } | { cancel: true };

/** One keypress → new highlighted row, a selection, or cancel. Pure, for tests. */
export function pickerStep(index: number, count: number, str: string | undefined, key: Key | undefined): PickerResult {
  const name = key?.name;
  if ((key?.ctrl && name === "c") || name === "escape" || name === "q") return { cancel: true };
  if (name === "return" || name === "enter") return { done: index };
  if (name === "up" || name === "k") return { index: (index - 1 + count) % count };
  if (name === "down" || name === "j") return { index: (index + 1) % count };
  if (name === "home") return { index: 0 };
  if (name === "end") return { index: count - 1 };
  const digit = str && /^[1-9]$/.test(str) ? Number(str) - 1 : -1;
  if (digit >= 0 && digit < count) return { done: digit };
  return { index };
}

/**
 * Show `labels` and let the user pick one. Resolves to the chosen index, or
 * undefined if cancelled. Takes over keypress handling from readline while open.
 */
export function pickFromList(title: string, labels: string[], initial: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    const saved = stdin.listeners("keypress") as ((...a: any[]) => void)[];
    stdin.removeAllListeners("keypress");
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();

    let index = Math.max(0, initial);
    let drawn = 0;
    const draw = () => {
      if (drawn) stdout.write(`\x1b[${drawn}F\x1b[J`);
      const lines = [
        `\x1b[1m${title}\x1b[22m`,
        ...labels.map((l, i) => (i === index ? `\x1b[36m› ${l}\x1b[39m` : `  ${l}`)),
        `\x1b[2m↑/↓ move · Enter select · Esc cancel · 1-9 jump\x1b[22m`,
      ];
      stdout.write(lines.join("\n") + "\n");
      drawn = lines.length;
    };
    const finish = (result: number | undefined) => {
      stdin.removeListener("keypress", onKey);
      stdout.write(`\x1b[${drawn}F\x1b[J\x1b[?25h`); // erase the picker, show the cursor
      stdin.setRawMode(wasRaw);
      for (const l of saved) stdin.on("keypress", l);
      resolve(result);
    };
    const onKey = (str: string | undefined, key: Key | undefined) => {
      const r = pickerStep(index, labels.length, str, key);
      if ("cancel" in r) return finish(undefined);
      if ("done" in r) return finish(r.done);
      index = r.index;
      draw();
    };
    stdout.write("\x1b[?25l"); // hide the cursor while picking
    stdin.on("keypress", onKey);
    draw();
  });
}

/** Option+M: macOS terminals send ESC m ("Use Option as Meta") or the character µ (default). */
export const isModelHotkey = (str: string | undefined, key: Key | undefined) => (key?.meta && key.name === "m") || str === "µ";
