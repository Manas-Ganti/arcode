from decimal import Decimal
import pytest
from bank import InsufficientFunds, Ledger, UnknownAccount

def test_types_and_places():
    led = Ledger()
    led.open("a", "10")
    b = led.balance("a")
    assert isinstance(b, Decimal) and b == Decimal("10.00") and b.as_tuple().exponent == -2

def test_rounding_half_up():
    led = Ledger()
    led.open("a")
    led.deposit("a", "2.675")
    led.deposit("a", "0.005")
    assert led.balance("a") == Decimal("2.69")

def test_non_positive_rejected():
    led = Ledger()
    led.open("a", "5")
    led.open("b")
    for bad in (0, "-1", -0.5):
        with pytest.raises(ValueError):
            led.deposit("a", bad)
        with pytest.raises(ValueError):
            led.transfer("a", "b", bad)

def test_transfer_unknown_accounts_change_nothing():
    led = Ledger()
    led.open("a", "5")
    with pytest.raises(UnknownAccount):
        led.transfer("a", "nobody", "1")
    with pytest.raises(UnknownAccount):
        led.transfer("nobody", "a", "100")
    assert led.balance("a") == Decimal("5.00") and led.history == []

def test_insufficient_funds_change_nothing():
    led = Ledger()
    led.open("a", "5")
    led.open("b")
    with pytest.raises(InsufficientFunds):
        led.transfer("a", "b", "5.01")
    assert led.balance("a") == Decimal("5.00") and led.balance("b") == Decimal("0.00") and led.history == []

def test_transfer_ok():
    led = Ledger()
    led.open("a", "5")
    led.open("b", 1)
    led.transfer("a", "b", 4.995)
    assert led.balance("a") == Decimal("0.00") and led.balance("b") == Decimal("6.00")
    assert len(led.history) == 1
