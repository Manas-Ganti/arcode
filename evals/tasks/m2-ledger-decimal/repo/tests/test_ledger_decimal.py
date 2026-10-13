from decimal import Decimal
from bank import Ledger

def test_cents_add_up():
    led = Ledger()
    led.open("a")
    led.deposit("a", 0.1)
    led.deposit("a", 0.2)
    assert led.balance("a") == Decimal("0.30")
