def merge(base, extra):
    """Return base updated with extra (neither is modified)."""
    out = dict(base)
    out.update(extra)
    return out
