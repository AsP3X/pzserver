from patch_scheduler import EVICT_NEW, METHOD_NEW, apply

SAMPLE = '''
    def release_cache(self, key, method):
        if key:
            hit_key, value = self.lru.pop(key)
        else:
            hit_key, value = self.lru.pop()
        if hit_key:
            wid, layer_map = value
            if self.stopped[wid] == 0:
                self.context.send_msg(wid, (method, hit_key))
            self.cache_used -= sum(layer_map)

    def shutdown(self):
        pass

    def on_result(self, wid, job, result):
                if self.cache_size:
                    while self.cache_used > self.cache_size:
                        self.release_cache(None, 'save')
'''


def test_pins_skip_level_tiles_instead_of_destroying_them():
    patched = apply(SAMPLE)
    assert "def release_unpinned(self):" in patched
    assert EVICT_NEW in patched
    assert "self.release_cache(None, 'save')" not in patched
    assert METHOD_NEW.split("def shutdown")[0] in patched


def test_is_idempotent():
    once = apply(SAMPLE)
    assert apply(once) == once


def test_refuses_to_ship_if_upstream_moved_the_loop():
    try:
        apply("no eviction here")
    except SystemExit as error:
        assert "eviction loop not found" in str(error)
    else:
        raise AssertionError("expected SystemExit")
