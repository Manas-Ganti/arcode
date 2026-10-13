from cache import FakeClock, TTLCache

def test_boundary():
    clock = FakeClock(100.0)
    c = TTLCache(5, clock)
    c.set("a", 1)
    clock.advance(4.999)
    assert c.get("a") == 1
    clock.advance(0.001)
    assert c.get("a") is None

def test_overwrite_resets_ttl():
    clock = FakeClock()
    c = TTLCache(5, clock)
    c.set("a", 1)
    clock.advance(4)
    c.set("a", 2)
    clock.advance(4)
    assert c.get("a") == 2

def test_full_cache_drops_expired_before_live():
    clock = FakeClock()
    c = TTLCache(10, clock, max_size=2)
    c.set("old", 1)
    clock.advance(6)
    c.set("live", 2)
    clock.advance(5)  # "old" expired at t=10, "live" valid until t=16
    c.set("new", 3)
    assert c.get("live") == 2 and c.get("new") == 3

def test_full_cache_evicts_soonest_expiring_live_entry():
    clock = FakeClock()
    c = TTLCache(10, clock, max_size=2)
    c.set("a", 1)
    clock.advance(1)
    c.set("b", 2)
    c.set("c", 3)
    assert c.get("a") is None and c.get("b") == 2 and c.get("c") == 3

def test_len_excludes_expired():
    clock = FakeClock()
    c = TTLCache(3, clock)
    c.set("a", 1)
    clock.advance(2)
    c.set("b", 2)
    clock.advance(2)
    assert len(c) == 1
