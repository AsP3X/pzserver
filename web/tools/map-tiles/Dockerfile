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
RUN git clone --depth 1 --branch "${PZMAP2DZI_REF}" \
        https://github.com/cff29546/pzmap2dzi.git /opt/pzmap2dzi \
    && pip install --no-cache-dir -r /opt/pzmap2dzi/requirements.txt

WORKDIR /opt/pzmap2dzi

# Overwrites the shipped config, deliberately. parse_map() resolves map_conf and
# map_conf_default relative to the config file's own directory, so conf.yaml has
# to sit beside vanilla.txt, default_b42.txt and mod/ — putting it anywhere else
# makes the render fail looking for map descriptions that are not there.
COPY conf.yaml /opt/pzmap2dzi/conf/conf.yaml
COPY verify.py pack.py unpack.py cells.py region.py levels.py set_render_range.py check_cache.py audit.py run.sh patch_scheduler.py /tools/
# region.py and set_render_range.py import cells.py by name.
ENV PYTHONPATH=/tools
# omit_levels + cache eviction paints black holes; pin children until merged.
RUN python /tools/patch_scheduler.py
# run.sh pipes the render through tee so check_cache.py can read its output.
# A pipe makes Python block-buffer stdout, which strands progress lines for
# minutes at a time and blinds anything watching the log live.
ENV PYTHONUNBUFFERED=1
RUN chmod +x /tools/run.sh

ENTRYPOINT ["/tools/run.sh"]
