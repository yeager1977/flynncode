#!/usr/bin/env python3
"""Regenerate packages/desktop/icons/dev from the flynncode icon masters.

Run from the repo root:
    python3 icon/export-desktop-icons.py

The detailed 1024px master is used for 64px and up; the simplified master
(derived from the same source) is used below 64px so fine heraldic detail
does not mush together at small sizes. Requires Pillow and, for the macOS
.icns, the icnsutil package (see icon/README.md).
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / "packages" / "desktop" / "icons" / "dev"
DETAILED_MIN = 64

DETAILED = Image.open(ROOT / "icon" / "flynncode-1024.png").convert("RGBA")
SIMPLIFIED = Image.open(ROOT / "icon" / "flynncode-512.png").convert("RGBA")


def render(size: int) -> Image.Image:
    source = DETAILED if size >= DETAILED_MIN else SIMPLIFIED
    return source.resize((size, size), Image.LANCZOS)


SQUARES = {
    "32x32.png": 32,
    "64x64.png": 64,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "icon.png": 512,
    "dock.png": 256,
    "Square30x30Logo.png": 30,
    "Square44x44Logo.png": 44,
    "Square71x71Logo.png": 71,
    "Square89x89Logo.png": 89,
    "Square107x107Logo.png": 107,
    "Square142x142Logo.png": 142,
    "Square150x150Logo.png": 150,
    "Square284x284Logo.png": 284,
    "Square310x310Logo.png": 310,
    "StoreLogo.png": 50,
}

ANDROID = {
    "android/mipmap-mdpi/ic_launcher.png": 48,
    "android/mipmap-mdpi/ic_launcher_round.png": 48,
    "android/mipmap-mdpi/ic_launcher_foreground.png": 108,
    "android/mipmap-hdpi/ic_launcher.png": 72,
    "android/mipmap-hdpi/ic_launcher_round.png": 72,
    "android/mipmap-hdpi/ic_launcher_foreground.png": 162,
    "android/mipmap-xhdpi/ic_launcher.png": 96,
    "android/mipmap-xhdpi/ic_launcher_round.png": 96,
    "android/mipmap-xhdpi/ic_launcher_foreground.png": 216,
    "android/mipmap-xxhdpi/ic_launcher.png": 144,
    "android/mipmap-xxhdpi/ic_launcher_round.png": 144,
    "android/mipmap-xxhdpi/ic_launcher_foreground.png": 324,
    "android/mipmap-xxxhdpi/ic_launcher.png": 192,
    "android/mipmap-xxxhdpi/ic_launcher_round.png": 192,
    "android/mipmap-xxxhdpi/ic_launcher_foreground.png": 432,
}

IOS = {
    "ios/AppIcon-20x20@1x.png": 20,
    "ios/AppIcon-20x20@2x.png": 40,
    "ios/AppIcon-20x20@2x-1.png": 40,
    "ios/AppIcon-20x20@3x.png": 60,
    "ios/AppIcon-29x29@1x.png": 29,
    "ios/AppIcon-29x29@2x.png": 58,
    "ios/AppIcon-29x29@2x-1.png": 58,
    "ios/AppIcon-29x29@3x.png": 87,
    "ios/AppIcon-40x40@1x.png": 40,
    "ios/AppIcon-40x40@2x.png": 80,
    "ios/AppIcon-40x40@2x-1.png": 80,
    "ios/AppIcon-40x40@3x.png": 120,
    "ios/AppIcon-60x60@2x.png": 120,
    "ios/AppIcon-60x60@3x.png": 180,
    "ios/AppIcon-76x76@1x.png": 76,
    "ios/AppIcon-76x76@2x.png": 152,
    "ios/AppIcon-83.5x83.5@2x.png": 167,
    "ios/AppIcon-512@2x.png": 1024,
}


def main() -> None:
    for name, size in {**SQUARES, **ANDROID, **IOS}.items():
        render(size).save(DEST / name)

    ico = render(256)
    ico.save(
        DEST / "icon.ico",
        format="ICO",
        sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)],
    )

    print(f"Regenerated {len(SQUARES) + len(ANDROID) + len(IOS)} PNGs and icon.ico in {DEST}")
    print("Note: icon.icns is generated with icnsutil; see icon/README.md.")


if __name__ == "__main__":
    main()
