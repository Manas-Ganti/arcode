from shop import Inventory

def test_reserve_many_holds_stock():
    inv = Inventory()
    inv.add_stock("widget", 5)
    inv.reserve_many("o1", [("widget", 2)])
    assert inv.available("WIDGET") == 3
