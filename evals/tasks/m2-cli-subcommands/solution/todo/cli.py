import argparse

from .store import TodoStore


def positive_int(text):
    value = int(text)
    if value <= 0:
        raise argparse.ArgumentTypeError(f"must be a positive integer: {text}")
    return value


def build_parser():
    p = argparse.ArgumentParser(prog="todo")
    p.add_argument("--verbose", "-v", action="store_true")
    # Also accepted after the subcommand; SUPPRESS keeps it from resetting a global -v.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--verbose", "-v", action="store_true", default=argparse.SUPPRESS)
    sub = p.add_subparsers(dest="command")
    add = sub.add_parser("add", parents=[common])
    add.add_argument("text")
    add.add_argument("--priority", type=int, default=0)
    ls = sub.add_parser("list", parents=[common])
    ls.add_argument("--limit", type=positive_int, default=10)
    return p


def main(argv, store=None):
    """Run the CLI; returns the output text (one line per item)."""
    store = store if store is not None else TodoStore()
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command is None:
        return parser.format_usage()
    if args.command == "add":
        item = store.add(args.text, args.priority)
        return f"added #{item.id}" + (f" (priority {item.priority})" if args.verbose else "")
    if args.command == "list":
        items = store.items()[: args.limit]
        return "\n".join(f"#{i.id} {i.text}" + (f" [p{i.priority}]" if args.verbose else "") for i in items)
