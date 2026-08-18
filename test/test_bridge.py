from __future__ import annotations

import json
import os
import sqlite3
import stat
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bridge"))

from doodle_resume_bridge import (  # noqa: E402
    BridgeState,
    Registration,
    _validated_base_url,
    build_resume_argv,
    install_hook,
    parse_hook_payload,
    run_resume,
    uninstall_hook,
)

RUN_ID = "abcdefghijklmnopqrstuvwxyz_123456"
SESSION_ID = "11111111-2222-4333-8444-555555555555"


class BridgeTests(unittest.TestCase):
    def test_accepts_only_https_server_origins(self):
        self.assertEqual(_validated_base_url("https://mcp.example.com/"), "https://mcp.example.com")
        for unsafe in (
            "http://mcp.example.com",
            "file:///etc/passwd",
            "https://user@mcp.example.com",
        ):
            with self.assertRaises(ValueError):
                _validated_base_url(unsafe)

    def test_claude_hook_extracts_running_doodle_registration(self):
        registration = parse_hook_payload(
            "claude",
            {
                "session_id": SESSION_ID,
                "cwd": "/workspace/project",
                "tool_name": "mcp__doodle__talk_to_doodle",
                "tool_response": {"structuredContent": {"status": "running", "run_id": RUN_ID}},
            },
        )
        self.assertEqual(
            registration,
            Registration(RUN_ID, "claude", SESSION_ID, "/workspace/project"),
        )

    def test_codex_hook_accepts_string_tool_response_and_thread_id(self):
        registration = parse_hook_payload(
            "codex",
            {
                "thread_id": SESSION_ID,
                "cwd": "/workspace/project",
                "tool_name": "mcp__doodle__consult_doodle",
                "tool_response": json.dumps(
                    {"structured_content": {"status": "running", "run_id": RUN_ID}}
                ),
            },
        )
        self.assertIsNotNone(registration)
        self.assertEqual(registration.client, "codex")
        self.assertEqual(registration.run_id, RUN_ID)

    def test_hook_ignores_irrelevant_or_invalid_payloads(self):
        base = {
            "session_id": SESSION_ID,
            "cwd": "/workspace/project",
            "tool_name": "mcp__doodle__talk_to_doodle",
            "tool_response": {"status": "running", "run_id": RUN_ID},
        }
        self.assertIsNone(parse_hook_payload("claude", {**base, "tool_name": "mcp__other__tool"}))
        self.assertIsNone(
            parse_hook_payload(
                "claude",
                {**base, "tool_response": {"status": "completed", "run_id": RUN_ID}},
            )
        )
        self.assertIsNone(
            parse_hook_payload(
                "claude",
                {**base, "tool_response": {"status": "running", "run_id": "../bad"}},
            )
        )
        self.assertIsNone(parse_hook_payload("claude", {**base, "session_id": "not-a-uuid"}))

    def test_resume_argv_uses_native_commands_without_shell(self):
        claude = build_resume_argv("claude", "/opt/Claude Code/claude", SESSION_ID, RUN_ID)
        codex = build_resume_argv("codex", "/opt/Codex/codex", SESSION_ID, RUN_ID)
        self.assertEqual(claude[:4], ["/opt/Claude Code/claude", "--print", "--resume", SESSION_ID])
        self.assertEqual(codex[:4], ["/opt/Codex/codex", "exec", "resume", SESSION_ID])
        self.assertIn(RUN_ID, claude[-1])
        self.assertIn("wait_seconds=0", codex[-1])

    def test_bridge_state_claims_each_registration_once(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.sqlite3"
            state = BridgeState(path)
            registration = Registration(RUN_ID, "claude", SESSION_ID, "/workspace/project")
            self.assertTrue(state.register(registration))
            self.assertFalse(state.register(registration))
            self.assertTrue(state.claim(registration))
            self.assertFalse(state.claim(registration))
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            with sqlite3.connect(path) as conn:
                row = conn.execute("SELECT state FROM registrations").fetchone()
            self.assertEqual(row, ("claimed",))

    def test_resume_executes_fake_client_once_with_argv(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "argv.json"
            fake = root / "fake-client"
            fake.write_text(
                "#!/usr/bin/env python3\n"
                "import json, os, sys\n"
                "open(os.environ['BRIDGE_TEST_OUTPUT'], 'w').write(json.dumps(sys.argv[1:]))\n"
            )
            fake.chmod(0o700)
            result = run_resume(
                Registration(RUN_ID, "codex", SESSION_ID, str(root)),
                binary=str(fake),
                env={**os.environ, "BRIDGE_TEST_OUTPUT": str(output)},
            )
            self.assertEqual(result, 0)
            self.assertEqual(json.loads(output.read_text())[:3], ["exec", "resume", SESSION_ID])

    def test_hook_install_is_idempotent_and_preserves_existing_hooks(self):
        with tempfile.TemporaryDirectory() as directory:
            settings = Path(directory) / "settings.json"
            settings.write_text(
                json.dumps(
                    {
                        "permissions": {"allow": ["Read(*)"]},
                        "hooks": {"SessionStart": [{"hooks": [{"command": "existing"}]}]},
                    }
                )
            )
            executable = "/Users/test/.local/bin/doodle-resume-bridge"
            install_hook(settings, "claude", executable)
            install_hook(settings, "claude", executable)
            body = json.loads(settings.read_text())
            self.assertEqual(body["permissions"], {"allow": ["Read(*)"]})
            self.assertEqual(body["hooks"]["SessionStart"][0]["hooks"][0]["command"], "existing")
            self.assertEqual(len(body["hooks"]["PostToolUse"]), 1)
            command = body["hooks"]["PostToolUse"][0]["hooks"][0]["command"]
            self.assertTrue(command.endswith(" hook --client claude"))
            uninstall_hook(settings, "claude")
            cleaned = json.loads(settings.read_text())
            self.assertNotIn("PostToolUse", cleaned["hooks"])
            self.assertIn("SessionStart", cleaned["hooks"])


if __name__ == "__main__":
    unittest.main()
