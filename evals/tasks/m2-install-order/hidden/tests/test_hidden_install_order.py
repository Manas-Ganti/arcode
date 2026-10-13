import pytest
from deps import CycleError, Graph, install_order

def test_diamond():
    g = Graph()
    g.add("app", "web", "db")
    g.add("web", "http")
    g.add("db", "http")
    assert install_order(g, ["app"]) == ["http", "db", "web", "app"]

def test_only_needed_and_target_order():
    g = Graph()
    g.add("a", "x")
    g.add("b", "y")
    g.add("unused", "z")
    assert install_order(g, ["b", "a"]) == ["y", "b", "x", "a"]
    assert install_order(g, ["a", "x"]) == ["x", "a"]

def test_unknown_target_without_deps():
    assert install_order(Graph(), ["solo"]) == ["solo"]

def test_cycle_message():
    g = Graph()
    g.add("a", "b")
    g.add("b", "c")
    g.add("c", "a")
    with pytest.raises(CycleError, match="a -> b -> c -> a"):
        install_order(g, ["a"])

def test_cycle_below_target():
    g = Graph()
    g.add("app", "x")
    g.add("x", "y")
    g.add("y", "x")
    with pytest.raises(CycleError, match="x -> y -> x"):
        install_order(g, ["app"])

def test_self_dependency():
    g = Graph()
    g.add("a", "a")
    with pytest.raises(CycleError, match="a -> a"):
        install_order(g, ["a"])
