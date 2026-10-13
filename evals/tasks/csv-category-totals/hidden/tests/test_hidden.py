from report import category_totals

def test_quoted_commas_and_blank_lines():
    text = 'name,category,amount\n"Smith, J",food,10\n\nLee,"travel, local",2.5\nKim,food,1\n'
    assert category_totals(text) == {"food": 11.0, "travel, local": 2.5}

def test_crlf_and_column_order():
    text = "amount,category\r\n3,a\r\n4.5,b\r\n1,a\r\n"
    assert category_totals(text) == {"a": 4.0, "b": 4.5}

def test_header_only():
    assert category_totals("category,amount\n") == {}
