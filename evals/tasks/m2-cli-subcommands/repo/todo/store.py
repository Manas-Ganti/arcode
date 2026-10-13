from dataclasses import dataclass


@dataclass
class Item:
    id: int
    text: str
    priority: int = 0


class TodoStore:
    def __init__(self):
        self._items = []

    def add(self, text, priority=0):
        item = Item(len(self._items) + 1, text, priority)
        self._items.append(item)
        return item

    def items(self):
        """Items to show, most important first."""
        return sorted(self._items, key=lambda i: i.priority)
