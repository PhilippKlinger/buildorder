from example_package import greet


def test_greet_names_the_person():
    assert greet("World") == "Hello, World!"
