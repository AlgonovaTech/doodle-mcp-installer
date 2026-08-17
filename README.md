# Doodle MCP installer

Configures Doodle as a remote MCP server for Codex, Claude Code and Cursor.

```sh
npx --yes github:AlgonovaTech/doodle-mcp-installer install
```

Commands:

- `install`
- `doctor`
- `uninstall`
- `resume-install` — install Claude/Codex hooks and complete bridge OAuth login
- `resume-doctor`
- `resume-uninstall`

For long-running Doodle work, enable auto-resume after the ordinary MCP setup:

```sh
npx --yes github:AlgonovaTech/doodle-mcp-installer resume-install
```

Restart Claude/Codex afterwards. Codex intentionally requires one manual trust
step: open `/hooks` and approve the new user-level `PostToolUse` hook. The bridge
uses `subscriptions/listen` while no model turn is running, then resumes the
original session when Doodle reaches a terminal state. macOS and Linux are
supported; Cursor keeps the existing polling fallback.

Authentication happens in the browser. This installer never asks for or stores
passwords, tokens or other credentials.
