from .models import Reservation, normalize_sku


class OutOfStock(Exception):
    pass


class Inventory:
    def __init__(self):
        self._stock = {}  # sku -> units on hand
        self._reserved = {}  # order_id -> list[Reservation]

    def add_stock(self, sku, qty):
        sku = normalize_sku(sku)
        self._stock[sku] = self._stock.get(sku, 0) + qty

    def available(self, sku):
        sku = normalize_sku(sku)
        held = sum(r.qty for rs in self._reserved.values() for r in rs if r.sku == sku)
        return self._stock.get(sku, 0) - held

    def reserve(self, order_id, sku, qty):
        sku = normalize_sku(sku)
        if qty > self.available(sku):
            raise OutOfStock(sku)
        self._reserved.setdefault(order_id, []).append(Reservation(order_id, sku, qty))

    def reserve_many(self, order_id, lines):
        """Reserve several (sku, qty) lines for one order: all or nothing."""
        for sku, qty in lines:
            if qty > self.available(sku):
                raise OutOfStock(sku)
        for sku, qty in lines:
            self._reserved.setdefault(order_id, []).append(Reservation(order_id, sku, qty))

    def release(self, order_id):
        self._reserved.pop(order_id, None)
