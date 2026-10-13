from ratelimit import FakeClock, TokenBucket

def test_slow_rate_refills():
    clock = FakeClock()
    b = TokenBucket(rate=0.5, capacity=1, clock=clock)
    assert b.allow()
    clock.advance(1)
    assert not b.allow()
    clock.advance(1)
    assert b.allow()
