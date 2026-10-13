from .money import positive, to_amount


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
        amount = positive(amount)
        self.balances[account] += amount
        self.history.append(("deposit", account, amount))

    def transfer(self, src, dst, amount):
        for acct in (src, dst):
            if acct not in self.balances:
                raise UnknownAccount(acct)
        amount = positive(amount)
        if self.balances[src] < amount:
            raise InsufficientFunds(src)
        self.balances[src] -= amount
        self.balances[dst] += amount
        self.history.append(("transfer", src, dst, amount))

    def balance(self, account):
        return self.balances[account]
