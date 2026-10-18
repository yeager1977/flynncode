#!/bin/bash
export OPENCODE_DB=/home/yeager1977/.local/share/opencode/leakdebug.db
export OPENCODE_AUTO_HEAP_SNAPSHOT=1
export NODE_OPTIONS=--inspect=0.0.0.0:9231
cd /home/yeager1977/GitHub/flynncode
exec /bin/node /home/yeager1977/GitHub/flynncode/.leak-load/sidecar-run.mjs >> /home/yeager1977/GitHub/flynncode/.leak-load/server.log 2>&1
