import copy
import json
from config import DEFAULTS, load_config

def test_precedence(tmp_path):
    f = tmp_path / "c.json"
    f.write_text(json.dumps({"log": {"level": "warn"}, "server": {"port": 7000}}))
    cfg = load_config(str(f), environ={"APP_SERVER__PORT": "9000", "APP_LOG__LEVEL": "debug"}, overrides={"log": {"level": "error"}})
    assert cfg["server"]["port"] == 9000
    assert cfg["log"]["level"] == "error"

def test_deep_merge_keeps_siblings(tmp_path):
    f = tmp_path / "c.json"
    f.write_text(json.dumps({"server": {"port": 7000}}))
    cfg = load_config(str(f), environ={})
    assert cfg["server"] == {"host": "127.0.0.1", "port": 7000, "timeout": 2.5}

def test_env_types():
    cfg = load_config(environ={"APP_SERVER__PORT": "9000", "APP_SERVER__TIMEOUT": "0.5", "APP_DEBUG": "Yes", "APP_NEW__THING": "42", "OTHER": "x"})
    assert cfg["server"]["port"] == 9000 and isinstance(cfg["server"]["port"], int)
    assert cfg["server"]["timeout"] == 0.5
    assert cfg["debug"] is True
    assert cfg["new"]["thing"] == "42"
    assert load_config(environ={"APP_DEBUG": "0"})["debug"] is False

def test_inputs_not_modified():
    before = copy.deepcopy(DEFAULTS)
    overrides = {"server": {"port": 1}}
    load_config(environ={"APP_LOG__LEVEL": "debug"}, overrides=overrides)
    load_config(environ={}, overrides={"server": {"host": "0.0.0.0"}})
    assert DEFAULTS == before
    assert overrides == {"server": {"port": 1}}
    assert load_config(environ={})["server"]["port"] == 8000
