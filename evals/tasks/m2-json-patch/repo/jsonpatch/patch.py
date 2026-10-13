from .pointer import parse, resolve_parent


class PatchError(Exception):
    pass


def apply_patch(doc, ops):
    """Apply RFC 6902 add/remove/replace operations and return the result."""
    for op in ops:
        parts = parse(op["path"])
        parent, key = resolve_parent(doc, parts)
        if op["op"] == "add":
            if isinstance(parent, list):
                parent.insert(int(key), op["value"])
            else:
                parent[key] = op["value"]
        elif op["op"] == "remove":
            if isinstance(parent, list):
                parent.pop(int(key) - 1)
            else:
                del parent[key]
        elif op["op"] == "replace":
            parent[int(key) if isinstance(parent, list) else key] = op["value"]
        else:
            raise PatchError(f"unsupported op: {op['op']}")
    return doc
