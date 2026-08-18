# Doodle MCP installer

Configures Doodle as a remote MCP server for Codex, Claude Code and Cursor.
For detected Claude/Codex clients the same command also installs completion
notifications, adds the user-level hooks and opens the bridge OAuth login:

```sh
npx --yes github:AlgonovaTech/doodle-mcp-installer install
```

Commands:

- `install`
- `doctor`
- `uninstall`
- `resume-install` — repair/re-authenticate notifications (legacy command name)
- `resume-doctor`
- `resume-uninstall`

After installation, finish the browser login, restart Claude/Codex and approve
the new user-level `PostToolUse` hook once. In Codex, open `/hooks`; Claude shows
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
