import argparse

from .store import TodoStore


def build_parser():
    p = argparse.ArgumentParser(prog="todo")
    p.add_argument("--verbose", "-v", action="store_true")
    sub = p.add_subparsers(dest="command")
    add = sub.add_parser("add")
    add.add_argument("text")
    add.add_argument("--priority", type=int, default=0)
    ls = sub.add_parser("list")
    ls.add_argument("--limit", type=int)
    return p


def main(argv, store=None):
    """Run the CLI; returns the output text (one line per item)."""
    store = store if store is not None else TodoStore()
    args = build_parser().parse_args(argv)
    if args.command == "add":
        item = store.add(args.text, args.priority)
        return f"added #{item.id}" + (f" (priority {item.priority})" if args.verbose else "")
    if args.command == "list":
        items = store.items()[: args.limit]
        return "\n".join(f"#{i.id} {i.text}" + (f" [p{i.priority}]" if args.verbose else "") for i in items)
