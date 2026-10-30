"""Render icon.svg's geometry into assets/icon-180.png and assets/icon-512.png.

The market only accepts a GitHub-hosted bitmap, so the vector icon is redrawn at
2x/4x scale with Pillow (no network, no font dependency).
"""
import math
import os

from PIL import Image, ImageDraw

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets")
OSAA = 4  # supersampling factor

# Same geometry as icon.svg (viewBox 0 0 24 24, stroke-width 1.7, round caps).
CIRCLES = [(12, 12, 3.2), (12, 4.2, 1.9), (5.1, 16.2, 1.9), (18.9, 16.2, 1.9)]
LINES = [((12, 6.1), (12, 8.8)), ((10.4, 13.8), (6.6, 15.3)), ((13.6, 13.8), (18.9, 15.3))]
STROKE = 1.7
FG = (37, 99, 235, 255)  # #2563eb, matches the panel's accent


def render(size: int, rounded: bool) -> Image.Image:
    scale = size * OSAA / 24
    img = Image.new("RGBA", (size * OSAA, size * OSAA), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    if rounded:
        draw.rounded_rectangle(
            [0, 0, size * OSAA - 1, size * OSAA - 1],
            radius=int(size * OSAA * 0.22),
            fill=(255, 255, 255, 255),
        )
    w = max(1, int(round(STROKE * scale)))
    # Draw spoke centre-to-centre, then punch each node's interior white and
    # stroke its ring on top. That clips the line at the ring; guessing an inset
    # collapses the two short spokes into stubs.
    for (x1, y1), (x2, y2) in LINES:
        draw.line([(x1 * scale, y1 * scale), (x2 * scale, y2 * scale)], fill=FG, width=w)
    for cx, cy, r in CIRCLES:
        inner = r - STROKE / 2
        if inner <= 0:
            continue
        draw.ellipse(
            [(cx - inner) * scale, (cy - inner) * scale, (cx + inner) * scale, (cy + inner) * scale],
            fill=(255, 255, 255, 255),
        )
    for cx, cy, r in CIRCLES:
        box = [(cx - r) * scale, (cy - r) * scale, (cx + r) * scale, (cy + r) * scale]
        draw.ellipse(box, outline=FG, width=w)
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in (180, 512):
        for rounded, suffix in ((True, ""), (False, "-transparent")):
            path = os.path.join(OUT_DIR, f"icon-{size}{suffix}.png")
            render(size, rounded).save(path, "PNG", optimize=True)
            print(path, os.path.getsize(path), "bytes")


if __name__ == "__main__":
    main()
