import pytest
from ratelimit import FakeClock, KeyedLimiter, TokenBucket

def test_fractional_refill_accumulates():
    clock = FakeClock()
    b = TokenBucket(rate=0.25, capacity=2, clock=clock)
    assert b.allow(2)
    for _ in range(3):
        clock.advance(1)
        assert not b.allow()
    clock.advance(1)
    assert b.allow()

def test_capped_at_capacity_after_idle():
    clock = FakeClock()
    b = TokenBucket(rate=10, capacity=3, clock=clock)
    clock.advance(100)
    assert [b.allow() for _ in range(4)] == [True, True, True, False]

def test_wait_time():
    clock = FakeClock()
    b = TokenBucket(rate=2, capacity=4, clock=clock)
    assert b.wait_time() == 0.0
    assert b.allow(4)
    assert b.wait_time() == pytest.approx(0.5)
    assert b.wait_time(3) == pytest.approx(1.5)
    clock.advance(0.5)
    assert b.wait_time() == pytest.approx(0.0)
    assert b.allow()

def test_wait_time_does_not_consume():
    clock = FakeClock()
    b = TokenBucket(rate=1, capacity=1, clock=clock)
    b.wait_time()
    b.wait_time()
    assert b.allow()

def test_cost_above_capacity():
    b = TokenBucket(rate=1, capacity=2, clock=FakeClock())
    with pytest.raises(ValueError):
        b.allow(3)
    with pytest.raises(ValueError):
        b.wait_time(3)

def test_keyed_independent():
    clock = FakeClock()
    lim = KeyedLimiter(rate=1, capacity=1, clock=clock)
    assert lim.allow("a") and lim.allow("b")
    assert not lim.allow("a")
    clock.advance(1)
    assert lim.allow("a")
