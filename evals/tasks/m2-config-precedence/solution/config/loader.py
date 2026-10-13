import json
import os

from .merge import merge

DEFAULTS = {"server": {"host": "127.0.0.1", "port": 8000, "timeout": 2.5}, "debug": False, "log": {"level": "info"}}


def _from_env(environ, prefix="APP_"):
    """APP_SERVER__PORT=9000 -> {"server": {"port": "9000"}}"""
    out = {}
    for key, value in environ.items():
        if not key.startswith(prefix):
            continue
        path = key[len(prefix):].lower().split("__")
        node = out
        for part in path[:-1]:
            node = node.setdefault(part, {})
        node[path[-1]] = value
    return out


def load_config(path=None, environ=None, overrides=None):
    """Precedence, lowest to highest: DEFAULTS < JSON file < APP_* env vars < overrides."""
    environ = os.environ if environ is None else environ
    cfg = merge({}, DEFAULTS)
    if path:
        with open(path) as f:
            cfg = merge(cfg, json.load(f))
    cfg = merge(cfg, _coerce(_from_env(environ), cfg))
    cfg = merge(cfg, overrides or {})
    return cfg


def _coerce(env, current):
    out = {}
    for key, value in env.items():
        old = current.get(key) if isinstance(current, dict) else None
        if isinstance(value, dict):
            out[key] = _coerce(value, old if isinstance(old, dict) else {})
        elif isinstance(old, bool):
            low = value.strip().lower()
            if low not in ("true", "1", "yes", "false", "0", "no"):
                raise ValueError(f"not a boolean: {value!r}")
            out[key] = low in ("true", "1", "yes")
        elif isinstance(old, int):
            out[key] = int(value)
        elif isinstance(old, float):
            out[key] = float(value)
        else:
            out[key] = value
    return out
