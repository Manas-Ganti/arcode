from intervals import merge_intervals

def test_touching():
    assert merge_intervals([[1, 3], [3, 5]]) == [[1, 5]]
