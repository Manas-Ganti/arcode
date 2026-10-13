/**
 * Minimal markdown → ANSI for terminal output. Line-based, no dependencies.
 * Handles what models actually emit: **bold**, *italic*, `code`, headings,
 * bullets, quotes, rules, links, and ``` fences (left verbatim inside).
 */

const sgr = (on: number, off: number) => (s: string) => `\x1b[${on}m${s}\x1b[${off}m`;
const bold = sgr(1, 22), dim = sgr(2, 22), italic = sgr(3, 23), underline = sgr(4, 24), cyan = sgr(36, 39);

export interface MdState { inFence: boolean }

/** Style one complete line. `state` carries code-fence context across lines. */
export function renderMarkdownLine(line: string, state: MdState): string {
  if (/^\s*(```|~~~)/.test(line)) {
    state.inFence = !state.inFence;
    return dim(line);
  }
  if (state.inFence) return cyan(line);

  const h = line.match(/^(#{1,6})\s+(.*)$/);
  if (h) return bold(h[1].length <= 2 ? underline(inline(h[2])) : inline(h[2]));
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return dim("─".repeat(40));
  const quote = line.match(/^(\s*)>\s?(.*)$/);
  if (quote) return `${quote[1]}${dim("│")} ${dim(inline(quote[2]))}`;
  const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
  if (bullet) return `${bullet[1]}• ${inline(bullet[2])}`;
  return inline(line);
}

/** Inline spans. Code spans first, so nothing inside backticks is touched. */
function inline(text: string): string {
  return text
    .split(/(`[^`]+`)/)
    .map((part, i) => {
      if (i % 2 === 1) return cyan(part.slice(1, -1));
      return part
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, url) => `${underline(t)} ${dim(`(${url})`)}`)
        .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, (_, t) => bold(t))
        .replace(/(?<!\w)__(?=\S)(.+?)(?<=\S)__(?!\w)/g, (_, t) => bold(t))
        // Single * or _ only around a word-ish span: leaves `2 * 3 * 4` and snake_case alone.
        .replace(/(?<![\w*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\w*])/g, (_, t) => italic(t))
        .replace(/(?<![\w])_(?=[^\s_])(.+?)(?<=[^\s_])_(?!\w)/g, (_, t) => italic(t));
    })
    .join("");
}

/** Render a whole (non-streamed) message. */
export function renderMarkdown(text: string): string {
  const state: MdState = { inFence: false };
  return text.split("\n").map((l) => renderMarkdownLine(l, state)).join("\n");
}

/**
 * Streaming: raw text is shown as it arrives; when a line completes, it is
 * redrawn styled in place. `columns` is the terminal width, for lines that wrapped.
 */
export class MarkdownStream {
  private state: MdState = { inFence: false };
  private line = "";
  constructor(private columns: number) {}

  /** Returns what to write for this chunk. */
  push(chunk: string): string {
    let out = "";
    for (const part of chunk.replace(/\t/g, "    ").split(/(\n)/)) {
      if (part === "\n") {
        out += this.redraw() + "\n";
        this.line = "";
      } else if (part) {
        this.line += part;
        out += part;
      }
    }
    return out;
  }

  /** Styles the unfinished last line, if any (no trailing newline). */
  flush(): string {
    const out = this.line ? this.redraw() : "";
    this.line = "";
    return out;
  }

  private redraw(): string {
    const width = [...this.line].length;
    const rows = Math.max(1, Math.ceil(width / this.columns));
    // Back to the start of the raw line (it may have wrapped), clear, write it styled.
    return `\r${rows > 1 ? `\x1b[${rows - 1}A` : ""}\x1b[J${renderMarkdownLine(this.line, this.state)}`;
  }
}
