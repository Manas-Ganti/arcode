from todo import TodoStore, main

def test_verbose_after_subcommand():
    s = TodoStore()
    main(["add", "milk", "--priority", "2"], s)
    assert main(["list", "-v"], s) == "#1 milk [p2]"
