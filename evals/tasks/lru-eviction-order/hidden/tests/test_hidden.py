import pytest
from lru import LRUCache

def test_get_refreshes():
    c = LRUCache(2)
    c.put("a", 1); c.put("b", 2); c.get("a"); c.put("c", 3)
    assert c.get("a") == 1 and c.get("b") is None and c.get("c") == 3

def test_put_existing_refreshes_and_updates():
    c = LRUCache(2)
    c.put("a", 1); c.put("b", 2); c.put("a", 10); c.put("c", 3)
    assert c.get("a") == 10 and "b" not in c and len(c) == 2

def test_contains_is_not_a_use():
    c = LRUCache(2)
    c.put("a", 1); c.put("b", 2)
    assert "a" in c
    c.put("c", 3)
    assert "a" not in c and "b" in c

def test_get_missing_does_not_change_order():
    c = LRUCache(2)
    c.put("a", 1); c.put("b", 2)
    assert c.get("zzz", "dflt") == "dflt"
    c.put("c", 3)
    assert "a" not in c

def test_capacity_one_and_validation():
    c = LRUCache(1)
    c.put("a", 1); c.put("b", 2)
    assert "a" not in c and c.get("b") == 2
    with pytest.raises(ValueError):
        LRUCache(0)
