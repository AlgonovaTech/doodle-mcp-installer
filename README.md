# Doodle MCP installer

Configures Doodle as a remote MCP server for Codex, Claude Code and Cursor.
For detected Claude/Codex clients the same command also installs auto-resume,
adds the user-level hooks and opens the bridge OAuth login:

```sh
npx --yes github:AlgonovaTech/doodle-mcp-installer install
```

Commands:

- `install`
- `doctor`
- `uninstall`
- `resume-install` — repair/re-authenticate Claude/Codex auto-resume separately
- `resume-doctor`
- `resume-uninstall`

After installation, finish the browser login, restart Claude/Codex and approve
the new user-level `PostToolUse` hook once. In Codex, open `/hooks`; Claude shows
the same user hook in its Hooks settings. The bridge
uses `subscriptions/listen` while no model turn is running, then resumes the
original session when Doodle reaches a terminal state. macOS and Linux are
supported; Cursor is configured by the same command but keeps the existing
polling fallback.

Authentication happens in the browser. This installer never asks for or stores
passwords, tokens or other credentials.
