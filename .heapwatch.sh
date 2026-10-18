#!/bin/bash
OUT=/home/yeager1977/GitHub/flynncode/.heapwatch.csv
while true; do
  main=$(pgrep -f '^/opt/Flynncode Dev/ai.flynncode.desktop.dev$' | head -1)
  pid=""
  [ -n "$main" ] && for c in $(pgrep -P "$main" -f 'node.mojom.NodeService'); do pid=$c; break; done
  if [ -n "$pid" ]; then
    rss=$(ps -p "$pid" -o rss= | tr -d ' '); cpu=$(ps -p "$pid" -o %cpu= | tr -d ' ')
    echo "$(date +%H:%M:%S),$pid,$rss,$cpu" >> "$OUT"
  else
    echo "$(date +%H:%M:%S),none,0,0" >> "$OUT"
  fi
  sleep 30
done
