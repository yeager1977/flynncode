#!/bin/bash
# Flynncode dev deb pipeline — runs in place (never /tmp: tmpfs writes hit EDQUOT).
set -x
cd /home/yeager1977/GitHub/flynncode/packages/desktop
export OPENCODE_CHANNEL=dev
export TMPDIR="$PWD/.buildtmp"
mkdir -p "$TMPDIR"

bun run build >>"$TMPDIR/build-package.log" 2>&1 || { echo "BUILD FAILED" >>"$TMPDIR/build-package.log"; exit 1; }

bun run package:linux --linux deb >>"$TMPDIR/build-package.log" 2>&1 || { echo "PACKAGE FAILED" >>"$TMPDIR/build-package.log"; exit 1; }

cp -f dist/flynncode-desktop-linux-amd64.deb /home/yeager1977/GitHub/flynncode/flynncode-desktop-linux-amd64.deb \
  || { echo "COPY FAILED" >>"$TMPDIR/build-package.log"; exit 1; }

echo "PIPELINE DONE" >>"$TMPDIR/build-package.log"