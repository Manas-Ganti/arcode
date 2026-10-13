class Graph:
    def __init__(self):
        self.edges = {}  # package -> set of packages it depends on

    def add(self, package, *deps):
        self.edges.setdefault(package, set()).update(deps)
        for d in deps:
            self.edges.setdefault(d, set())

    def deps(self, package):
        return sorted(self.edges.get(package, ()))
