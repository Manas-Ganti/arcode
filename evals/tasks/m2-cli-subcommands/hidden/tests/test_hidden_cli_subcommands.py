import pytest
from todo import TodoStore, build_parser, main

def store_with(n):
    s = TodoStore()
    for k in range(n):
        main(["add", f"t{k + 1}", "--priority", str(k % 3)], s)
    return s

def test_verbose_both_positions():
    s = store_with(1)
    assert main(["-v", "list"], s) == main(["list", "-v"], s) == "#1 t1 [p0]"
    assert main(["add", "x", "--verbose"], s) == "added #2 (priority 0)"
    assert main(["-v", "add", "y"], s) == "added #3 (priority 0)"
    assert main(["list"], s).splitlines()[0] == "#1 t1"

def test_no_command_returns_usage():
    assert main([], TodoStore()) == build_parser().format_usage()

def test_order_and_default_limit():
    lines = main(["list"], store_with(12)).splitlines()
    assert len(lines) == 10
    assert lines[:4] == ["#3 t3", "#6 t6", "#9 t9", "#12 t12"]
    assert main(["list", "--limit", "2"], store_with(5)).splitlines() == ["#3 t3", "#2 t2"]

@pytest.mark.parametrize("bad", ["0", "-3"])
def test_limit_must_be_positive(bad):
    with pytest.raises(SystemExit) as e:
        main(["list", "--limit", bad], TodoStore())
    assert e.value.code == 2
