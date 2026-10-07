# Muse Auth Sync Script Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `~/.local/bin/muse-opencode-auth`, a stdlib-only Python script that copies the Muse subscription API key into opencode's auth and verifies it live.

**Architecture:** One self-contained executable file with pure functions (read/compare/install/verify) plus a thin CLI front (`sync` default, `--check`, `--self-test`). Tests run in-process via `--self-test` against temp-dir fixtures and a local stub HTTP server, so no network and no real credentials are ever touched.

**Tech Stack:** Python 3 stdlib only (`json`, `urllib`, `shutil`, `argparse`, `http.server` for tests, `tempfile`, `unittest`).

## Global Constraints

- Python 3 stdlib only. No third-party dependencies.
- The key is never printed and never passed as a CLI argument (file-to-file transfer inside Python).
- Backups are `auth.json.bak-<timestamp>` with original file permissions preserved.
- Exit `0` on success or already-in-sync; non-zero with a plain message otherwise.
- One login offer per run. If verification fails after a fresh login, say so explicitly instead of looping.
- Default paths (overridable ONLY via `--muse-auth` / `--opencode-auth` flags for testing, never for secrets): muse auth at `~/.config/muse/auth.json`, opencode auth at `~/.local/share/opencode/auth.json`.
- Verification endpoint: `GET https://api.meta.ai/v1/models`, success = HTTP 200.

---

## File Structure

One file created, zero repo files modified:

- Create: `/home/yeager1977/.local/bin/muse-opencode-auth` (executable, `#!/usr/bin/env python3`)

Internal units (all in that file, each with one responsibility):
- `read_muse_key(path) -> str | None` — returns `providers.meta.api_key` or `None` when absent/unparseable.
- `read_opencode_key(path) -> str | None` — returns the `meta` entry's `key` or `None`.
- `install_key(opencode_path, key) -> backup_path` — timestamped backup preserving permissions, then replaces ONLY the `meta` entry with `{"type": "api", "key": key}`, preserving all other providers.
- `restore_backup(opencode_path, backup_path) -> None` — puts the backup back (used when verification fails).
- `verify_key(key, base_url) -> bool` — `GET <base_url>/models` with Bearer auth, `True` on HTTP 200, `False` on anything else (network error, non-200). 30s timeout.
- `main(argv) -> int` — CLI front: default sync flow, `--check` verify-only mode, `--self-test` test runner, `--muse-auth` / `--opencode-auth` path overrides, `--api-base` override for tests.

---

### Task 1: Read/compare/install core + self-test harness

**Files:**
- Create: `/home/yeager1977/.local/bin/muse-opencode-auth`
- Test: in-file `--self-test` (no separate test file — single-file deliverable)

**Interfaces:**
- Consumes: nothing
- Produces (used by Tasks 2–3, exact signatures):
  - `read_muse_key(path: str) -> str | None`
  - `read_opencode_key(path: str) -> str | None`
  - `install_key(opencode_path: str, key: str) -> str` (returns backup path)
  - `restore_backup(opencode_path: str, backup_path: str) -> None`

- [ ] **Step 1: Write the failing test**

Add to the script a `test_read_install()` function and a `--self-test` entry point stub. The test uses `tempfile.TemporaryDirectory` fixtures only:

```python
def test_read_install():
    import tempfile, os, json
    with tempfile.TemporaryDirectory() as d:
        muse = os.path.join(d, "muse.json")
        json.dump({"providers": {"meta": {"api_key": "LLM|test-key" * 4}}}, open(muse, "w"))
        assert read_muse_key(muse) == "LLM|test-key" * 4
        assert read_muse_key(os.path.join(d, "missing.json")) is None
        json.dump({"other": {"type": "oauth"}}, open(muse, "w"))
        assert read_muse_key(muse) is None

        oc = os.path.join(d, "auth.json")
        json.dump({"meta": {"type": "api", "key": "OLD"}, "other": {"type": "oauth"}}, open(oc, "w"))
        assert read_opencode_key(oc) == "OLD"
        backup = install_key(oc, "NEW")
        assert read_opencode_key(oc) == "NEW"
        assert json.load(open(oc))["other"] == {"type": "oauth"}
        restore_backup(oc, backup)
        assert read_opencode_key(oc) == "OLD"
```

Wire `--self-test` to run it:

```python
if __name__ == "__main__":
    import sys
    if "--self-test" in sys.argv:
        test_read_install()
        print("self-test: PASS")
    else:
        sys.exit("not implemented")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `/home/yeager1977/.local/bin/muse-opencode-auth --self-test`
Expected: FAIL with `NameError: name 'read_muse_key' is not defined`

- [ ] **Step 3: Write minimal implementation**

```python
#!/usr/bin/env python3
"""Sync the Muse subscription API key into opencode's auth file."""
import json
import os
import shutil
import datetime


def read_muse_key(path):
    try:
        with open(path) as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    providers = data.get("providers")
    if not isinstance(providers, dict):
        return None
    meta = providers.get("meta")
    if not isinstance(meta, dict):
        return None
    key = meta.get("api_key")
    return key if isinstance(key, str) and key else None


def read_opencode_key(path):
    try:
        with open(path) as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    meta = data.get("meta")
    if not isinstance(meta, dict):
        return None
    key = meta.get("key")
    return key if isinstance(key, str) and key else None


def install_key(opencode_path, key):
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_path = opencode_path + ".bak-" + stamp
    shutil.copy2(opencode_path, backup_path)
    with open(opencode_path) as f:
        data = json.load(f)
    data["meta"] = {"type": "api", "key": key}
    with open(opencode_path, "w") as f:
        json.dump(data, f, indent=2)
    return backup_path


def restore_backup(opencode_path, backup_path):
    shutil.copy2(backup_path, opencode_path)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `/home/yeager1977/.local/bin/muse-opencode-auth --self-test`
Expected: PASS with `self-test: PASS`

- [ ] **Step 5: Make executable and smoke-test the stub**

Run: `chmod +x /home/yeager1977/.local/bin/muse-opencode-auth && /home/yeager1977/.local/bin/muse-opencode-auth`
Expected: prints `not implemented`, exit non-zero, and NO file outside `/tmp` was touched

---

### Task 2: Verify + sync flow + --check mode

**Files:**
- Modify: `/home/yeager1977/.local/bin/muse-opencode-auth`
- Test: extend in-file `--self-test` (same file)

**Interfaces:**
- Consumes (from Task 1, exact signatures): `read_muse_key`, `read_opencode_key`, `install_key`, `restore_backup`
- Produces (used by Task 3):
  - `verify_key(key: str, base_url: str) -> bool`
  - `sync(muse_path: str, opencode_path: str, base_url: str) -> int` returning process exit code; prints only key length + 4-char prefix, never the key

- [ ] **Step 1: Write the failing test**

Append `test_verify_and_sync()` exercising a local stub HTTP server (no external network) plus fixture files:

```python
def test_verify_and_sync():
    import tempfile, os, json, threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    seen = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            seen["auth"] = self.headers.get("Authorization")
            body = b'{"data": [{"id": "muse-spark-1.3-contributor"}]}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d" % server.server_port
    try:
        assert verify_key("GOODKEY", base) is True
        assert seen["auth"] == "Bearer GOODKEY"
        assert verify_key("x", "http://127.0.0.1:1") is False

        with tempfile.TemporaryDirectory() as d:
            muse = os.path.join(d, "muse.json")
            oc = os.path.join(d, "auth.json")
            json.dump({"providers": {"meta": {"api_key": "K" * 48}}}, open(muse, "w"))
            json.dump({"meta": {"type": "api", "key": "K" * 48}}, open(oc, "w"))
            assert sync(muse, oc, base) == 0  # already in sync, key verified live
            assert read_opencode_key(oc) == "K" * 48
            json.dump({"meta": {"type": "api", "key": "OLD"}}, open(oc, "w"))
            assert sync(muse, oc, base) == 0  # differs -> install + verify
            assert read_opencode_key(oc) == "K" * 48
    finally:
        server.shutdown()
```

Call it from the `--self-test` runner next to `test_read_install()`.

- [ ] **Step 2: Run test to verify it fails**

Run: `/home/yeager1977/.local/bin/muse-opencode-auth --self-test`
Expected: FAIL with `NameError: name 'verify_key' is not defined`

- [ ] **Step 3: Write minimal implementation**

```python
import urllib.request


def verify_key(key, base_url):
    req = urllib.request.Request(
        base_url.rstrip("/") + "/models",
        headers={"Authorization": "Bearer " + key},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status == 200
    except Exception:
        return False


def key_label(key):
    return "%s...len%d" % (key[:4], len(key))


def sync(muse_path, opencode_path, base_url):
    muse_key = read_muse_key(muse_path)
    if not muse_key:
        print("No usable Muse credential found.")
        return 2
    current = read_opencode_key(opencode_path)
    if current == muse_key:
        if verify_key(muse_key, base_url):
            print("Already in sync (%s), key verified live." % key_label(muse_key))
            return 0
        print("Keys match but the key failed verification.")
        return 3
    backup = install_key(opencode_path, muse_key)
    if verify_key(muse_key, base_url):
        print("Synced new key (%s), verified live. Backup: %s" % (key_label(muse_key), backup))
        return 0
    restore_backup(opencode_path, backup)
    print("New key failed verification; restored backup: %s" % backup)
    return 3
```

Exit-code contract (also used by Task 3): `0` = success/in-sync, `2` = no Muse credential, `3` = verification failed.

- [ ] **Step 4: Run test to verify it passes**

Run: `/home/yeager1977/.local/bin/muse-opencode-auth --self-test`
Expected: PASS (both test functions, `self-test: PASS`)

- [ ] **Step 5: Verify `--check` wiring stub still parses**

Run: `/home/yeager1977/.local/bin/muse-opencode-auth --check`
Expected: non-zero exit, prints `not implemented` (full `--check` lands in Task 3)

---

### Task 3: CLI front, login offer, --check mode

**Files:**
- Modify: `/home/yeager1977/.local/bin/muse-opencode-auth`
- Test: in-file `--self-test` additions for the login-offer decision function only (the interactive prompt itself is verified manually)

**Interfaces:**
- Consumes (exact): `sync(muse_path, opencode_path, base_url) -> int` with exit codes `0`/`2`/`3`; default paths `~/.config/muse/auth.json` and `~/.local/share/opencode/auth.json`; verification base `https://api.meta.ai/v1`
- Produces: final CLI — `muse-opencode-auth [--check] [--muse-auth PATH] [--opencode-auth PATH] [--api-base URL]`

- [ ] **Step 1: Write the failing test**

Add a pure decision helper so the interactive branch is testable without stdin:

```python
def test_should_offer_login():
    assert should_offer_login(exit_code=2, already_offered=False) is True
    assert should_offer_login(exit_code=3, already_offered=False) is True
    assert should_offer_login(exit_code=0, already_offered=False) is False
    assert should_offer_login(exit_code=2, already_offered=True) is False
```

with the stub:

```python
def should_offer_login(exit_code, already_offered):
    raise NotImplementedError
```

Call it from the `--self-test` runner.

- [ ] **Step 2: Run test to verify it fails**

Run: `/home/yeager1977/.local/bin/muse-opencode-auth --self-test`
Expected: FAIL with `NotImplementedError`

- [ ] **Step 3: Write minimal implementation**

```python
import argparse
import subprocess
import sys


def should_offer_login(exit_code, already_offered):
    return exit_code in (2, 3) and not already_offered


def ask_launch_login():
    try:
        answer = input("No usable Muse credential. Launch `muse login` now? [Y/n] ").strip().lower()
    except EOFError:
        return False
    return answer in ("", "y", "yes")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Sync the Muse subscription API key into opencode's auth.")
    parser.add_argument("--check", action="store_true", help="verify only; change nothing")
    parser.add_argument("--muse-auth", default=os.path.expanduser("~/.config/muse/auth.json"))
    parser.add_argument("--opencode-auth", default=os.path.expanduser("~/.local/share/opencode/auth.json"))
    parser.add_argument("--api-base", default="https://api.meta.ai/v1")
    args = parser.parse_args(argv)

    if args.check:
        muse_key = read_muse_key(args.muse_auth)
        current = read_opencode_key(args.opencode_auth)
        if muse_key and current == muse_key and verify_key(muse_key, args.api_base):
            print("OK: keys match (%s), key verified live." % key_label(muse_key))
            return 0
        print("NOT IN SYNC: run without --check to sync.")
        return 1

    offered = False
    while True:
        code = sync(args.muse_auth, args.opencode_auth, args.api_base)
        if code == 0:
            return 0
        if not should_offer_login(code, offered):
            return code
        offered = True
        if not ask_launch_login():
            print("Deferred. Run `muse login`, then re-run this script.")
            return code
        result = subprocess.run(["muse", "login"])
        if result.returncode != 0:
            print("`muse login` did not complete.")
            return code
```

and replace the `__main__` block with:

```python
if __name__ == "__main__":
    if "--self-test" in sys.argv:
        test_read_install()
        test_verify_and_sync()
        test_should_offer_login()
        print("self-test: PASS")
    else:
        sys.exit(main())
```

Note the loop terminates: `offered` flips after the first offer, so at most one login launch per run; a post-login verification failure returns code 3 with the "fresh key failed" message from `sync()` instead of looping.

- [ ] **Step 4: Run test to verify it passes**

Run: `/home/yeager1977/.local/bin/muse-opencode-auth --self-test`
Expected: PASS with `self-test: PASS`

- [ ] **Step 5: Manual end-to-end verification (real paths, no secret exposure)**

Run: `/home/yeager1977/.local/bin/muse-opencode-auth --check`
Expected: exit `0`, prints `OK: keys match (LLM|...len48), key verified live.` (opencode already holds the subscription key from the manual sync; nothing is modified — confirm `ls -la ~/.local/share/opencode/auth.json*` shows no new backup file)

Run: `/home/yeager1977/.local/bin/muse-opencode-auth`
Expected: exit `0`, prints `Already in sync (LLM|...len48), key verified live.`

## Self-Review

**1. Spec coverage:**
- Script identity/contract (path, stdlib-only, exit codes, secret hygiene, backup naming) → Tasks 1–3 setup steps.
- Sync flow steps 1–4 (read → compare → backup+replace preserving providers → verify → report prefix-only) → Tasks 1–2.
- Logged-out flow (ask Y/n, foreground `muse login`, resume, one offer per run, explicit post-login failure) → Task 3.
- `--check` mode → Task 3.
- Out-of-scope items (no scheduling, no OAuth plugin, no access_token sync, no repo hosting) → honored by omission; no task touches them.

**2. Placeholder scan:** no TBD/TODO; every step has exact code, exact commands, exact expected outputs. The `--muse-auth`/`--opencode-auth`/`--api-base` flags are test seams, not placeholders.

**3. Type consistency:** `read_muse_key(path) -> str | None`, `read_opencode_key(path) -> str | None`, `install_key(opencode_path, key) -> str`, `restore_backup(opencode_path, backup_path) -> None`, `verify_key(key, base_url) -> bool`, `sync(muse_path, opencode_path, base_url) -> int`, `should_offer_login(exit_code, already_offered) -> bool` — identical in every task that references them. Exit codes `0`/`2`/`3` consistent across Tasks 2–3.

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-10-06-muse-auth-sync.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
