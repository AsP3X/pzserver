import pytest

from pack_size import full_size


def test_skip_is_multiplied_back():
    """map_info reports w/h divided by 2^skip; the client needs full-res."""
    assert full_size({"w": 579616, "h": 253944, "skip": 2}) == (2318464, 1015776)


def test_no_skip_is_the_size_itself():
    assert full_size({"w": 100, "h": 50}) == (100, 50)
    assert full_size({"w": 100, "h": 50, "skip": 0}) == (100, 50)


def test_this_install_is_not_the_public_pyramid():
    """The hardcoded pair was 3264 px taller than the render, which squashed
    every level in the browser. Guard the number that caught it."""
    width, height = full_size({"w": 579616, "h": 253944, "skip": 2})
    assert (width, height) != (2318656, 1019040)
    assert 1019040 - height == 3264


def test_a_map_info_without_size_is_an_error():
    with pytest.raises(KeyError):
        full_size({"skip": 2})
