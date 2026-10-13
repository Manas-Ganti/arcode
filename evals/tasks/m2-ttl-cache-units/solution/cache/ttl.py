from .clock import Clock

_MS = 1000
_MISSING = object()


class TTLCache:
    def __init__(self, ttl_seconds, clock=None, max_size=128):
        self.ttl = ttl_seconds
        self.clock = clock or Clock()
        self.max_size = max_size
        self._data = {}  # key -> (value, expires_at)

    def _now_ms(self):
        return self.clock.now() * _MS

    def set(self, key, value):
        if len(self._data) >= self.max_size and key not in self._data:
            now = self.clock.now()
            for k in [k for k, (_, exp) in self._data.items() if now >= exp]:
                del self._data[k]
            if len(self._data) >= self.max_size:
                self._evict()
        self._data[key] = (value, self.clock.now() + self.ttl)

    def get(self, key, default=None):
        item = self._data.get(key)
        if item is None:
            return default
        value, expires_at = item
        if self.clock.now() >= expires_at:
            del self._data[key]
            return default
        return value

    def _evict(self):
        # drop the entry that expires soonest
        soonest = min(self._data, key=lambda k: self._data[k][1])
        del self._data[soonest]

    def __len__(self):
        return sum(1 for k in list(self._data) if self.get(k, _MISSING) is not _MISSING)
