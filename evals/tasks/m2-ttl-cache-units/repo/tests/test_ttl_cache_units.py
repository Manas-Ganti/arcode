from cache import FakeClock, TTLCache

def test_expires_after_ttl():
    clock = FakeClock()
    c = TTLCache(10, clock)
    c.set("a", 1)
    clock.advance(11)
    assert c.get("a") is None
