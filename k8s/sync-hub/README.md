# sync-hub — private Flynncode sync hub on Kubernetes

One-replica StatefulSet running the existing server image with
`SYNC_HUB_MODE=1`: it serves `/flynncode-sync/*` to paired spokes and never
pulls. Reachable only over the tailnet (Tailscale sidecar, ClusterIP, no
LoadBalancer/Ingress). Nightly SQLite snapshots go to object storage.

Files: `statefulset.yaml` (hub + Tailscale sidecar), `service.yaml`
(ClusterIP 4097), `pvc.yaml` (10Gi RWO), `secret.example.yaml` (placeholders
only), `backup-cronjob.yaml` (nightly snapshot, 7-day retention).

## Deploy

```bash
kubectl create namespace flynncode-sync
cp secret.example.yaml secret.yaml  # fill in real values; NEVER commit secret.yaml
kubectl -n flynncode-sync apply -f secret.yaml
kubectl -n flynncode-sync apply -f pvc.yaml,service.yaml,statefulset.yaml,backup-cronjob.yaml
```

Pin the image to a digest before trusting it (`ghcr.io/flynncode/flynncode:latest`
is a placeholder). The Tailscale auth key should be reusable and tagged so pod
restarts re-auth on their own; sidecar state is ephemeral by design.

Verify:

```bash
kubectl -n flynncode-sync rollout status statefulset/sync-hub
kubectl -n flynncode-sync exec sync-hub-0 -c tailscale -- tailscale status
kubectl -n flynncode-sync exec sync-hub-0 -c tailscale -- tailscale ip -4
# From a tailnet machine: curl the sync surface (unsigned -> 401 proves the
# handler is up; only HMAC-signed spoke requests get answers).
curl -s -o /dev/null -w '%{http_code}\n' http://<hub-tailnet-ip>:4097/flynncode-sync/manifest
# expect: 401
```

Probes are intentionally `tcpSocket`, not `httpGet` (waiver granted by
controller — keep tcpSocket): sync routes only answer
HMAC-signed requests (the pairing token never travels), so a kubelet httpGet
with a static Bearer header would 401 forever and the pod would never become
ready. The socket proves the server listens; sync health is observed via spoke
worker status.

## Pair a spoke

Each spoke keeps exactly one peer: the hub.

1. On the hub tailnet address, start pairing from the spoke (desktop Sync card
   or CLI): point the spoke at `http://<hub-tailnet-ip>:4097`.
2. Approve the pairing code on the hub side. The spoke stores the pairing
   token locally; the token itself never travels again — requests are HMAC
   signed, responses are signed back.
3. The spoke worker pulls hub-newer chats and pushes spoke-newer chats; either
   side may keep working offline and converges on reconnect.

To rotate a pairing, unpair from the spoke and pair again. Revoked tokens sign
their own "pair again" refusal, so a stale spoke learns it must re-pair.

## Snapshot restore

Snapshots are online `sqlite3 .backup` copies (`/data/opencode/opencode.db`),
uploaded nightly as `s3://<bucket>/sync-hub/<UTC-stamp>.db` with objects older
than 7 days pruned by the job. (A bucket lifecycle rule is the better
long-term retention control.)

```bash
# 1. Stop the hub so nothing writes during restore.
kubectl -n flynncode-sync scale statefulset/sync-hub --replicas=0
# 2. Copy a snapshot into the PVC via a temp pod and restore over the live path.
aws --endpoint-url <s3-endpoint> s3 cp s3://<bucket>/sync-hub/<STAMP>.db /tmp/restore.db
kubectl -n flynncode-sync run restore --image=alpine:3.21 --command -- sleep 600 \
  --overrides='{"spec":{"containers":[{"name":"restore","image":"alpine:3.21","command":["sleep","600"],"volumeMounts":[{"name":"data","mountPath":"/data"}]}],"volumes":[{"name":"data","persistentVolumeClaim":{"claimName":"sync-hub-data"}}]}}'
kubectl -n flynncode-sync cp /tmp/restore.db restore:/tmp/restore.db
kubectl -n flynncode-sync exec restore -- \
  sh -c 'apk add --no-cache sqlite >/dev/null && sqlite3 /data/opencode/opencode.db ".restore '"'"'/tmp/restore.db'"'"'"'
kubectl -n flynncode-sync delete pod restore
```

```bash
# 3. Start the hub again and confirm spokes reconverge.
kubectl -n flynncode-sync scale statefulset/sync-hub --replicas=1
kubectl -n flynncode-sync rollout status statefulset/sync-hub
```

Spokes treat the restored hub as hub-newer/hub-older per chat (`time_updated`
wins, equal does nothing), so a restore can resurrect deleted chats on spokes
that already converged past them — announce restores to spoke owners.

## Blind-relay note

The hub is a blind relay for secrets by default. Credential leaves in synced
config (`api_key`, `token`, `password`, …) are replaced with the
`__flynncode_sync_secret__` placeholder before they leave a spoke, so the hub
stores and forwards placeholders, never real credentials — each spoke keeps
its own secrets locally. Relay digests carry only metadata (session id,
directory, title); the relay publish route itself is bearer-gated
(`OPENCODE_RELAY_TOKEN`) and unreachable when the relay token is unset.
