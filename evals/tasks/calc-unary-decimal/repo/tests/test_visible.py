from calc import evaluate

def test_negative_and_decimal():
    assert evaluate("-3 + 2") == -1
    assert evaluate("1.5 * 2") == 3.0
