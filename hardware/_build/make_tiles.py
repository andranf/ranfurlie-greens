#!/usr/bin/env python3
"""Cut a georeferenced CirrusPRO image layer into web map tiles (z/x/y.webp, Web Mercator) for the hardware map.

Usage: python3 make_tiles.py <image> <out_dir> <west> <east> <north> <south> <zmin> <zmax> [quality]
Corners are the CirrusPRO RasterItem corners (the image is stretched linearly between them, like a Google Maps
ground overlay). Tiles only cover the image; WebP keeps the edges transparent so the Esri imagery shows past them.

  MetroMap Jan 2026 (CirrusPRO "Backdrop_MetroMap_Jan2026.jpg", 4500 x 3616, about 0.26 m/px):
    145.23794403075084 145.25110513465293 -38.11659685239458 -38.1249177320009   z14-19
  2000 irrigation as-built (CirrusPRO "Irrigation_asbuilt_2000_v3.png", 3289 x 2311, about 0.35 m/px):
    145.23795958625612 145.25110681155834 -38.11694297598153 -38.12420949834375  z15-19
"""
import math, os, sys
from PIL import Image

Image.MAX_IMAGE_PIXELS = None


def lon2x(lon, z): return (lon + 180) / 360 * 2 ** z * 256


def lat2y(lat, z):
    s = math.sin(math.radians(lat))
    return (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * 2 ** z * 256


def x2lon(x, z): return x / (2 ** z * 256) * 360 - 180


def y2lat(y, z):
    n = math.pi - 2 * math.pi * y / (2 ** z * 256)
    return math.degrees(math.atan(math.sinh(n)))


def main():
    src, out, w, e, n, s, zmin, zmax = sys.argv[1:9]
    q = int(sys.argv[9]) if len(sys.argv) > 9 else 72
    w, e, n, s = map(float, (w, e, n, s)); zmin, zmax = int(zmin), int(zmax)
    im = Image.open(src).convert("RGBA")
    W, H = im.size
    total = 0; size = 0
    for z in range(zmin, zmax + 1):
        tx0, tx1 = int(lon2x(w, z) // 256), int(lon2x(e, z) // 256)
        ty0, ty1 = int(lat2y(n, z) // 256), int(lat2y(s, z) // 256)
        for tx in range(tx0, tx1 + 1):
            for ty in range(ty0, ty1 + 1):
                tile = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
                # sample row by row in 16-px strips (latitude is not linear in Mercator; strips keep it exact to well under a pixel)
                for sy in range(0, 256, 16):
                    lat_t, lat_b = y2lat(ty * 256 + sy, z), y2lat(ty * 256 + sy + 16, z)
                    lon_l, lon_r = x2lon(tx * 256, z), x2lon(tx * 256 + 256, z)
                    # source pixel box
                    x0 = (lon_l - w) / (e - w) * W; x1 = (lon_r - w) / (e - w) * W
                    y0 = (lat_t - n) / (s - n) * H; y1 = (lat_b - n) / (s - n) * H
                    if x1 <= 0 or x0 >= W or y1 <= 0 or y0 >= H: continue
                    strip = im.transform((256, 16), Image.EXTENT, (x0, y0, x1, y1), Image.BICUBIC)
                    # blank anything that fell outside the source
                    if x0 < 0 or x1 > W or y0 < 0 or y1 > H:
                        m = Image.new("L", (256, 16), 0)
                        px0 = max(0, round((0 - x0) / (x1 - x0) * 256)); px1 = min(256, round((W - x0) / (x1 - x0) * 256))
                        py0 = max(0, round((0 - y0) / (y1 - y0) * 16)); py1 = min(16, round((H - y0) / (y1 - y0) * 16))
                        if px1 > px0 and py1 > py0: m.paste(255, (px0, py0, px1, py1))
                        r, g, b, a = strip.split(); a = Image.composite(a, Image.new("L", a.size, 0), m); strip = Image.merge("RGBA", (r, g, b, a))
                    tile.alpha_composite(strip, (0, sy))
                if tile.getbbox() is None: continue
                d = os.path.join(out, str(z), str(tx)); os.makedirs(d, exist_ok=True)
                p = os.path.join(d, f"{ty}.webp")
                tile.save(p, "WEBP", quality=q, method=6)
                total += 1; size += os.path.getsize(p)
        print(f"z{z}: tiles so far {total}, {size/1e6:.1f} MB")


if __name__ == "__main__":
    main()
