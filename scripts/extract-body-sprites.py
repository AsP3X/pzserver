#!/usr/bin/env python3
"""Rebuild the health-panel silhouette from a Project Zomboid client install.

The body art ships only with the game client, packed into media/texturepacks/
UI2.pack as bps_male_<part>; a dedicated server install carries none of it. This
reads that pack, crops the seventeen body parts, throws away their colour, and
writes resources/js/components/character-body-sprites.ts as alpha masks — so the
web dashboard draws the same body the player already reads in game, in our own
palette.

Only needed when the game's art changes. Requires Pillow.

    python3 scripts/extract-body-sprites.py [path/to/UI2.pack]
"""
import base64
import io
import os
import struct
import sys

from PIL import Image

PART_MAP = {
    'head': 'Head', 'neck': 'Neck', 'chest': 'Torso_Upper', 'abdomen': 'Torso_Lower',
    'groin': 'Groin', 'upper-right-arm': 'UpperArm_R', 'upper-left-arm': 'UpperArm_L',
    'lower-right-arm': 'ForeArm_R', 'lower-left-arm': 'ForeArm_L',
    'right-hand': 'Hand_R', 'left-hand': 'Hand_L',
    'right-thigh': 'UpperLeg_R', 'left-thigh': 'UpperLeg_L',
    'right-calf': 'LowerLeg_R', 'left-calf': 'LowerLeg_L',
    'right-foot': 'Foot_R', 'left-foot': 'Foot_L',
}
ORDER = ['Head', 'Neck', 'Torso_Upper', 'Torso_Lower', 'Groin',
         'UpperArm_R', 'UpperArm_L', 'ForeArm_R', 'ForeArm_L', 'Hand_R', 'Hand_L',
         'UpperLeg_R', 'UpperLeg_L', 'LowerLeg_R', 'LowerLeg_L', 'Foot_R', 'Foot_L']

DEFAULT_PACK = os.path.expanduser(
    '~/Library/Application Support/Steam/steamapps/common/ProjectZomboid/'
    'Project Zomboid.app/Contents/Java/media/texturepacks/UI2.pack')


def read_pack(path):
    """Yield (entries, page_png) for every page in a PZPK texture pack."""
    data = open(path, 'rb').read()
    if data[:4] != b'PZPK':
        raise SystemExit(f'{path} is not a PZPK texture pack')
    offset = 12
    for _ in range(struct.unpack_from('<i', data, 8)[0]):
        length, = struct.unpack_from('<i', data, offset)
        offset += 4 + length
        count, = struct.unpack_from('<i', data, offset)
        offset += 8
        entries = []
        for _ in range(count):
            name_len, = struct.unpack_from('<i', data, offset)
            offset += 4
            name = data[offset:offset + name_len].decode('latin1')
            offset += name_len
            entries.append((name,) + struct.unpack_from('<8i', data, offset))
            offset += 32
        png_len, = struct.unpack_from('<i', data, offset)
        offset += 4
        yield entries, data[offset:offset + png_len]
        offset += png_len


def main():
    pack = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_PACK
    if not os.path.exists(pack):
        raise SystemExit(f'no texture pack at {pack}\nPass the path to a client UI2.pack.')

    page = next((p for p in read_pack(pack)
                 if any(e[0].startswith('bps_male_') for e in p[0])), None)
    if page is None:
        raise SystemExit('no bps_male_* sprites in that pack')
    entries, png = page
    atlas = Image.open(io.BytesIO(png)).convert('RGBA')

    parts, canvas = {}, None
    for entry in entries:
        name = entry[0]
        key = name[len('bps_male_'):] if name.startswith('bps_male_') else None
        if key not in PART_MAP:
            continue
        x, y, w, h, ox, oy, ow, oh = entry[1:]
        canvas = (ow, oh)
        alpha = atlas.crop((x, y, x + w, y + h)).getchannel('A')
        pixels = alpha.load()

        # Centroid of the visible pixels, so a reading never lands in the notch
        # of an L-shaped part like a foot or an open hand.
        total = sum_x = sum_y = 0
        top_y, top_xs = None, []
        for row in range(h):
            for col in range(w):
                if pixels[col, row] > 128:
                    total += 1
                    sum_x += col
                    sum_y += row
                    if top_y is None:
                        top_y = row
                    if row == top_y:
                        top_xs.append(col)
        cx, cy = (sum_x / total, sum_y / total) if total else (w / 2, h / 2)

        buffer = io.BytesIO()
        Image.merge('LA', (Image.new('L', alpha.size, 255), alpha)).save(
            buffer, 'PNG', optimize=True)
        parts[PART_MAP[key]] = dict(
            x=ox, y=oy, w=w, h=h,
            label=(round(ox + cx, 1), round(oy + cy, 1)),
            pin=(round(ox + sum(top_xs) / len(top_xs), 1), round(oy + top_y + 2, 1)),
            mask=base64.b64encode(buffer.getvalue()).decode())

    missing = [p for p in ORDER if p not in parts]
    if missing:
        raise SystemExit(f'pack is missing sprites for: {", ".join(missing)}')

    out = os.path.join(os.path.dirname(__file__), '..', 'app', 'resources', 'js',
                       'components', 'character-body-sprites.ts')
    with open(os.path.abspath(out), 'w') as fh:
        fh.write(HEADER)
        fh.write(f'export const BODY_CANVAS = {{ width: {canvas[0]}, height: {canvas[1]} }};\n\n')
        fh.write(TYPE)
        fh.write("/** Head down, so the figure reads the way a person does. */\n")
        fh.write('export const BODY_SPRITES: Record<string, BodySprite> = {\n')
        for name in ORDER:
            v = parts[name]
            fh.write(f'    {name}: {{\n')
            fh.write(f"        x: {v['x']}, y: {v['y']}, w: {v['w']}, h: {v['h']},\n")
            fh.write(f"        label: [{v['label'][0]}, {v['label'][1]}], "
                     f"pin: [{v['pin'][0]}, {v['pin'][1]}],\n")
            fh.write(f"        mask: 'data:image/png;base64,{v['mask']}',\n")
            fh.write('    },\n')
        fh.write('};\n\nexport const BODY_PART_ORDER: string[] = [\n')
        for name in ORDER:
            fh.write(f"    '{name}',\n")
        fh.write('];\n')
    print(f'wrote {len(parts)} sprites to {os.path.relpath(os.path.abspath(out))}')


HEADER = """/**
 * The game's own health-panel silhouette, one alpha mask per body part.
 *
 * GENERATED - do not edit by hand. Rebuilt with scripts/extract-body-sprites.py
 * from media/texturepacks/UI2.pack in a Project Zomboid client install, where
 * the art ships as bps_male_<part>; the dedicated server carries none of it.
 *
 * Artwork is The Indie Stone's, used here to draw the same body the player
 * already reads in game. Masks only: every pixel is white, so the colour comes
 * from our own palette and none of the original shading survives.
 *
 * Coordinates are in the source canvas below; the component scales them.
 */
"""

TYPE = """export type BodySprite = {
    x: number;
    y: number;
    w: number;
    h: number;
    /** Centroid of the visible pixels, so a reading never lands in an L-shaped notch. */
    label: [number, number];
    /** Top-centre of the shape, where a wound pin hangs. */
    pin: [number, number];
    mask: string;
};

"""

if __name__ == '__main__':
    main()
