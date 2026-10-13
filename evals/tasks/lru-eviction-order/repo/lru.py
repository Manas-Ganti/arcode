class LRUCache:
    def __init__(self, capacity):
        if capacity < 1:
            raise ValueError("capacity must be >= 1")
        self.capacity = capacity
        self.data = {}

    def get(self, key, default=None):
        return self.data.get(key, default)

    def put(self, key, value):
        if key not in self.data and len(self.data) >= self.capacity:
            oldest = next(iter(self.data))
            del self.data[oldest]
        self.data[key] = value

    def __len__(self):
        return len(self.data)

    def __contains__(self, key):
        return key in self.data
