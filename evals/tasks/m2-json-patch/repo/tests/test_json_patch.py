from jsonpatch import apply_patch

def test_remove_list_element():
    assert apply_patch({"a": [1, 2, 3]}, [{"op": "remove", "path": "/a/0"}]) == {"a": [2, 3]}
