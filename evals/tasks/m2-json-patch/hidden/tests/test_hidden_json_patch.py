import copy
import pytest
from jsonpatch import PatchError, apply_patch, parse

def test_escapes():
    assert parse("/a~1b/~0c/~01") == ["a/b", "~c", "~1"]
    assert apply_patch({"~1": 1}, [{"op": "replace", "path": "/~01", "value": 2}]) == {"~1": 2}

def test_list_ops():
    doc = {"a": [1, 2, 3]}
    assert apply_patch(doc, [{"op": "remove", "path": "/a/1"}]) == {"a": [1, 3]}
    assert apply_patch(doc, [{"op": "add", "path": "/a/-", "value": 4}]) == {"a": [1, 2, 3, 4]}
    assert apply_patch(doc, [{"op": "add", "path": "/a/3", "value": 4}]) == {"a": [1, 2, 3, 4]}
    assert apply_patch(doc, [{"op": "add", "path": "/a/0", "value": 0}]) == {"a": [0, 1, 2, 3]}
    assert apply_patch(doc, [{"op": "replace", "path": "/a/2", "value": 9}]) == {"a": [1, 2, 9]}

def test_root():
    assert apply_patch({"a": 1}, [{"op": "replace", "path": "", "value": [1]}]) == [1]
    with pytest.raises(PatchError):
        apply_patch({"a": 1}, [{"op": "remove", "path": ""}])

def test_input_never_modified():
    doc = {"a": [1, {"b": 2}], "c": {"d": 1}}
    before = copy.deepcopy(doc)
    out = apply_patch(doc, [{"op": "add", "path": "/a/1/b", "value": 3}, {"op": "remove", "path": "/c/d"}])
    assert out == {"a": [1, {"b": 3}], "c": {}}
    assert doc == before

@pytest.mark.parametrize("op", [
    {"op": "move", "path": "/a", "from": "/b"},
    {"op": "remove", "path": "/missing"},
    {"op": "replace", "path": "/missing", "value": 1},
    {"op": "remove", "path": "/a/5"},
    {"op": "add", "path": "/a/5", "value": 1},
    {"op": "replace", "path": "/a/x", "value": 1},
    {"op": "add", "path": "/nope/x", "value": 1},
])
def test_invalid_ops_raise_and_leave_input(op):
    doc = {"a": [1, 2]}
    with pytest.raises(PatchError):
        apply_patch(doc, [{"op": "add", "path": "/z", "value": 0}, op])
    assert doc == {"a": [1, 2]}
