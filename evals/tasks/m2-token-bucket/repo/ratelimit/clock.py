class FakeClock:
    def __init__(self, start=0.0):
        self.t = start

    def now(self):
        return self.t

    def advance(self, seconds):
        self.t += seconds
