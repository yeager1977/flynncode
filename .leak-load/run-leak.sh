#!/bin/bash
cd /home/yeager1977/GitHub/flynncode
mkdir -p .leak-load
exec /home/yeager1977/.bun/bin/bun /home/yeager1977/GitHub/flynncode/.leak-load/load.mjs "$@" >> /home/yeager1977/GitHub/flynncode/.leak-load/load.log 2>&1
