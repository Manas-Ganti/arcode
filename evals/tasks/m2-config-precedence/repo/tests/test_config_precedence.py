from config import load_config

def test_overrides_beat_env():
    cfg = load_config(environ={"APP_DEBUG": "true"}, overrides={"debug": False})
    assert cfg["debug"] is False
