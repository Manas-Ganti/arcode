class TokenBucket:
    """Allows `rate` requests per second on average, with bursts up to `capacity`."""

    def __init__(self, rate, capacity, clock):
        self.rate = rate
        self.capacity = capacity
        self.clock = clock
        self.tokens = float(capacity)
        self.updated = clock.now()

    def _refill(self):
        now = self.clock.now()
        self.tokens = min(self.capacity, self.tokens + (now - self.updated) * self.rate)
        self.updated = now

    def _check(self, cost):
        if cost > self.capacity:
            raise ValueError(f"cost {cost} exceeds capacity {self.capacity}")

    def allow(self, cost=1):
        self._check(cost)
        self._refill()
        if self.tokens >= cost:
            self.tokens -= cost
            return True
        return False

    def wait_time(self, cost=1):
        self._check(cost)
        self._refill()
        return max(0.0, (cost - self.tokens) / self.rate)
