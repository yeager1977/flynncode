# Flynncode Icon Pipeline

Source masters live in this directory:

- `flynncode-icon.svg` — detailed master (heraldic detail for 64px and up)
- `flynncode-icon-small.svg` — simplified master (small sizes)
- `flynncode-1024.png` — raster of the detailed master
- `flynncode-512.png` — raster of the simplified master

## Regenerating assets

```bash
# 1. Re-export the master PNG set + ICO from the SVGs (if the SVGs changed)
python3 icon/export.py

# 2. Regenerate the desktop dev-channel icon set
python3 icon/export-desktop-icons.py
```

## macOS .icns

The Electron build uses `packages/desktop/icons/dev/icon.icns`. Generate it
with [icnsutil](https://pypi.org/project/icnsutil/):

```bash
python3 -m venv .icns-venv
.icns-venv/bin/pip install icnsutil
.icns-venv/bin/icnsutil compose packages/desktop/icons/dev/icon.icns \
  flynn-16.png flynn-32.png flynn-16@2x.png flynn-32@2x.png \
  flynn-128.png flynn-128@2x.png flynn-256.png flynn-256@2x.png \
  flynn-512.png flynn-1024.png
```

The `flynn-*.png` inputs are the `flynncode-*.png` masters named per their
pixel size (e.g. `flynncode-64.png` becomes `flynn-32@2x.png`).
