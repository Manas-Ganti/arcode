import copy

from .pointer import parse, resolve_parent


class PatchError(Exception):
    pass


def apply_patch(doc, ops):
    """Apply RFC 6902 add/remove/replace operations and return the result (doc is not modified)."""
    result = copy.deepcopy(doc)
    for op in ops:
        try:
            result = _apply(result, op)
        except (KeyError, IndexError, ValueError, TypeError) as e:
            raise PatchError(f"{op}: {e}") from e
    return result


def _index(parent, key, allow_end):
    if key == "-" and allow_end:
        return len(parent)
    if not key.isdigit():
        raise ValueError(f"bad list index: {key!r}")
    i = int(key)
    if i > len(parent) or (i == len(parent) and not allow_end):
        raise IndexError(f"index out of range: {i}")
    return i


def _apply(doc, op):
    kind = op.get("op")
    if kind not in ("add", "remove", "replace"):
        raise ValueError(f"unsupported op: {kind}")
    parts = parse(op["path"])
    if not parts:
        if kind == "remove":
            raise ValueError("cannot remove the root")
        return copy.deepcopy(op["value"])
    parent, key = resolve_parent(doc, parts)
    if isinstance(parent, list):
        if kind == "add":
            parent.insert(_index(parent, key, True), copy.deepcopy(op["value"]))
        elif kind == "remove":
            parent.pop(_index(parent, key, False))
        else:
            parent[_index(parent, key, False)] = copy.deepcopy(op["value"])
    elif isinstance(parent, dict):
        if kind == "add":
            parent[key] = copy.deepcopy(op["value"])
        elif kind == "remove":
            del parent[key]
        else:
            if key not in parent:
                raise KeyError(key)
            parent[key] = copy.deepcopy(op["value"])
    else:
        raise TypeError(f"cannot index into {type(parent).__name__}")
    return doc
