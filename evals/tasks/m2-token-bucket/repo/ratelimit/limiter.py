from .bucket import TokenBucket


class KeyedLimiter:
    """One token bucket per key (e.g. per client), all sharing a clock."""

    def __init__(self, rate, capacity, clock):
        self.rate, self.capacity, self.clock = rate, capacity, clock
        self._buckets = {}

    def allow(self, key, cost=1):
        bucket = self._buckets.get(key)
        if bucket is None:
            bucket = self._buckets[key] = TokenBucket(self.rate, self.capacity, self.clock)
        return bucket.allow(cost)
