import pytest

from patch_render_margin import OLD, apply


def test_apply_is_idempotent():
    once = apply(OLD)
    assert "conf.yaml wins" in once
    assert apply(once) == once


def test_conf_value_is_no_longer_clobbered():
    out = apply(OLD)
    assert "if not options.get('render_margin'):" in out
    # The jumbo-tree default still applies when conf.yaml says nothing.
    assert "'large' if self.use_jumbo_tree else 'normal'" in out


def test_apply_refuses_an_unfamiliar_render():
    with pytest.raises(SystemExit):
        apply("def update_options(self, options):\n    return options\n")
