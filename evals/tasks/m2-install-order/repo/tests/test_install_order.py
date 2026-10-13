from deps import Graph, install_order

def test_dependency_first():
    g = Graph()
    g.add("app", "lib")
    assert install_order(g, ["app"]) == ["lib", "app"]
