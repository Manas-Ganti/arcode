from pager import paginate

def test_first_page_starts_at_first_item():
    assert paginate(list(range(10)), 1, 3) == [0, 1, 2]
