from .money import to_amount


class InsufficientFunds(Exception):
    pass


class UnknownAccount(Exception):
    pass


class Ledger:
    def __init__(self):
        self.balances = {}
        self.history = []

    def open(self, account, initial="0"):
        self.balances[account] = to_amount(initial)

    def deposit(self, account, amount):
        if account not in self.balances:
            raise UnknownAccount(account)
        self.balances[account] += to_amount(amount)
        self.history.append(("deposit", account, to_amount(amount)))

    def transfer(self, src, dst, amount):
        amount = to_amount(amount)
        if self.balances.get(src, 0) < amount:
            raise InsufficientFunds(src)
        self.balances[src] -= amount
        if dst not in self.balances:
            raise UnknownAccount(dst)
        self.balances[dst] += amount
        self.history.append(("transfer", src, dst, amount))

    def balance(self, account):
        return self.balances[account]
