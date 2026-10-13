from decimal import ROUND_HALF_UP, Decimal

CENTS = Decimal("0.01")


def to_amount(value):
    """Parse a user-supplied amount ("12.50", 12.5, 3) into Decimal cents, rounded half-up."""
    return Decimal(str(value)).quantize(CENTS, rounding=ROUND_HALF_UP)


def positive(value):
    amount = to_amount(value)
    if amount <= 0:
        raise ValueError(f"amount must be positive: {value!r}")
    return amount
