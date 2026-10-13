from report import category_totals

def test_quoted_comma():
    text = 'name,category,amount\n"Smith, J",food,10\nLee,food,5.5\n'
    assert category_totals(text) == {"food": 15.5}
