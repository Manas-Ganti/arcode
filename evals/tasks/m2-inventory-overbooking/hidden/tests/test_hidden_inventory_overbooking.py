import pytest
from shop import Inventory, OutOfStock, low_stock

def make():
    inv = Inventory()
    inv.add_stock("Widget", 5)
    inv.add_stock("gadget", 2)
    return inv

def test_reserve_many_counts_any_casing():
    inv = make()
    inv.reserve_many("o1", [(" widget ", 2), ("GADGET", 1)])
    assert inv.available("WIDGET") == 3
    assert inv.available("gadget") == 1

def test_duplicate_lines_cannot_overbook():
    inv = make()
    with pytest.raises(OutOfStock):
        inv.reserve_many("o1", [("widget", 3), ("WIDGET", 3)])
    assert inv.available("widget") == 5

def test_all_or_nothing():
    inv = make()
    with pytest.raises(OutOfStock):
        inv.reserve_many("o1", [("widget", 1), ("gadget", 3)])
    assert inv.available("widget") == 5 and inv.available("gadget") == 2

def test_release_frees_everything():
    inv = make()
    inv.reserve_many("o1", [("widget", 2), ("widget", 2)])
    assert inv.available("widget") == 1
    inv.release("o1")
    assert inv.available("widget") == 5

def test_single_reserve_still_works():
    inv = make()
    inv.reserve("o2", "widget", 5)
    with pytest.raises(OutOfStock):
        inv.reserve("o3", "Widget", 1)

def test_report_sees_reservations():
    inv = make()
    inv.reserve_many("o1", [("widget", 4)])
    assert low_stock(inv, ["widget", "gadget"], 2) == ["widget"]
