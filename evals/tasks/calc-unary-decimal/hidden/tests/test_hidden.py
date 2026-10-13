import pytest
from calc import evaluate

@pytest.mark.parametrize("expr,want", [
    ("-3 + 2.5", -0.5), ("2 * -3", -6), ("-(1 + 2)", -3), ("--4", 4),
    (".5 + 1", 1.5), ("2 + 3 * 4", 14), ("(1 + 2) * 3", 9), ("10 / 4", 2.5), ("7", 7),
])
def test_values(expr, want):
    assert evaluate(expr) == pytest.approx(want)

@pytest.mark.parametrize("bad", ["2 +", "(1 + 2", "1 2", ""])
def test_malformed(bad):
    with pytest.raises(SyntaxError):
        evaluate(bad)
