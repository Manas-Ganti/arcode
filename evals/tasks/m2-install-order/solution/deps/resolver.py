class CycleError(Exception):
    pass


def install_order(graph, targets):
    """Packages to install for `targets`, each after all of its dependencies."""
    order, done, stack = [], set(), []

    def visit(pkg):
        if pkg in done:
            return
        if pkg in stack:
            raise CycleError(" -> ".join(stack[stack.index(pkg):] + [pkg]))
        stack.append(pkg)
        for d in graph.deps(pkg):
            visit(d)
        stack.pop()
        done.add(pkg)
        order.append(pkg)

    for t in targets:
        visit(t)
    return order
