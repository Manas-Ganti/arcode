from .tokenizer import tokenize


class Parser:
    def __init__(self, tokens):
        self.toks = tokens
        self.i = 0

    def peek(self):
        return self.toks[self.i] if self.i < len(self.toks) else (None, None)

    def take(self):
        tok = self.peek()
        self.i += 1
        return tok

    def expr(self):
        value = self.term()
        while self.peek() in (("op", "+"), ("op", "-")):
            op = self.take()[1]
            rhs = self.term()
            value = value + rhs if op == "+" else value - rhs
        return value

    def term(self):
        value = self.factor()
        while self.peek() in (("op", "*"), ("op", "/")):
            op = self.take()[1]
            rhs = self.factor()
            value = value * rhs if op == "*" else value / rhs
        return value

    def factor(self):
        kind, val = self.take()
        if kind == "num":
            return val
        if (kind, val) == ("op", "("):
            value = self.expr()
            if self.take() != ("op", ")"):
                raise SyntaxError("expected )")
            return value
        raise SyntaxError(f"unexpected token {val!r}")


def evaluate(s):
    p = Parser(tokenize(s))
    value = p.expr()
    if p.peek() != (None, None):
        raise SyntaxError("trailing input")
    return value
