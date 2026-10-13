def paginate(items, page, per_page):
    """Return the items on a 1-indexed page."""
    if page < 1 or per_page < 1:
        raise ValueError("page and per_page must be >= 1")
    start = (page - 1) * per_page
    return items[start:start + per_page]


def page_count(n_items, per_page):
    """Number of pages needed to show n_items."""
    return -(-n_items // per_page)
