"""
Stage 2, step 2: LoRA SFT of a student model on arcode's successful trajectories (TRL).

    python train_sft.py --model Qwen/Qwen3-8B --data data/ --out runs/qwen3-8b-sft

- Loss only on the agent's own turns (assistant_only_loss; TRL patches Qwen3's template with
  {% generation %} markers, which also renders an empty <think></think> per turn, matching
  Qwen3's thinking-off mode: serve with enable_thinking=false).
- Prints how much of the first example is actually trained on, as a sanity check.
- Resumes from the newest checkpoint in --out; writes run_config.json next to the adapter.
- Built against trl 1.9.2 / transformers 5.x / peft (the ARC training env); unknown SFTConfig
  kwargs are dropped with a warning instead of crashing after the queue wait.
"""

import argparse
import inspect
import json
import subprocess
from pathlib import Path

import torch
from datasets import Dataset
from peft import LoraConfig
from transformers import AutoModelForCausalLM, AutoTokenizer
from trl import SFTConfig, SFTTrainer
from trl.chat_template_utils import get_training_chat_template


def load(path: Path) -> Dataset:
    # from_list mirrors prepare_sft.py's round-trip check (tools stay a JSON string).
    return Dataset.from_list([json.loads(l) for l in path.read_text().splitlines() if l.strip()])


def sft_config(**kwargs) -> SFTConfig:
    allowed = inspect.signature(SFTConfig).parameters
    dropped = sorted(k for k in kwargs if k not in allowed)
    if dropped:
        print(f"note: SFTConfig in this TRL version has no {dropped}; skipping them")
    return SFTConfig(**{k: v for k, v in kwargs.items() if k in allowed})


def trained_fraction(tok, template: str, row: dict) -> float:
    out = tok.apply_chat_template(row["messages"], tools=json.loads(row["tools"]), chat_template=template,
                                  tokenize=True, return_dict=True, return_assistant_tokens_mask=True)
    mask = out["assistant_masks"]
    return sum(mask) / max(1, len(mask))


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--model", default="Qwen/Qwen3-8B")
    p.add_argument("--data", default="data")
    p.add_argument("--out", required=True)
    p.add_argument("--chat-template-from", help="copy the chat template from this tokenizer (for tiny test models)")
    p.add_argument("--max-length", type=int, default=32768)
    p.add_argument("--epochs", type=float, default=2)
    p.add_argument("--max-steps", type=int, default=-1)
    p.add_argument("--lr", type=float, default=1e-4)
    p.add_argument("--lora-r", type=int, default=64)
    p.add_argument("--batch", type=int, default=1)
    p.add_argument("--grad-accum", type=int, default=16)
    p.add_argument("--warmup-steps", type=int, default=10)
    p.add_argument("--seed", type=int, default=0)
    a = p.parse_args()

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    data = Path(a.data)
    train, val = load(data / "train.jsonl"), load(data / "val.jsonl")

    tok = AutoTokenizer.from_pretrained(a.model)
    if a.chat_template_from:
        tok.chat_template = AutoTokenizer.from_pretrained(a.chat_template_from).chat_template
    template = get_training_chat_template(tok)
    if template is None:
        raise SystemExit("TRL has no training chat template for this model family; assistant-only loss would be wrong.")
    frac = trained_fraction(tok, template, train[0])
    print(f"sanity: {frac:.1%} of the first example's tokens are trained on (assistant turns only)")
    if not 0.0 < frac < 0.9:
        raise SystemExit("assistant mask looks wrong (0% or ~100% trained); check the chat template.")

    gpu = torch.cuda.is_available()
    args = sft_config(
        output_dir=str(out),
        assistant_only_loss=True,
        max_length=a.max_length,
        packing=False,
        num_train_epochs=a.epochs,
        max_steps=a.max_steps,
        per_device_train_batch_size=a.batch,
        gradient_accumulation_steps=a.grad_accum,
        learning_rate=a.lr,
        lr_scheduler_type="cosine",
        warmup_steps=a.warmup_steps,
        gradient_checkpointing=gpu,
        bf16=gpu,
        logging_steps=1,
        eval_strategy="epoch" if len(val) else "no",
        save_strategy="steps",
        save_steps=50,
        save_total_limit=2,
        report_to="none",
        seed=a.seed,
    )
    # Load the model ourselves (explicit dtype) rather than by name inside SFTTrainer: TRL's own
    # loading path segfaulted on macOS in the CPU smoke test, and explicit is clearer on ARC too.
    model = AutoModelForCausalLM.from_pretrained(a.model, dtype=torch.bfloat16 if gpu else torch.float32)
    lora = LoraConfig(r=a.lora_r, lora_alpha=2 * a.lora_r, lora_dropout=0.05, target_modules="all-linear", task_type="CAUSAL_LM")
    trainer = SFTTrainer(model=model, args=args, train_dataset=train, eval_dataset=val if len(val) else None,
                         processing_class=tok, peft_config=lora)

    resume = max(out.glob("checkpoint-*"), key=lambda c: int(c.name.split("-")[1]), default=None)
    trainer.train(resume_from_checkpoint=str(resume) if resume else None)
    adapter = out / "adapter"
    trainer.save_model(str(adapter))
    tok.save_pretrained(str(adapter))

    try:
        commit = subprocess.run(["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True, cwd=Path(__file__).parent).stdout.strip()
    except OSError:
        commit = "unknown"
    stats = json.loads((data / "stats.json").read_text()) if (data / "stats.json").exists() else {}
    (out / "run_config.json").write_text(json.dumps({
        "base_model": a.model, "arcode_commit": commit, "data_stats": stats, "trained_fraction_first_example": frac,
        "args": vars(a), "final_log": trainer.state.log_history[-3:],
    }, indent=1, default=str))
    (out / "DONE").write_text("ok\n")
    print(f"saved adapter to {adapter}")


if __name__ == "__main__":
    main()
