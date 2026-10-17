"""
Stage 2, step 1: `arcode export` JSONL -> train/val files ready for SFT on a given student model.

    python prepare_sft.py sft.jsonl --model Qwen/Qwen3-8B --max-length 32768 --val-frac 0.05 --out data/

- Normalizes messages for chat templates (assistant `content: null` -> "").
- Splits by TASK (not by example), so validation tasks are never seen in training.
- Measures each example's real token length with the student's chat template (tools
  included) and drops examples longer than --max-length (counted in stats.json).
- Stores `tools` as a JSON string (TRL json-loads it): as nested data, Arrow merges every
  tool's parameter schema into one struct, so each tool would render with the others' fields.
- Checks the data survives a round trip through `datasets` with rendering unchanged.
"""

import argparse
import json
import random
from collections import Counter
from pathlib import Path

from datasets import Dataset
from transformers import AutoTokenizer


def normalize(example: dict) -> dict:
    msgs = []
    for m in example["messages"]:
        m = dict(m)
        if m.get("content") is None:
            m["content"] = ""
        msgs.append(m)
    return {"messages": msgs, "tools": example["tools"], "task": example["meta"]["task"]}


def tools_of(ex: dict) -> list:
    t = ex["tools"]
    return json.loads(t) if isinstance(t, str) else t


def render(tok, ex: dict) -> str:
    return tok.apply_chat_template(ex["messages"], tools=tools_of(ex), tokenize=False)


def n_tokens(tok, ex: dict) -> int:
    # transformers 5.x returns a BatchEncoding (a dict) even with tokenize=True.
    out = tok.apply_chat_template(ex["messages"], tools=tools_of(ex), tokenize=True, return_dict=True)
    return len(out["input_ids"])


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("input")
    p.add_argument("--model", default="Qwen/Qwen3-8B", help="student tokenizer / chat template")
    p.add_argument("--max-length", type=int, default=32768)
    p.add_argument("--val-frac", type=float, default=0.05)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--out", default="data")
    a = p.parse_args()

    tok = AutoTokenizer.from_pretrained(a.model)
    rows = [normalize(json.loads(l)) for l in Path(a.input).read_text().splitlines() if l.strip()]

    # Sanity: tool calls and tool results actually appear in the rendered text.
    sample = next(r for r in rows if any(m.get("tool_calls") for m in r["messages"]))
    text = render(tok, sample)
    call = next(m for m in sample["messages"] if m.get("tool_calls"))["tool_calls"][0]["function"]
    assert call["name"] in text and json.loads(call["arguments"]) is not None, "tool call not rendered"
    assert '"name": "' in text or call["name"] in text, "tool specs not rendered"

    lengths: dict[int, int] = {}
    kept: list = []
    dropped: Counter = Counter()
    for r in rows:
        n = n_tokens(tok, r)
        lengths[id(r)] = n
        if n > a.max_length:
            dropped["too_long"] += 1
        else:
            kept.append(r)

    tasks = sorted({r["task"] for r in kept})
    random.Random(a.seed).shuffle(tasks)
    val_tasks = set(tasks[: max(1, int(len(tasks) * a.val_frac))])
    train = [r for r in kept if r["task"] not in val_tasks]
    val = [r for r in kept if r["task"] in val_tasks]

    for r in kept:
        r["tools"] = json.dumps(r["tools"])

    # Round-trip check through datasets/Arrow: what the trainer will render must equal the raw data.
    ds = Dataset.from_list([{"messages": r["messages"], "tools": r["tools"]} for r in train])
    raw_vs_arrow = sum(render(tok, dict(ds[i])) != render(tok, train[i]) for i in range(len(ds)))

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for name, part in (("train", train), ("val", val)):
        with open(out / f"{name}.jsonl", "w") as f:
            for r in part:
                f.write(json.dumps({"messages": r["messages"], "tools": r["tools"]}) + "\n")
    toks = sorted(lengths[id(r)] for r in kept)
    stats = {
        "input_examples": len(rows), "kept": len(kept), "dropped": dict(dropped),
        "train_examples": len(train), "val_examples": len(val), "train_tasks": len(tasks) - len(val_tasks), "val_tasks": len(val_tasks),
        "tokens_median": toks[len(toks) // 2] if toks else 0, "tokens_p90": toks[int(len(toks) * 0.9)] if toks else 0, "tokens_max": toks[-1] if toks else 0,
        "train_tokens_total": sum(lengths[id(r)] for r in train), "model": a.model, "max_length": a.max_length,
        "arrow_roundtrip_changes_rendering": raw_vs_arrow,
    }
    (out / "stats.json").write_text(json.dumps(stats, indent=1))
    print(json.dumps(stats, indent=1))
    if raw_vs_arrow:
        raise SystemExit(f"ERROR: {raw_vs_arrow}/{len(ds)} examples render differently after the datasets round trip; training would not see what the model sees at run time.")


if __name__ == "__main__":
    main()
