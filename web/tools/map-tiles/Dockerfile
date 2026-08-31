# syntax=docker/dockerfile:1

# Renders the isometric pyramid from the game files. Never part of the running
# stack: compose keeps it behind a profile and it is run on demand.
FROM python:3.12-slim

# Pillow needs libjpeg/zlib to decode the game's textures. build-essential and
# linux-libc-dev are for pynput's evdev backend, which compiles a C extension
# against linux/input.h — pzmap2dzi never touches keyboard/mouse input in
# headless deploy/unpack/render use, but pip installs the whole requirements
# file regardless. lupa (Lua bindings) also builds its bundled Lua from source
# and needs the same toolchain.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git libjpeg62-turbo zlib1g build-essential linux-libc-dev \
    && rm -rf /var/lib/apt/lists/*

ARG PZMAP2DZI_REF=main
# The GitHub *source* tree of pzdataspec has KSY files under data_spec/spec/.
# The *release zip* has compiled parsers at pzdataspec/spec/v249/. Importing
# the source tree (PYTHONPATH=/opt/pzdataspec) shadows the zip and crashes:
# FileNotFoundError: .../pzdataspec/spec
ARG PZDATASPEC_ZIP=https://github.com/cff29546/pzdataspec/releases/download/v1.12.249/pzdataspec-v1.12.249.zip
RUN git clone --depth 1 --branch "${PZMAP2DZI_REF}" \
        https://github.com/cff29546/pzmap2dzi.git /opt/pzmap2dzi \
    && pip install --no-cache-dir -r /opt/pzmap2dzi/requirements.txt \
    && pip install --no-cache-dir lark \
    && python -c "import io,os,urllib.request,zipfile; z=zipfile.ZipFile(io.BytesIO(urllib.request.urlopen('$PZDATASPEC_ZIP').read())); z.extractall('/opt')"

WORKDIR /opt/pzmap2dzi

# Build context is web/tools (parent of this Dockerfile) so the sprite baker
# can ship in the same image without a second Python stack.
COPY map-tiles/conf.yaml /opt/pzmap2dzi/conf/conf.yaml
COPY map-tiles/verify.py map-tiles/pack.py map-tiles/unpack.py map-tiles/cells.py map-tiles/region.py map-tiles/levels.py map-tiles/set_render_range.py map-tiles/set_omit_levels.py map-tiles/align_map_info_skip.py map-tiles/recompress.py map-tiles/check_cache.py map-tiles/audit.py map-tiles/chunks.py map-tiles/set_save_game.py map-tiles/snapshot_save.py map-tiles/composite.py map-tiles/progress.py map-tiles/run.sh map-tiles/patch_scheduler.py map-tiles/chunk_sprites.py map-tiles/patch_save_render.py map-tiles/rcon_save.py map-tiles/save_skip.py map-tiles/patch_base_skip.py map-tiles/wait_save.py map-tiles/ensure_map_info.py map-tiles/open_squares.py map-tiles/fill_unpainted.py map-tiles/rebuild_pyramid.py map-tiles/heal_black.py map-tiles/patch_unit_range.py map-tiles/patch_render_margin.py map-tiles/patch_merge_filter.py map-tiles/lotpack_leaves.py map-tiles/tiledef_map.py map-tiles/pack_size.py /tools/
COPY map-sprites /tools/map_sprites
# region.py and set_render_range.py import cells.py by name.
ENV PYTHONPATH=/tools:/opt/pzmap2dzi:/opt
# omit_levels + cache eviction paints black holes; pin children until merged.
# Save overlay must paint live door/window sprites, not vanilla closed ones.
RUN python /tools/patch_scheduler.py && python /tools/patch_save_render.py && python /tools/patch_base_skip.py && python /tools/patch_unit_range.py && python /tools/patch_render_margin.py && python /tools/patch_merge_filter.py
# run.sh pipes the render through tee so check_cache.py can read its output.
# A pipe makes Python block-buffer stdout, which strands progress lines for
# minutes at a time and blinds anything watching the log live.
ENV PYTHONUNBUFFERED=1
RUN chmod +x /tools/run.sh

ENTRYPOINT ["/tools/run.sh"]
