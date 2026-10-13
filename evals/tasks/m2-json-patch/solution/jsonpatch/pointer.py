def parse(pointer):
    """'/a/b~1c' -> ['a', 'b/c']"""
    if pointer == "":
        return []
    if not pointer.startswith("/"):
        raise ValueError(f"invalid pointer: {pointer!r}")
    return [p.replace("~1", "/").replace("~0", "~") for p in pointer[1:].split("/")]


def resolve_parent(doc, parts):
    """Return (container, last_key) for the location `parts` points to."""
    node = doc
    for p in parts[:-1]:
        if isinstance(node, list):
            if not p.isdigit():
                raise ValueError(f"bad list index: {p!r}")
            node = node[int(p)]
        else:
            node = node[p]
    return node, parts[-1]
