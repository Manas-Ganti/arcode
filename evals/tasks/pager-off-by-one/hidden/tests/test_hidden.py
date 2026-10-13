import pytest
from pager import paginate, page_count

def test_pages():
    items = list(range(10))
    assert paginate(items, 1, 3) == [0, 1, 2]
    assert paginate(items, 2, 3) == [3, 4, 5]
    assert paginate(items, 4, 3) == [9]
    assert paginate(items, 5, 3) == []

def test_page_count_rounds_up():
    assert page_count(10, 3) == 4
    assert page_count(9, 3) == 3
    assert page_count(0, 3) == 0
    assert page_count(1, 5) == 1

def test_validation_kept():
    with pytest.raises(ValueError):
        paginate([1], 0, 3)
