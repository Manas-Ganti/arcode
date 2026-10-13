class CycleError(Exception):
    pass


def install_order(graph, targets):
    """Packages to install for `targets`, each after all of its dependencies."""
    order, seen = [], set()

    def visit(pkg):
        if pkg in seen:
            return
        seen.add(pkg)
        order.append(pkg)
        for d in graph.deps(pkg):
            visit(d)

    for t in targets:
        visit(t)
    return order
