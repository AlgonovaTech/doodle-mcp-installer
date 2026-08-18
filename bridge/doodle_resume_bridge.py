#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import hashlib
import http.server
import json
import os
import re
import secrets
import shlex
import shutil
import sqlite3
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import webbrowser
from dataclasses import dataclass
from pathlib import Path
from typing import Any

DEFAULT_BASE_URL = "https://mcp.algodoodle.me"
PROTOCOL_VERSION = "2026-07-28"
TASKS_EXTENSION = "io.modelcontextprotocol/tasks"
RUN_ID_RE = re.compile(r"^[A-Za-z0-9_-]{16,128}$")
DOODLE_TOOLS = {
    "mcp__doodle__talk_to_doodle",
    "mcp__doodle__consult_doodle",
    "talk_to_doodle",
    "consult_doodle",
}
TERMINAL_STATES = {"completed", "failed", "cancelled"}
HOOK_MARKER = "doodle-resume-bridge hook --client"
USER_AGENT = "doodle-resume-bridge/0.2.0"


def _ssl_context() -> ssl.SSLContext:
    system_ca = Path("/etc/ssl/cert.pem")
    if (
        sys.platform == "darwin"
        and ssl.get_default_verify_paths().cafile is None
        and system_ca.is_file()
    ):
        return ssl.create_default_context(cafile=str(system_ca))
    return ssl.create_default_context()


@dataclass(frozen=True)
class Registration:
    run_id: str
    client: str
    session_id: str
    cwd: str


def _bridge_home() -> Path:
    override = os.environ.get("DOODLE_RESUME_BRIDGE_HOME")
    return (
        Path(override).expanduser()
        if override
        else Path.home() / ".local/state/doodle-resume-bridge"
    )


class BridgeState:
    def __init__(self, path: Path | None = None):
        self.path = path or _bridge_home() / "state.sqlite3"
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.path.parent, 0o700)
        with self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS registrations (
                    run_id TEXT NOT NULL,
                    client TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    cwd TEXT NOT NULL,
                    state TEXT NOT NULL,
                    pid INTEGER,
                    last_error TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY (run_id, client, session_id)
                );
                CREATE TABLE IF NOT EXISTS oauth (
                    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                    client_id TEXT NOT NULL,
                    access_token TEXT NOT NULL,
                    refresh_token TEXT NOT NULL,
                    expires_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                """
            )
        os.chmod(self.path, 0o600)

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.path, timeout=10)

    def register(self, registration: Registration) -> bool:
        now = int(time.time())
        with self._connect() as conn:
            cursor = conn.execute(
                """INSERT OR IGNORE INTO registrations
                (run_id, client, session_id, cwd, state, created_at, updated_at)
                VALUES (?, ?, ?, ?, 'queued', ?, ?)""",
                (
                    registration.run_id,
                    registration.client,
                    registration.session_id,
                    registration.cwd,
                    now,
                    now,
                ),
            )
        return cursor.rowcount == 1

    def mark_listening(self, registration: Registration, pid: int) -> None:
        with self._connect() as conn:
            conn.execute(
                """UPDATE registrations SET state = 'listening', pid = ?,
                last_error = NULL, updated_at = ?
                WHERE run_id = ? AND client = ? AND session_id = ?
                AND state IN ('queued', 'listening', 'error')""",
                (pid, int(time.time()), *self._key(registration)),
            )

    def claim(self, registration: Registration) -> bool:
        with self._connect() as conn:
            cursor = conn.execute(
                """UPDATE registrations SET state = 'claimed', updated_at = ?
                WHERE run_id = ? AND client = ? AND session_id = ?
                AND state IN ('queued', 'listening')""",
                (int(time.time()), *self._key(registration)),
            )
        return cursor.rowcount == 1

    def delivered(self, registration: Registration) -> None:
        self._set_state(registration, "delivered", None)

    def failed(self, registration: Registration, error: str) -> None:
        self._set_state(registration, "error", error[:300])

    def _set_state(self, registration: Registration, state: str, error: str | None) -> None:
        with self._connect() as conn:
            conn.execute(
                """UPDATE registrations SET state = ?, last_error = ?, updated_at = ?
                WHERE run_id = ? AND client = ? AND session_id = ?""",
                (state, error, int(time.time()), *self._key(registration)),
            )

    def credentials(self) -> dict[str, Any] | None:
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT * FROM oauth WHERE singleton = 1").fetchone()
        return dict(row) if row else None

    def set_credentials(self, values: dict[str, Any]) -> None:
        with self._connect() as conn:
            conn.execute(
                """INSERT INTO oauth
                (singleton, client_id, access_token, refresh_token, expires_at, updated_at)
                VALUES (1, ?, ?, ?, ?, ?)
                ON CONFLICT(singleton) DO UPDATE SET
                  client_id = excluded.client_id,
                  access_token = excluded.access_token,
                  refresh_token = excluded.refresh_token,
                  expires_at = excluded.expires_at,
                  updated_at = excluded.updated_at""",
                (
                    values["client_id"],
                    values["access_token"],
                    values["refresh_token"],
                    int(values["expires_at"]),
                    int(time.time()),
                ),
            )

    def summary(self) -> list[tuple[str, int]]:
        with self._connect() as conn:
            return conn.execute(
                "SELECT state, count(*) FROM registrations GROUP BY state ORDER BY state"
            ).fetchall()

    @staticmethod
    def _key(registration: Registration) -> tuple[str, str, str]:
        return registration.run_id, registration.client, registration.session_id


def _decode_response(value: Any, depth: int = 0) -> dict[str, Any] | None:
    if depth > 5:
        return None
    if isinstance(value, str):
        try:
            return _decode_response(json.loads(value), depth + 1)
        except json.JSONDecodeError:
            return None
    if isinstance(value, list):
        for item in value:
            decoded = _decode_response(item, depth + 1)
            if decoded:
                return decoded
        return None
    if not isinstance(value, dict):
        return None
    if isinstance(value.get("status"), str) and isinstance(value.get("run_id"), str):
        return value
    for key in (
        "structuredContent",
        "structured_content",
        "tool_response",
        "toolResponse",
        "tool_result",
        "toolResult",
        "result",
        "content",
        "text",
    ):
        if key in value:
            decoded = _decode_response(value[key], depth + 1)
            if decoded:
                return decoded
    return None


def parse_hook_payload(client: str, payload: dict[str, Any]) -> Registration | None:
    if client not in {"claude", "codex"} or not isinstance(payload, dict):
        return None
    tool_name = next(
        (payload.get(key) for key in ("tool_name", "toolName", "name") if payload.get(key)),
        None,
    )
    if not isinstance(tool_name, str) or tool_name not in DOODLE_TOOLS:
        return None
    response = _decode_response(
        next(
            (
                payload.get(key)
                for key in ("tool_response", "toolResponse", "tool_result", "toolResult")
                if key in payload
            ),
            None,
        )
    )
    if not response or response.get("status") != "running":
        return None
    run_id = response.get("run_id")
    session_id = next(
        (
            payload.get(key)
            for key in ("session_id", "thread_id", "sessionId", "threadId")
            if payload.get(key)
        ),
        None,
    )
    cwd = next(
        (
            payload.get(key)
            for key in ("cwd", "working_directory", "workingDirectory")
            if payload.get(key)
        ),
        None,
    )
    if not isinstance(run_id, str) or not RUN_ID_RE.fullmatch(run_id):
        return None
    try:
        uuid.UUID(str(session_id))
    except (TypeError, ValueError):
        return None
    if not isinstance(cwd, str) or not Path(cwd).is_absolute():
        return None
    return Registration(run_id, client, str(session_id), cwd)


def _resume_prompt(run_id: str) -> str:
    return (
        f'Doodle run {run_id} завершён. Вызови только get_doodle_result(run_id="{run_id}", '
        "wait_seconds=0), не запускай новый Doodle run. Покажи пользователю verbatim_markdown "
        "без изменений и затем, только если нужно, добавь отдельный краткий вывод."
    )


def build_resume_argv(client: str, binary: str, session_id: str, run_id: str) -> list[str]:
    prompt = _resume_prompt(run_id)
    if client == "claude":
        return [binary, "--print", "--resume", session_id, prompt]
    if client == "codex":
        return [binary, "exec", "resume", session_id, prompt]
    raise ValueError("unsupported client")


def run_resume(
    registration: Registration,
    *,
    binary: str,
    env: dict[str, str] | None = None,
    output=None,
) -> int:
    completed = subprocess.run(  # noqa: S603 - fixed argv, executable resolved by the user
        build_resume_argv(
            registration.client, binary, registration.session_id, registration.run_id
        ),
        cwd=registration.cwd,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=output if output is not None else subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
        timeout=1800,
        check=False,
    )
    return completed.returncode


def _atomic_json(path: Path, body: dict[str, Any]) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    existing_mode = path.stat().st_mode & 0o777 if path.exists() else 0o600
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(fd, existing_mode)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(body, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(temporary, path)
    except Exception:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def _hook_entry(client: str, executable: str) -> dict[str, Any]:
    command = f"{shlex.quote(executable)} hook --client {client}"
    return {
        "matcher": "mcp__doodle__(talk_to_doodle|consult_doodle)",
        "hooks": [
            {
                "type": "command",
                "command": command,
                "timeout": 5,
                "statusMessage": "Registering Doodle auto-resume",
            }
        ],
    }


def _is_bridge_entry(entry: Any, client: str) -> bool:
    if not isinstance(entry, dict) or not isinstance(entry.get("hooks"), list):
        return False
    marker = f"hook --client {client}"
    return any(
        isinstance(hook, dict)
        and isinstance(hook.get("command"), str)
        and "doodle-resume-bridge" in hook["command"]
        and marker in hook["command"]
        for hook in entry["hooks"]
    )


def install_hook(path: Path, client: str, executable: str) -> None:
    body: dict[str, Any] = {}
    if path.exists():
        loaded = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(loaded, dict):
            raise ValueError(f"{path} must contain a JSON object")
        body = loaded
    hooks = body.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        raise ValueError(f"{path}: hooks must be an object")
    entries = hooks.setdefault("PostToolUse", [])
    if not isinstance(entries, list):
        raise ValueError(f"{path}: PostToolUse must be an array")
    entries[:] = [entry for entry in entries if not _is_bridge_entry(entry, client)]
    entries.append(_hook_entry(client, executable))
    _atomic_json(path, body)


def uninstall_hook(path: Path, client: str) -> None:
    if not path.exists():
        return
    body = json.loads(path.read_text(encoding="utf-8"))
    hooks = body.get("hooks") if isinstance(body, dict) else None
    entries = hooks.get("PostToolUse") if isinstance(hooks, dict) else None
    if not isinstance(entries, list):
        return
    hooks["PostToolUse"] = [entry for entry in entries if not _is_bridge_entry(entry, client)]
    if not hooks["PostToolUse"]:
        del hooks["PostToolUse"]
    _atomic_json(path, body)


def _request_json(url: str, body: dict[str, Any]) -> dict[str, Any]:
    request = urllib.request.Request(  # noqa: S310 - caller validates HTTPS base URL
        url,
        data=json.dumps(body).encode(),
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        },
        method="POST",
    )
    with urllib.request.urlopen(  # noqa: S310
        request, timeout=30, context=_ssl_context()
    ) as response:
        result = json.load(response)
    if not isinstance(result, dict):
        raise RuntimeError("invalid OAuth response")
    return result


def _request_form(url: str, body: dict[str, str]) -> dict[str, Any]:
    request = urllib.request.Request(  # noqa: S310 - caller validates HTTPS base URL
        url,
        data=urllib.parse.urlencode(body).encode(),
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": USER_AGENT,
        },
        method="POST",
    )
    with urllib.request.urlopen(  # noqa: S310
        request, timeout=30, context=_ssl_context()
    ) as response:
        result = json.load(response)
    if not isinstance(result, dict):
        raise RuntimeError("invalid OAuth response")
    return result


def _validated_base_url(value: str) -> str:
    parsed = urllib.parse.urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("base URL must be an HTTPS origin without credentials or query")
    return value.rstrip("/")


def _credential_values(
    client_id: str, token: dict[str, Any], *, now: int | None = None
) -> dict[str, Any]:
    access_token = token.get("access_token")
    refresh_token = token.get("refresh_token") or ""
    if not isinstance(access_token, str) or not isinstance(refresh_token, str):
        raise RuntimeError("invalid OAuth token response")
    issued_at = int(time.time()) if now is None else now
    return {
        "client_id": client_id,
        "access_token": access_token,
        "refresh_token": refresh_token,
        "expires_at": issued_at + int(token.get("expires_in", 900)),
    }


def oauth_login(state: BridgeState, base_url: str) -> None:
    base = _validated_base_url(base_url)
    resource = f"{base}/mcp"
    callback: dict[str, str] = {}
    expected_state = secrets.token_urlsafe(24)

    class CallbackHandler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler API
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            if query.get("state", [None])[0] == expected_state:
                callback["code"] = query.get("code", [""])[0]
            self.send_response(200 if callback.get("code") else 400)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(
                b"Doodle bridge connected. You can close this tab.\n"
                if callback.get("code")
                else b"Authorization failed.\n"
            )

        def log_message(self, _format, *_args):
            return

    server = http.server.HTTPServer(("127.0.0.1", 0), CallbackHandler)
    server.timeout = 300
    redirect_uri = f"http://127.0.0.1:{server.server_port}/callback"
    client = _request_json(
        f"{base}/oauth/register",
        {
            "redirect_uris": [redirect_uri],
            "token_endpoint_auth_method": "none",
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "scope": "mcp:consult offline_access",
            "client_name": "Doodle resume bridge",
        },
    )
    client_id = client.get("client_id")
    if not isinstance(client_id, str):
        raise RuntimeError("OAuth client registration failed")
    verifier = secrets.token_urlsafe(48)
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    )
    authorize = f"{base}/oauth/authorize?" + urllib.parse.urlencode(
        {
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "scope": "mcp:consult offline_access",
            "state": expected_state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "resource": resource,
        }
    )
    if not webbrowser.open(authorize):
        print(f"Open this URL in a browser:\n{authorize}")
    server.handle_request()
    server.server_close()
    if not callback.get("code"):
        raise RuntimeError("OAuth login timed out or failed")
    token = _request_form(
        f"{base}/oauth/token",
        {
            "grant_type": "authorization_code",
            "code": callback["code"],
            "redirect_uri": redirect_uri,
            "client_id": client_id,
            "code_verifier": verifier,
            "resource": resource,
        },
    )
    state.set_credentials(_credential_values(client_id, token))


def _access_token(state: BridgeState, base_url: str, *, force_refresh: bool = False) -> str:
    credentials = state.credentials()
    if credentials is None:
        raise RuntimeError("run `doodle-resume-bridge login` first")
    if not force_refresh and int(credentials["expires_at"]) > int(time.time()) + 60:
        return str(credentials["access_token"])
    refresh_token = str(credentials["refresh_token"])
    if not refresh_token:
        raise RuntimeError("OAuth login expired; run `doodle-resume-bridge login` again")
    base = _validated_base_url(base_url)
    token = _request_form(
        f"{base}/oauth/token",
        {
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": str(credentials["client_id"]),
            "resource": f"{base}/mcp",
        },
    )
    state.set_credentials(
        _credential_values(
            str(credentials["client_id"]),
            {**token, "refresh_token": token.get("refresh_token") or refresh_token},
        )
    )
    return str(token["access_token"])


def _subscription_messages(base_url: str, token: str, run_id: str):
    base = _validated_base_url(base_url)
    body = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "subscriptions/listen",
        "params": {
            "notifications": {"taskIds": [run_id]},
            "_meta": {
                "io.modelcontextprotocol/clientCapabilities": {"extensions": {TASKS_EXTENSION: {}}},
                "io.modelcontextprotocol/clientInfo": {
                    "name": "doodle-resume-bridge",
                    "version": "1",
                },
            },
        },
    }
    request = urllib.request.Request(  # noqa: S310 - base is validated as HTTPS
        f"{base}/mcp",
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "text/event-stream",
            "Content-Type": "application/json",
            "MCP-Protocol-Version": PROTOCOL_VERSION,
            "Mcp-Method": "subscriptions/listen",
            "User-Agent": USER_AGENT,
        },
        method="POST",
    )
    with urllib.request.urlopen(  # noqa: S310
        request, timeout=90, context=_ssl_context()
    ) as response:
        for raw in response:
            line = raw.decode("utf-8", errors="strict").rstrip("\r\n")
            if not line.startswith("data: "):
                continue
            message = json.loads(line.removeprefix("data: "))
            if isinstance(message, dict):
                yield message


def _log_path() -> Path:
    path = _bridge_home() / "bridge.log"
    path.touch(mode=0o600, exist_ok=True)
    os.chmod(path, 0o600)
    return path


def watch(registration: Registration, base_url: str) -> int:
    state = BridgeState()
    state.mark_listening(registration, os.getpid())
    deadline = time.monotonic() + 3 * 60 * 60
    delay = 2.0
    while time.monotonic() < deadline:
        try:
            state.mark_listening(registration, os.getpid())
            token = _access_token(state, base_url)
            for message in _subscription_messages(base_url, token, registration.run_id):
                if message.get("method") != "notifications/tasks":
                    continue
                params = message.get("params")
                if (
                    not isinstance(params, dict)
                    or params.get("taskId") != registration.run_id
                    or params.get("status") not in TERMINAL_STATES
                ):
                    continue
                if not state.claim(registration):
                    return 0
                env_name = (
                    "DOODLE_CLAUDE_BIN" if registration.client == "claude" else "DOODLE_CODEX_BIN"
                )
                binary = os.environ.get(env_name) or shutil.which(registration.client)
                if not binary:
                    state.failed(registration, f"{registration.client} executable not found")
                    return 1
                with _log_path().open("a", encoding="utf-8") as output:
                    return_code = run_resume(
                        registration, binary=binary, env=dict(os.environ), output=output
                    )
                if return_code == 0:
                    state.delivered(registration)
                    return 0
                state.failed(registration, f"resume exited with {return_code}")
                return return_code
            delay = 2.0
        except urllib.error.HTTPError as exc:
            if exc.code == 401:
                try:
                    _access_token(state, base_url, force_refresh=True)
                    continue
                except (
                    KeyError,
                    OSError,
                    RuntimeError,
                    ValueError,
                    json.JSONDecodeError,
                ) as refresh_error:
                    state.failed(registration, f"refresh {type(refresh_error).__name__}")
            state.failed(registration, f"HTTP {exc.code}")
        except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as exc:
            state.failed(registration, type(exc).__name__)
        time.sleep(delay)
        delay = min(delay * 2, 30)
    state.failed(registration, "listener deadline exceeded")
    return 1


def _spawn_watcher(registration: Registration, base_url: str) -> None:
    command = [
        sys.executable,
        str(Path(__file__).resolve()),
        "watch",
        "--client",
        registration.client,
        "--run-id",
        registration.run_id,
        "--session-id",
        registration.session_id,
        "--cwd",
        registration.cwd,
        "--base-url",
        base_url,
    ]
    with _log_path().open("a", encoding="utf-8") as output:
        subprocess.Popen(  # noqa: S603 - fixed interpreter and local script argv
            command,
            stdin=subprocess.DEVNULL,
            stdout=output,
            stderr=subprocess.STDOUT,
            close_fds=True,
            start_new_session=True,
        )


def hook(client: str, base_url: str) -> int:
    raw = sys.stdin.buffer.read(1024 * 1024 + 1)
    if len(raw) > 1024 * 1024:
        return 0
    try:
        payload = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return 0
    registration = parse_hook_payload(client, payload)
    if registration is None:
        return 0
    state = BridgeState()
    if state.credentials() is None:
        _hook_context(
            "Doodle resume bridge needs login; continue with normal get_doodle_result polling."
        )
        return 0
    if state.register(registration):
        _spawn_watcher(registration, base_url)
    _hook_context(
        "Doodle auto-resume is registered for this run. End this turn without polling; "
        "the bridge will resume this same session when Doodle finishes."
    )
    return 0


def _hook_context(message: str) -> None:
    print(
        json.dumps(
            {
                "systemMessage": message,
                "hookSpecificOutput": {
                    "hookEventName": "PostToolUse",
                    "additionalContext": message,
                },
            },
            separators=(",", ":"),
        )
    )


def install() -> Path:
    destination = Path.home() / ".local/bin/doodle-resume-bridge"
    destination.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    shutil.copy2(Path(__file__).resolve(), destination)
    destination.chmod(0o700)
    install_hook(Path.home() / ".claude/settings.json", "claude", str(destination))
    install_hook(Path.home() / ".codex/hooks.json", "codex", str(destination))
    return destination


def _registration_from_args(args) -> Registration:
    registration = parse_hook_payload(
        args.client,
        {
            "session_id": args.session_id,
            "cwd": args.cwd,
            "tool_name": "talk_to_doodle",
            "tool_response": {"status": "running", "run_id": args.run_id},
        },
    )
    if registration is None:
        raise ValueError("invalid watcher registration")
    return registration


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Doodle MCP auto-resume bridge")
    subparsers = parser.add_subparsers(dest="command", required=True)
    login_parser = subparsers.add_parser("login")
    login_parser.add_argument(
        "--base-url", default=os.environ.get("DOODLE_MCP_URL", DEFAULT_BASE_URL)
    )
    subparsers.add_parser("install-hooks")
    subparsers.add_parser("uninstall-hooks")
    subparsers.add_parser("status")
    hook_parser = subparsers.add_parser("hook")
    hook_parser.add_argument("--client", choices=("claude", "codex"), required=True)
    hook_parser.add_argument(
        "--base-url", default=os.environ.get("DOODLE_MCP_URL", DEFAULT_BASE_URL)
    )
    watch_parser = subparsers.add_parser("watch")
    watch_parser.add_argument("--client", choices=("claude", "codex"), required=True)
    watch_parser.add_argument("--run-id", required=True)
    watch_parser.add_argument("--session-id", required=True)
    watch_parser.add_argument("--cwd", required=True)
    watch_parser.add_argument(
        "--base-url", default=os.environ.get("DOODLE_MCP_URL", DEFAULT_BASE_URL)
    )
    args = parser.parse_args(argv)

    if args.command == "login":
        oauth_login(BridgeState(), args.base_url)
        print("Doodle resume bridge authenticated")
        return 0
    if args.command == "install-hooks":
        destination = install()
        print(f"Installed {destination}")
        return 0
    if args.command == "uninstall-hooks":
        uninstall_hook(Path.home() / ".claude/settings.json", "claude")
        uninstall_hook(Path.home() / ".codex/hooks.json", "codex")
        print("Doodle resume hooks removed")
        return 0
    if args.command == "status":
        state = BridgeState()
        auth = "authenticated" if state.credentials() else "login required"
        summary = ", ".join(f"{name}={count}" for name, count in state.summary()) or "no runs"
        print(f"{auth}; {summary}")
        return 0
    if args.command == "hook":
        return hook(args.client, args.base_url)
    return watch(_registration_from_args(args), args.base_url)


if __name__ == "__main__":
    raise SystemExit(main())
