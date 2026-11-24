#!/usr/bin/env python3
"""9router host runner daemon.

Watches a shared `in` directory for JSON requests written by the in-container
MCP plugin, validates them against an operator-owned whitelist, executes only
whitelisted argv on the HOST, and atomically publishes results to a read-only
`out` mount. No shell, no agent-supplied environment, no arbitrary commands.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# A whitelist edit arrives as its own message type rather than as a job: it must
# never be possible for a job request to double as a config change, and it is
# authenticated separately (see verify_config_mac).
CONFIG_SUFFIX = ".config.json"
SNAPSHOT_NAME = "config.snapshot.json"

# PBKDF2 cost for the dashboard-password-derived key. Matches the JS side
# (crypto.pbkdf2Sync) exactly — changing one side without the other makes every
# save fail with "password does not match".
PBKDF2_ITERATIONS = 600_000
KEY_LEN = 32

# A signed message is only honoured for a short window so a captured one cannot
# be replayed long after the operator moved on.
CONFIG_MAX_AGE_SEC = 300

# Throttles password guessing through this channel. A token bucket rather than
# a lockout: an agent spamming `in/` can spend the tokens, but they refill, so
# the operator waits seconds instead of being locked out for a window.
CONFIG_BURST = 8
CONFIG_REFILL_PER_SEC = 0.5

DEFAULT_ENV_ALLOWLIST = [
    "PATH", "HOME", "DISPLAY", "XAUTHORITY", "LANG", "LC_ALL", "TZ",
    "PLAYWRIGHT_BROWSERS_PATH", "COMPOSER_HOME",
]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_config(data) -> dict:
    """Validate a whitelist object.

    Raises `ValueError` rather than exiting: a bad *file* must stop the daemon
    (fail closed), but a bad *request* must only be rejected, or an agent could
    kill the runner by submitting nonsense.
    """
    if not isinstance(data, dict):
        raise ValueError("config must be a JSON object")

    tools = data.get("tools")
    if not isinstance(tools, dict) or not tools:
        raise ValueError("config needs a non-empty `tools` object")
    for name, tool in tools.items():
        if not isinstance(tool, dict) or not isinstance(tool.get("argv"), list) or not tool["argv"]:
            raise ValueError(f"tool {name!r} needs a non-empty argv array")
        if any(not isinstance(a, str) or "\0" in a for a in tool["argv"]):
            raise ValueError(f"tool {name!r} has an invalid argv entry")

    roots = data.get("allowedRoots") or []
    if not isinstance(roots, list) or not roots:
        raise ValueError("config needs a non-empty allowedRoots array")
    roots = [os.path.realpath(os.path.expanduser(str(r))) for r in roots]

    # Unknown top-level keys are carried through: the dashboard round-trips the
    # whole file, and dropping fields an operator added by hand would silently
    # delete them on the next save.
    config = {
        **data,
        "tools": tools,
        "allowedRoots": roots,
        "envAllowlist": [str(k) for k in data.get("envAllowlist", DEFAULT_ENV_ALLOWLIST)],
        "maxOutputBytes": int(data.get("maxOutputBytes", 200_000)),
        "maxTailBytes": int(data.get("maxTailBytes", 16_000)),
        "defaultTimeoutMs": int(data.get("defaultTimeoutMs", 900_000)),
        "maxTimeoutMs": int(data.get("maxTimeoutMs", 3_600_000)),
        "maxConcurrent": max(1, int(data.get("maxConcurrent", 1))),
        # Executor queue is bounded too: a misbehaving agent can fill the
        # volume, but it cannot make the daemon hold unlimited futures in RAM.
        "maxPending": max(1, int(data.get("maxPending", 50))),
        "pollMs": max(50, int(data.get("pollMs", 250))),
        "auditFile": data.get("auditFile"),
    }
    return config


def load_config(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise SystemExit(f"[hostrunner] cannot read config {path}: {exc}") from exc
    try:
        return parse_config(data)
    except (ValueError, TypeError) as exc:
        raise SystemExit(f"[hostrunner] invalid config {path}: {exc}") from exc


def is_inside(path: str, root: str) -> bool:
    try:
        return os.path.commonpath([path, root]) == root
    except ValueError:
        return False


def validate_request(request, config: dict) -> dict:
    if not isinstance(request, dict):
        raise ValueError("request must be an object")

    job_id = request.get("id")
    if not isinstance(job_id, str) or not ID_RE.match(job_id):
        raise ValueError("invalid job id")

    tool_name = request.get("tool")
    if not isinstance(tool_name, str) or tool_name not in config["tools"]:
        raise ValueError(f"tool {tool_name!r} is not whitelisted")
    tool = config["tools"][tool_name]

    cwd = request.get("cwd")
    if not isinstance(cwd, str) or not os.path.isabs(cwd):
        raise ValueError("cwd must be an absolute path")
    real_cwd = os.path.realpath(cwd)
    roots = [os.path.realpath(os.path.expanduser(str(r))) for r in tool.get("allowedCwd", config["allowedRoots"])]
    if not any(is_inside(real_cwd, root) for root in roots):
        raise ValueError(f"cwd {cwd!r} is outside allowedRoots")

    extra_args = request.get("args", [])
    if not isinstance(extra_args, list) or any(
        not isinstance(a, str) or "\0" in a or len(a) > 8192 for a in extra_args
    ):
        raise ValueError("args must be an array of strings")
    # A tool whose behaviour is fully described by its fixed argv (a script that
    # seeds fixtures and cleans up after itself) must not grow a second input
    # channel: extra argv is where "run this one script" quietly turns into
    # "run anything the script will forward".
    if tool.get("allowArgs") is False and extra_args:
        raise ValueError(f"tool {tool_name!r} accepts a fixed command only — no arguments")
    pattern = tool.get("argPattern")
    if pattern:
        for value in extra_args:
            if not re.search(pattern, value):
                raise ValueError(f"argument {value!r} does not match tool argPattern")

    timeout_ms = request.get("timeoutMs", tool.get("timeoutMs", config["defaultTimeoutMs"]))
    try:
        timeout_ms = int(timeout_ms)
    except (TypeError, ValueError) as exc:
        raise ValueError("timeoutMs must be an integer") from exc
    upper = int(tool.get("maxTimeoutMs", config["maxTimeoutMs"]))
    timeout_ms = max(1_000, min(timeout_ms, upper))

    requester = request.get("requester", "acp-agent")
    if not isinstance(requester, str):
        requester = "acp-agent"

    return {
        "id": job_id,
        "tool": tool_name,
        "cwd": real_cwd,
        "argv": list(tool["argv"]) + list(extra_args),
        "timeoutMs": timeout_ms,
        "requester": requester[:200],
    }


def write_json_atomic(directory: Path, basename: str, payload: dict) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    tmp = directory / f".{basename}.{os.getpid()}.{threading.get_ident()}.tmp"
    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, directory / basename)


def audit(config: dict, entry: dict) -> None:
    if not config["auditFile"]:
        return
    path = Path(os.path.expanduser(str(config["auditFile"])))
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({"ts": now_iso(), **entry}, ensure_ascii=False) + "\n")


class ConfigHolder:
    """The live whitelist, swappable without restarting job threads.

    A save has to affect the *next* job — that is the entire point of letting
    the dashboard edit this file — while a job already running keeps the config
    it started with, so its argv cannot change under it mid-flight.
    """

    def __init__(self, config: dict) -> None:
        self._config = config
        self._lock = threading.Lock()

    def get(self) -> dict:
        with self._lock:
            return self._config

    def set(self, config: dict) -> None:
        with self._lock:
            self._config = config


class TokenBucket:
    """Burst-then-steady throttle for password guesses.

    A plain lockout would be worse than useless here: anything that can write
    `in/` could burn the whole budget and freeze the operator out. Tokens
    refill, so the worst case is a short wait rather than a lockout.
    """

    def __init__(self, burst: int, refill_per_sec: float) -> None:
        self._burst = float(burst)
        self._refill = refill_per_sec
        self._tokens = float(burst)
        self._updated = time.monotonic()
        self._lock = threading.Lock()

    def take(self) -> bool:
        with self._lock:
            now = time.monotonic()
            self._tokens = min(self._burst, self._tokens + (now - self._updated) * self._refill)
            self._updated = now
            if self._tokens < 1.0:
                return False
            self._tokens -= 1.0
            return True


def load_auth(path: Path) -> dict | None:
    """Read the host-only key material the edit channel is authenticated with.

    Absent or malformed returns None rather than raising: "not provisioned yet"
    is a normal state where the daemon still runs jobs, it just refuses edits.
    """
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    salt, key_hex = data.get("salt"), data.get("key")
    if not isinstance(salt, str) or not salt or not isinstance(key_hex, str):
        return None
    try:
        key = bytes.fromhex(key_hex)
    except ValueError:
        return None
    if len(key) != KEY_LEN:
        return None
    return {"salt": salt, "key": key}


def derive_key(password: str, salt: str) -> bytes:
    """Must stay byte-identical to crypto.pbkdf2Sync(pw, salt, 600000, 32, 'sha256')."""
    return hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), PBKDF2_ITERATIONS
    )


def config_mac(key: bytes, ts: int, config_text: str) -> str:
    # MAC the exact bytes that were sent. Re-serialising on either side would
    # invite a disagreement about key order, indentation or number formatting
    # that surfaces as "password does not match".
    return hmac.new(key, f"{ts}\n{config_text}".encode("utf-8"), hashlib.sha256).hexdigest()


def write_config_file(path: Path, config: dict) -> None:
    """Persist the whitelist atomically, pretty-printed for hand editing."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    tmp.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def file_mtime(path: Path) -> int | None:
    try:
        return path.stat().st_mtime_ns
    except OSError:
        return None


def publish_snapshot(out_dir: Path, config: dict, auth: dict | None, config_path: Path) -> None:
    """Publish the whitelist where the container can read it.

    `out` is mounted read-only for the container, so this is the dashboard's
    only view of the file and the only way the salt can be handed out. The salt
    is not secret; the key derived from the password never leaves the host.
    """
    write_json_atomic(out_dir, SNAPSHOT_NAME, {
        "kind": "config_snapshot",
        "publishedAt": now_iso(),
        "configPath": str(config_path),
        "authConfigured": auth is not None,
        "salt": auth["salt"] if auth else None,
        "config": config,
    })


def handle_config_message(
    claim: Path,
    *,
    config_path: Path,
    auth_path: Path,
    out_dir: Path,
    bucket: TokenBucket,
    holder: ConfigHolder,
) -> None:
    """Apply one password-authenticated whitelist edit.

    The invariant: a message in `in/` is treated exactly as if the operator's
    browser wrote it, because nothing distinguishes them — same container, same
    uid. So the only thing standing between an agent and the whitelist is the
    MAC, which needs a password-derived key that exists solely on the host.
    Cheap checks run first so an agent cannot make the daemon spend PBKDF2 on
    demand.
    """
    try:
        message = json.loads(claim.read_text(encoding="utf-8"))
    except Exception:
        claim.unlink(missing_ok=True)
        return

    msg_id = message.get("id") if isinstance(message, dict) else None
    if not (isinstance(msg_id, str) and ID_RE.match(msg_id)):
        claim.unlink(missing_ok=True)
        return

    def reject(code: str, error: str) -> None:
        publish_result(out_dir, msg_id, {
            "id": msg_id,
            "status": "rejected",
            "code": code,
            "error": error,
            "exitCode": None,
            "durationMs": 0,
            "stdoutTail": "",
            "stderrTail": "",
        })
        audit(holder.get(), {"id": msg_id, "kind": "config", "status": "rejected",
                             "code": code, "error": error})

    # Consume the claim before anything that can fail: a message left in
    # `.processing/` would be retried forever.
    claim.unlink(missing_ok=True)

    try:
        if not bucket.take():
            reject("rate_limited", "too many config attempts — wait a few seconds and save again")
            return

        auth = load_auth(auth_path)
        if auth is None:
            reject("auth_not_configured",
                   "host key material is missing — run `hostrunner-ctl set-password` on the host once")
            return

        ts = message.get("ts")
        if not isinstance(ts, int) or isinstance(ts, bool) or abs(int(time.time()) - ts) > CONFIG_MAX_AGE_SEC:
            reject("stale_timestamp",
                   f"signed message is older than {CONFIG_MAX_AGE_SEC}s — reload and save again")
            return

        # Distinguishes "this page loaded before set-password ran" from a wrong
        # password, so the UI can say which of the two it is.
        if message.get("salt") != auth["salt"]:
            reject("stale_snapshot",
                   "the host key changed since this page loaded — reload and save again")
            return

        config_text = message.get("configText")
        if not isinstance(config_text, str) or not config_text or len(config_text) > 4_000_000:
            reject("bad_request", "configText is missing or too large")
            return

        mac = message.get("mac")
        if not isinstance(mac, str) or not hmac.compare_digest(mac, config_mac(auth["key"], ts, config_text)):
            reject("bad_mac", "the dashboard password does not match (or the message was tampered with)")
            return

        try:
            new_config = parse_config(json.loads(config_text))
        except (ValueError, TypeError) as exc:
            reject("invalid_config", str(exc))
            return

        try:
            write_config_file(config_path, new_config)
        except Exception as exc:
            reject("write_failed", f"cannot write {config_path}: {exc}")
            return
    except Exception as exc:  # never let an edit take the daemon down
        reject("internal_error", str(exc))
        return

    holder.set(new_config)
    publish_snapshot(out_dir, new_config, auth, config_path)
    audit(new_config, {
        "id": msg_id,
        "kind": "config",
        "status": "ok",
        "tools": sorted(new_config["tools"]),
        "allowedRoots": new_config["allowedRoots"],
    })
    publish_result(out_dir, msg_id, {
        "id": msg_id,
        "status": "ok",
        "configPath": str(config_path),
        "config": new_config,
        "exitCode": 0,
        "durationMs": 0,
        "stdoutTail": "",
        "stderrTail": "",
    })


def cancel_requested(in_dir: Path, job_id: str) -> bool:
    return (in_dir / f"{job_id}.cancel.json").exists()


def clear_cancel(in_dir: Path, job_id: str) -> None:
    """Drop a consumed/stale cancel marker so a reused id cannot cancel silently."""
    try:
        (in_dir / f"{job_id}.cancel.json").unlink()
    except FileNotFoundError:
        pass


def kill_process_group(proc: subprocess.Popen) -> None:
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            proc.terminate()
        except OSError:
            pass
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                proc.kill()
            except OSError:
                pass


def tail_bytes(chunks: list[bytes], limit: int) -> str:
    data = b"".join(chunks)
    return data[-limit:].decode("utf-8", errors="replace") if limit > 0 else ""


def build_env(config: dict, tool: dict) -> dict:
    env = {key: os.environ[key] for key in config["envAllowlist"] if key in os.environ}
    for key, value in (tool.get("env") or {}).items():
        env[str(key)] = str(value)
    return env


def publish_result(out_dir: Path, job_id: str, payload: dict) -> None:
    write_json_atomic(out_dir, f"{job_id}.json", payload)
    # The terminal answer supersedes the live marker; drop it so a status read
    # can never surface a stale `running` next to a finished job.
    try:
        (out_dir / f"{job_id}.state.json").unlink()
    except FileNotFoundError:
        pass


def publish_state(out_dir: Path, job_id: str, payload: dict) -> None:
    """Live, non-terminal marker (`queued` / `running`).

    Kept in a separate `<id>.state.json` rather than `<id>.json` so a plugin
    that only knows the terminal file still waits for the real result instead
    of treating "running" as the answer.
    """
    write_json_atomic(out_dir, f"{job_id}.state.json", payload)


def read_job_id(claim: Path) -> str | None:
    try:
        data = json.loads(claim.read_text(encoding="utf-8"))
    except Exception:
        return None
    job_id = data.get("id") if isinstance(data, dict) else None
    return job_id if isinstance(job_id, str) and ID_RE.match(job_id) else None


def run_job(claim: Path, holder: ConfigHolder, in_dir: Path, out_dir: Path) -> None:
    # Freeze the config for the whole job: a concurrent whitelist edit must not
    # be able to change argv or timeouts halfway through a run.
    config = holder.get()
    try:
        request = json.loads(claim.read_text(encoding="utf-8"))
    except Exception as exc:
        claim.unlink(missing_ok=True)
        return

    job_id = request.get("id") if isinstance(request, dict) else None
    try:
        job = validate_request(request, config)
    except Exception as exc:
        if isinstance(job_id, str) and ID_RE.match(job_id):
            payload = {
                "id": job_id,
                "status": "rejected",
                "error": str(exc),
                "exitCode": None,
                "durationMs": 0,
                "stdoutTail": "",
                "stderrTail": "",
            }
            publish_result(out_dir, job_id, payload)
            audit(config, {"id": job_id, "tool": request.get("tool"), "status": "rejected", "error": str(exc)})
            clear_cancel(in_dir, job_id)
        claim.unlink(missing_ok=True)
        return

    tool = config["tools"][job["tool"]]
    env = build_env(config, tool)
    log_path = out_dir / f"{job_id}.log"
    stdout_chunks: list[bytes] = []
    stderr_chunks: list[bytes] = []
    lock = threading.Lock()
    written = {"total": 0}

    log_path.parent.mkdir(parents=True, exist_ok=True)
    # Publish the live marker and an empty log *before* spawning: an agent that
    # polls status/tail right after submit must see "running" and a readable
    # log file, not "unknown" and "no log yet".
    publish_state(out_dir, job_id, {
        "id": job_id,
        "status": "running",
        "tool": job["tool"],
        "cwd": job["cwd"],
        "argv": job["argv"],
        "startedAt": now_iso(),
        "requester": job["requester"],
    })
    log_path.touch(exist_ok=True)
    with log_path.open("wb") as log:

        def pump(stream, bucket: list[bytes]) -> None:
            # read1() returns whatever is already buffered; read() on a pipe
            # blocks until the full 4096 bytes arrive, which kept the log empty
            # for the whole run whenever the tool printed less than that.
            read = getattr(stream, "read1", None) or stream.read
            while True:
                chunk = read(4096)
                if not chunk:
                    break
                with lock:
                    bucket.append(chunk)
                    remaining = config["maxOutputBytes"] - written["total"]
                    if remaining > 0:
                        allowed = chunk[:remaining]
                        log.write(allowed)
                        log.flush()
                        written["total"] += len(allowed)

        started = time.monotonic()
        try:
            proc = subprocess.Popen(
                job["argv"],
                cwd=job["cwd"],
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                shell=False,
                start_new_session=True,
            )
        except Exception as exc:
            payload = {
                "id": job_id,
                "status": "failed",
                "error": f"spawn failed: {exc}",
                "tool": job["tool"],
                "cwd": job["cwd"],
                "argv": job["argv"],
                "exitCode": None,
                "durationMs": int((time.monotonic() - started) * 1000),
                "stdoutTail": "",
                "stderrTail": "",
                "logFile": str(log_path),
            }
            publish_result(out_dir, job_id, payload)
            audit(config, {"id": job_id, "tool": job["tool"], "status": "spawn_failed", "error": str(exc)})
            clear_cancel(in_dir, job_id)
            claim.unlink(missing_ok=True)
            return

        out_thread = threading.Thread(target=pump, args=(proc.stdout, stdout_chunks), daemon=True)
        err_thread = threading.Thread(target=pump, args=(proc.stderr, stderr_chunks), daemon=True)
        out_thread.start()
        err_thread.start()

        cancelled = False
        timed_out = False
        while proc.poll() is None:
            if cancel_requested(in_dir, job_id):
                cancelled = True
                kill_process_group(proc)
                break
            elapsed = (time.monotonic() - started) * 1000
            if elapsed >= job["timeoutMs"]:
                timed_out = True
                kill_process_group(proc)
                break
            time.sleep(config["pollMs"] / 1000)

        proc.wait()
        out_thread.join(timeout=5)
        err_thread.join(timeout=5)

        status = "cancelled" if cancelled else "timeout" if timed_out else ("ok" if proc.returncode == 0 else "failed")
        payload = {
            "id": job_id,
            "status": status,
            "tool": job["tool"],
            "cwd": job["cwd"],
            "argv": job["argv"],
            "exitCode": proc.returncode,
            "durationMs": int((time.monotonic() - started) * 1000),
            "stdoutTail": tail_bytes(stdout_chunks, config["maxTailBytes"]),
            "stderrTail": tail_bytes(stderr_chunks, config["maxTailBytes"]),
            "logFile": str(log_path),
            "truncated": written["total"] >= config["maxOutputBytes"],
            "requester": job["requester"],
        }
        publish_result(out_dir, job_id, payload)
        clear_cancel(in_dir, job_id)
        audit(config, {
            "id": job_id,
            "tool": job["tool"],
            "cwd": job["cwd"],
            "requester": job["requester"],
            "status": status,
            "exitCode": proc.returncode,
            "durationMs": payload["durationMs"],
        })

    claim.unlink(missing_ok=True)


def claim_requests(in_dir: Path, processing_dir: Path, limit: int) -> list[Path]:
    """Move at most `limit` requests into `.processing/` and return them.

    The limit must apply to the *rename*, not to the returned list: claiming
    everything and then submitting a slice left the overflow parked in
    `.processing/` forever — never run, never resolved, reported as running.
    """
    claimed = []
    for path in sorted(in_dir.glob("*.request.json")):
        if len(claimed) >= limit:
            break
        destination = processing_dir / path.name
        try:
            os.replace(path, destination)
            claimed.append(destination)
        except FileNotFoundError:
            # Another daemon or a rename race got there first.
            continue
    return claimed


def claim_config_messages(in_dir: Path, processing_dir: Path, limit: int = 8) -> list[Path]:
    """Move whitelist-edit messages into `.processing/`.

    Kept separate from claim_requests so edits are still accepted while the job
    queue is full — otherwise an agent keeping the queue busy could stop the
    operator from saving.
    """
    claimed = []
    for path in sorted(in_dir.glob(f"*{CONFIG_SUFFIX}")):
        if len(claimed) >= limit:
            break
        destination = processing_dir / path.name
        try:
            os.replace(path, destination)
            claimed.append(destination)
        except FileNotFoundError:
            continue
    return claimed


def log_future_failure(future) -> None:
    exc = future.exception()
    if exc is not None:
        print(f"[hostrunner] config handler failed: {exc}", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="9router host command runner")
    # The whitelist and the key material sit outside every container mount on
    # purpose: agents share the container with the dashboard, so anything
    # visible in there is writable by them.
    parser.add_argument("--config", default=str(Path.home() / ".9r-host-runner" / "tools.json"))
    parser.add_argument("--auth", default=os.environ.get(
        "HOST_RUNNER_AUTH_FILE", str(Path.home() / ".9r-host-runner" / "auth.json")))
    parser.add_argument("--in", dest="in_dir", default=os.environ.get("HOST_RUNNER_IN_DIR", "/home/maxim/.9r-host-runner/in"))
    parser.add_argument("--out", dest="out_dir", default=os.environ.get("HOST_RUNNER_OUT_DIR", "/home/maxim/.9r-host-runner/out"))
    args = parser.parse_args()

    config_path = Path(args.config).expanduser()
    auth_path = Path(args.auth).expanduser()
    config = load_config(config_path)
    holder = ConfigHolder(config)
    in_dir = Path(args.in_dir).expanduser().resolve()
    out_dir = Path(args.out_dir).expanduser().resolve()
    processing_dir = in_dir / ".processing"
    for directory in (in_dir, out_dir, processing_dir):
        directory.mkdir(parents=True, exist_ok=True)

    auth = load_auth(auth_path)
    publish_snapshot(out_dir, config, auth, config_path)

    print(
        f"[hostrunner] watching {in_dir} → {out_dir} "
        f"(tools: {', '.join(config['tools'])}, maxConcurrent={config['maxConcurrent']}, "
        f"maxPending={config['maxPending']}, edits: "
        f"{'authenticated' if auth else 'disabled — run `hostrunner-ctl set-password`'})",
        flush=True,
    )

    bucket = TokenBucket(CONFIG_BURST, CONFIG_REFILL_PER_SEC)
    # Edits get their own single worker. Each one costs a PBKDF2 derivation, and
    # sharing the job pool would let an agent that can write `in/` starve real
    # test runs by flooding the queue with guesses.
    cfg_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="hostrunner-cfg")
    watched_mtime = file_mtime(config_path)
    pending = set()
    with ThreadPoolExecutor(max_workers=config["maxConcurrent"], thread_name_prefix="hostrunner") as pool:
        try:
            while True:
                current = holder.get()

                # A hand edit on the host has to count too, not only saves that
                # travelled through this daemon.
                mtime = file_mtime(config_path)
                if mtime != watched_mtime:
                    watched_mtime = mtime
                    try:
                        holder.set(load_config(config_path))
                    except SystemExit as exc:
                        print(f"[hostrunner] keeping previous config: {exc}", flush=True)
                    else:
                        publish_snapshot(out_dir, holder.get(), load_auth(auth_path), config_path)
                        print("[hostrunner] config reloaded", flush=True)

                pending = {future for future in pending if not future.done()}
                room = current["maxPending"] - len(pending)
                if room > 0:
                    for claim in claim_requests(in_dir, processing_dir, room):
                        claimed_id = read_job_id(claim)
                        if claimed_id:
                            publish_state(out_dir, claimed_id, {
                                "id": claimed_id,
                                "status": "queued",
                                "claimedAt": now_iso(),
                            })
                        pending.add(pool.submit(run_job, claim, holder, in_dir, out_dir))

                for claim in claim_config_messages(in_dir, processing_dir):
                    future = cfg_pool.submit(
                        handle_config_message, claim,
                        config_path=config_path, auth_path=auth_path,
                        out_dir=out_dir, bucket=bucket, holder=holder,
                    )
                    future.add_done_callback(log_future_failure)

                time.sleep(current["pollMs"] / 1000)
        except KeyboardInterrupt:
            print("[hostrunner] stopping", flush=True)
        finally:
            cfg_pool.shutdown(wait=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
