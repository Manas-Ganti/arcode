from intervals import merge_intervals

def test_cases():
    assert merge_intervals([]) == []
    assert merge_intervals([[1, 3], [3, 5]]) == [[1, 5]]
    assert merge_intervals([[5, 8], [1, 2], [2, 4]]) == [[1, 4], [5, 8]]
    assert merge_intervals([[1, 10], [2, 3], [4, 5]]) == [[1, 10]]
    assert merge_intervals([[1, 2], [4, 5]]) == [[1, 2], [4, 5]]
    assert merge_intervals([[3, 3]]) == [[3, 3]]

def test_input_not_modified():
    data = [[5, 8], [1, 3], [2, 6]]
    snapshot = [list(x) for x in data]
    merge_intervals(data)
    assert data == snapshot
