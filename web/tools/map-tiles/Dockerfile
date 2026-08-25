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

# Overwrites the shipped config, deliberately. parse_map() resolves map_conf and
# map_conf_default relative to the config file's own directory, so conf.yaml has
# to sit beside vanilla.txt, default_b42.txt and mod/ — putting it anywhere else
# makes the render fail looking for map descriptions that are not there.
COPY conf.yaml /opt/pzmap2dzi/conf/conf.yaml
COPY verify.py pack.py unpack.py cells.py region.py levels.py set_render_range.py set_omit_levels.py align_map_info_skip.py recompress.py check_cache.py audit.py chunks.py set_save_game.py snapshot_save.py composite.py progress.py run.sh patch_scheduler.py chunk_sprites.py patch_save_render.py rcon_save.py save_skip.py patch_base_skip.py wait_save.py ensure_map_info.py open_squares.py fill_unpainted.py rebuild_pyramid.py heal_black.py patch_unit_range.py patch_render_margin.py patch_merge_filter.py lotpack_leaves.py /tools/
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
