#!/usr/bin/env python3
"""Export flynncode icon PNG set and ICO.

Uses the detailed master for 64px+ and the simplified small-size master
below that, where fine heraldic detail would otherwise mush together.
"""
from pathlib import Path
from PIL import Image

DIR = Path(__file__).parent
DETAILED_MIN = 64
SIZES = [1024, 512, 256, 128, 64, 48, 32, 24, 16]

detailed = Image.open(DIR / "master-1024.png").convert("RGBA")
simplified = Image.open(DIR / "master-small-1024.png").convert("RGBA")

for size in SIZES:
    source = detailed if size >= DETAILED_MIN else simplified
    img = source if size == 1024 else source.resize((size, size), Image.LANCZOS)
    img.save(DIR / f"flynncode-{size}.png")

ico_source = detailed.resize((256, 256), Image.LANCZOS)
ico_source.save(
    DIR / "flynncode.ico",
    format="ICO",
    sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (24, 24), (16, 16)],
)
print("exported", ", ".join(f"{s}px" for s in SIZES), "+ flynncode.ico")
