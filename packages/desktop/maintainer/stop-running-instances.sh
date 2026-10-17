#!/bin/bash
# Installed as the deb/rpm preinst and prerm. Stop running Flynncode instances
# before their files are replaced or removed: an Electron browser process left
# alive across an upgrade later spawns children from the new binary and aborts
# (SIGTRAP) on the embedded version mismatch, so the app vanishes without a
# dialog. The app's SIGTERM handler stops its sidecar and quits, so this stays
# graceful; the wait is bounded so a hung instance cannot block packaging.
#
# Matches only /opt installs of any channel's binary (ai.flynncode.desktop,
# .dev, .beta), as a whole command-line word, so unpacked debug builds and
# unrelated processes are left alone.
pattern='/opt/.*/ai\.flynncode\.desktop(\.dev|\.beta)?( |$)'

pids=$(pgrep -f "$pattern")
[ -n "$pids" ] || exit 0

kill -TERM $pids 2>/dev/null

for _ in $(seq 1 30); do
  pgrep -f "$pattern" >/dev/null || exit 0
  sleep 0.5
done

pkill -KILL -f "$pattern" 2>/dev/null
exit 0