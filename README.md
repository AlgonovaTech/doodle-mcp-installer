# Doodle MCP installer

Configures Doodle as a remote MCP server for Codex, Claude Code and Cursor.
For detected Claude/Codex clients the same command also installs completion
notifications and user-level hooks. For Codex, it also installs the Codex-only
Mr Doodle visual companion:

```sh
npx --yes github:AlgonovaTech/doodle-mcp-installer install
```

`install` completes an ephemeral browser OAuth login and validates the protected
Mr Doodle package before making any local changes. It then runs Claude Code's
native updater before registering Doodle, avoiding MCP OAuth bugs fixed in
current Claude releases. Each configured MCP client keeps its own OAuth session;
the installer's short-lived access token remains in memory and is discarded.

This public package contains no pet binary. Mr Doodle is downloaded only after
successful authorization and is installed only for a detected Codex client.
`doctor` and `uninstall` are local, need no login, and preserve partial or
customized pet files.

Commands:

- `install`
- `doctor`
- `uninstall`
- `resume-install` — repair/re-authenticate notifications (legacy command name)
- `resume-doctor`
- `resume-uninstall`

After installation, restart Claude/Codex and approve the new user-level
`PostToolUse` hook once. In Codex, open `/hooks`; Claude shows
the same user hook in its Hooks settings. The bridge uses
`subscriptions/listen` while no model turn is running. When Doodle reaches a
terminal state on macOS, Notification Center reports completion and the exact
`get_doodle_result` command is copied to the clipboard. Paste and approve that
command in the original Codex/Claude task. No task-status polling runs.

Test local delivery after installation:

```sh
~/.local/bin/doodle-resume-bridge notify-test --client codex
```

The completion notification is currently a macOS proof of concept. Linux and
Cursor keep manual result retrieval; no additional notification software is
installed.

Authentication happens in the browser. This installer never asks for or stores
passwords, tokens or other credentials.
