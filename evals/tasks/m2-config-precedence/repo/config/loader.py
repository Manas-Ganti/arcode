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
    cfg = merge(cfg, overrides or {})
    cfg = merge(cfg, _from_env(environ))
    return cfg
