import time


class Clock:
    """Seconds since an arbitrary epoch."""

    def now(self) -> float:
        return time.monotonic()


class FakeClock(Clock):
    def __init__(self, start: float = 0.0):
        self.t = start

    def now(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds
