import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  ENDPOINT,
  doctorAll,
  installAll,
  main,
  uninstallAll,
} from "../bin/doodle-mcp.mjs";

function temporaryHome(t) {
  const home = mkdtempSync(join(tmpdir(), "doodle-mcp-installer-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function cursorPath(home) {
  return join(home, ".cursor", "mcp.json");
}

function writeCursor(home, value) {
  const path = cursorPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

function readCursor(home) {
  return JSON.parse(readFileSync(cursorPath(home), "utf8"));
}

function fakeRunner({ installed = ["codex", "claude"], codex, claude } = {}) {
  const calls = [];
  const state = { codex, claude };

  function result(status, stdout = "") {
    return { status, stdout, stderr: "sensitive-marker-from-subprocess" };
  }

  function run(command, args) {
    calls.push({ command, args: [...args] });
    if (args[0] === "--version") {
      return result(installed.includes(command) ? 0 : 127, `${command} version`);
    }

    if (command === "codex" && args.slice(0, 3).join(" ") === "mcp get doodle") {
      if (!state.codex) return result(1);
      return result(
        0,
        JSON.stringify({
          transport: { type: "streamable_http", url: state.codex.url },
        }),
      );
    }
    if (command === "codex" && args.slice(0, 3).join(" ") === "mcp add doodle") {
      state.codex = {
        url: args[args.indexOf("--url") + 1],
        resource: args[args.indexOf("--oauth-resource") + 1],
      };
      return result(0);
    }
    if (command === "codex" && args.slice(0, 3).join(" ") === "mcp remove doodle") {
      state.codex = undefined;
      return result(0);
    }

    if (command === "claude" && args.slice(0, 3).join(" ") === "mcp get doodle") {
      return state.claude ? result(0, `URL: ${state.claude}`) : result(1);
    }
    if (command === "claude" && args[0] === "mcp" && args[1] === "add") {
      state.claude = args.at(-1);
      return result(0);
    }
    if (command === "claude" && args[0] === "mcp" && args[1] === "remove") {
      state.claude = undefined;
      return result(0);
    }

    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  }

  return { calls, run, state };
}

test("install configures native clients and preserves unrelated Cursor entries", (t) => {
  const home = temporaryHome(t);
  writeCursor(home, { mcpServers: { other: { command: "other-mcp" } }, setting: true });
  const runner = fakeRunner();

  const status = installAll({ home, run: runner.run });

  assert.deepEqual(runner.state.codex, { url: ENDPOINT, resource: ENDPOINT });
  assert.equal(runner.state.claude, ENDPOINT);
  assert.deepEqual(readCursor(home), {
    mcpServers: { other: { command: "other-mcp" }, doodle: { url: ENDPOINT } },
    setting: true,
  });
  assert.equal(statSync(cursorPath(home)).mode & 0o777, 0o600);
  assert.deepEqual(status, { codex: "configured", claude: "configured", cursor: "configured" });
  assert.ok(
    runner.calls.some(
      ({ command, args }) =>
        command === "codex" &&
        args.join(" ") === `mcp add doodle --url ${ENDPOINT} --oauth-resource ${ENDPOINT}`,
    ),
  );
  assert.ok(
    runner.calls.some(
      ({ command, args }) =>
        command === "claude" &&
        args.join(" ") === `mcp add --transport http --scope user doodle ${ENDPOINT}`,
    ),
  );
});

test("install is idempotent", (t) => {
  const home = temporaryHome(t);
  const runner = fakeRunner();

  installAll({ home, run: runner.run });
  const second = installAll({ home, run: runner.run });

  assert.equal(runner.calls.filter(({ args }) => args[1] === "add").length, 2);
  assert.deepEqual(second, { codex: "unchanged", claude: "unchanged", cursor: "unchanged" });
  assert.deepEqual(readCursor(home).mcpServers, { doodle: { url: ENDPOINT } });
});

test("install skips unavailable native clients", (t) => {
  const home = temporaryHome(t);
  const runner = fakeRunner({ installed: [] });

  const status = installAll({ home, run: runner.run });

  assert.deepEqual(status, {
    codex: "not_installed",
    claude: "not_installed",
    cursor: "configured",
  });
  assert.deepEqual(readCursor(home).mcpServers.doodle, { url: ENDPOINT });
});

test("install rejects a conflicting native registration before writing", (t) => {
  const home = temporaryHome(t);
  const path = writeCursor(home, { mcpServers: { other: { url: "https://example.test/mcp" } } });
  const before = readFileSync(path, "utf8");
  const runner = fakeRunner({
    installed: ["codex"],
    codex: { url: "https://wrong.test/mcp", resource: "https://wrong.test/mcp" },
  });

  assert.throws(() => installAll({ home, run: runner.run }), /conflicting Codex registration/);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(runner.calls.some(({ args }) => args.includes("add")), false);
});

test("invalid Cursor JSON fails without overwrite or temporary file", (t) => {
  const home = temporaryHome(t);
  const path = writeCursor(home, "{invalid-json\n");
  const before = readFileSync(path, "utf8");
  const runner = fakeRunner({ installed: [] });

  assert.throws(() => installAll({ home, run: runner.run }), /Invalid Cursor MCP configuration/);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(existsSync(`${path}.tmp`), false);
  assert.equal(runner.calls.some(({ args }) => args.includes("add")), false);
});

test("uninstall removes only Doodle configuration", (t) => {
  const home = temporaryHome(t);
  writeCursor(home, {
    mcpServers: { doodle: { url: ENDPOINT }, other: { url: "https://example.test/mcp" } },
    setting: true,
  });
  const runner = fakeRunner({
    codex: { url: ENDPOINT, resource: ENDPOINT },
    claude: ENDPOINT,
  });

  const status = uninstallAll({ home, run: runner.run });

  assert.equal(runner.state.codex, undefined);
  assert.equal(runner.state.claude, undefined);
  assert.deepEqual(readCursor(home), {
    mcpServers: { other: { url: "https://example.test/mcp" } },
    setting: true,
  });
  assert.deepEqual(status, { codex: "removed", claude: "removed", cursor: "removed" });
});

test("doctor returns status categories without subprocess output", (t) => {
  const home = temporaryHome(t);
  writeCursor(home, { mcpServers: { doodle: { url: ENDPOINT } } });
  const runner = fakeRunner({
    codex: { url: ENDPOINT, resource: ENDPOINT },
    claude: "https://wrong.test/mcp",
  });

  const status = doctorAll({ home, run: runner.run });

  assert.deepEqual(status, { codex: "configured", claude: "conflict", cursor: "configured" });
  assert.equal(JSON.stringify(status).includes("sensitive-marker"), false);
});

test("doctor checks Claude URL field instead of unrelated output", (t) => {
  const home = temporaryHome(t);
  const runner = fakeRunner({ installed: ["claude"], claude: "https://wrong.test/mcp" });
  const run = (command, args) => {
    const result = runner.run(command, args);
    if (command === "claude" && args.slice(0, 3).join(" ") === "mcp get doodle") {
      return { ...result, stdout: `URL: https://wrong.test/mcp\nNote: ${ENDPOINT}` };
    }
    return result;
  };

  assert.equal(doctorAll({ home, run }).claude, "conflict");
});

test("CLI defaults to install and rejects extra arguments", (t) => {
  const home = temporaryHome(t);
  const runner = fakeRunner({ installed: [] });
  const lines = [];

  assert.equal(main([], { home, run: runner.run, write: (line) => lines.push(line) }), 0);
  assert.equal(lines.join("\n").includes("password"), false);
  assert.throws(
    () => main(["install", "extra"], { home, run: runner.run, write: () => {} }),
    /Usage:/,
  );
});
