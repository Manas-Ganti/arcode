class TokenBucket:
    """Allows `rate` requests per second on average, with bursts up to `capacity`."""

    def __init__(self, rate, capacity, clock):
        self.rate = rate
        self.capacity = capacity
        self.clock = clock
        self.tokens = capacity
        self.updated = clock.now()

    def _refill(self):
        now = self.clock.now()
        elapsed = now - self.updated
        self.tokens += int(elapsed * self.rate)
        self.updated = now

    def allow(self, cost=1):
        self._refill()
        if self.tokens >= cost:
            self.tokens -= cost
            return True
        return False
