import re

TOKEN = re.compile(r"\s*(?:(\d+)|(.))")


def tokenize(s):
    """Split an arithmetic expression into ("num", value) and ("op", char) tokens."""
    out = []
    for num, op in TOKEN.findall(s):
        if num:
            out.append(("num", int(num)))
        elif op.strip():
            out.append(("op", op))
    return out
