def to_amount(value):
    """Parse a user-supplied amount ("12.50", 12.5, 3) into a number."""
    return round(float(value), 2)
