def parse(pointer):
    """'/a/b~1c' -> ['a', 'b/c']"""
    if pointer == "":
        return []
    if not pointer.startswith("/"):
        raise ValueError(f"invalid pointer: {pointer!r}")
    return [p.replace("~0", "~").replace("~1", "/") for p in pointer[1:].split("/")]


def resolve_parent(doc, parts):
    """Return (container, last_key) for the location `parts` points to."""
    node = doc
    for p in parts[:-1]:
        node = node[int(p)] if isinstance(node, list) else node[p]
    return node, parts[-1]
