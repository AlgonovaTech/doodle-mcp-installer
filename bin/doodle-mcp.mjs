#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const ENDPOINT = "https://mcp.algodoodle.me/mcp";

const LABELS = { codex: "Codex", claude: "Claude Code", cursor: "Cursor" };

function defaultRun(command, args) {
  return spawnSync(command, args, { encoding: "utf8", shell: false });
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function available(run, command) {
  return run(command, ["--version"]).status === 0;
}

function inspectCodex(run) {
  if (!available(run, "codex")) return "not_installed";
  const result = run("codex", ["mcp", "get", "doodle", "--json"]);
  if (result.status !== 0) return "missing";
  try {
    const config = JSON.parse(result.stdout);
    return config?.transport?.url === ENDPOINT ? "configured" : "conflict";
  } catch {
    return "conflict";
  }
}

function inspectClaude(run) {
  if (!available(run, "claude")) return "not_installed";
  const result = run("claude", ["mcp", "get", "doodle"]);
  if (result.status !== 0) return "missing";
  const url = result.stdout.match(/^\s*URL:\s*(\S+)\s*$/im)?.[1];
  return url === ENDPOINT ? "configured" : "conflict";
}

function cursorFile(home) {
  return join(home, ".cursor", "mcp.json");
}

function loadCursor(home) {
  const path = cursorFile(home);
  if (!existsSync(path)) return { path, config: { mcpServers: {} } };

  let config;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Invalid Cursor MCP configuration; file was not changed.");
  }
  if (!isObject(config) || (config.mcpServers !== undefined && !isObject(config.mcpServers))) {
    throw new Error("Invalid Cursor MCP configuration; file was not changed.");
  }
  config.mcpServers ??= {};
  return { path, config };
}

function inspectCursor(config) {
  const doodle = config.mcpServers.doodle;
  if (doodle === undefined) return "missing";
  return isObject(doodle) && doodle.url === ENDPOINT && Object.keys(doodle).length === 1
    ? "configured"
    : "conflict";
}

function writeCursor(path, config) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function requireSuccess(result, client) {
  if (result.status !== 0) throw new Error(`Could not configure ${client}.`);
}

export function installAll({ home = homedir(), run = defaultRun } = {}) {
  const cursor = loadCursor(home);
  const current = {
    codex: inspectCodex(run),
    claude: inspectClaude(run),
    cursor: inspectCursor(cursor.config),
  };

  if (current.codex === "conflict") throw new Error("Found a conflicting Codex registration.");
  if (current.claude === "conflict") {
    throw new Error("Found a conflicting Claude Code registration.");
  }
  if (current.cursor === "conflict") throw new Error("Found a conflicting Cursor registration.");

  const status = { ...current };
  if (current.codex === "missing") {
    requireSuccess(
      run("codex", [
        "mcp",
        "add",
        "doodle",
        "--url",
        ENDPOINT,
        "--oauth-resource",
        ENDPOINT,
      ]),
      "Codex",
    );
    status.codex = "configured";
  } else if (current.codex === "configured") {
    status.codex = "unchanged";
  }

  if (current.claude === "missing") {
    requireSuccess(
      run("claude", [
        "mcp",
        "add",
        "--transport",
        "http",
        "--scope",
        "user",
        "doodle",
        ENDPOINT,
      ]),
      "Claude Code",
    );
    status.claude = "configured";
  } else if (current.claude === "configured") {
    status.claude = "unchanged";
  }

  if (current.cursor === "missing") {
    cursor.config.mcpServers.doodle = { url: ENDPOINT };
    writeCursor(cursor.path, cursor.config);
    status.cursor = "configured";
  } else {
    status.cursor = "unchanged";
  }
  return status;
}

export function doctorAll({ home = homedir(), run = defaultRun } = {}) {
  let cursor = "invalid";
  try {
    cursor = inspectCursor(loadCursor(home).config);
  } catch {
    // A status category is enough; never reflect invalid file contents.
  }
  return { codex: inspectCodex(run), claude: inspectClaude(run), cursor };
}

export function uninstallAll({ home = homedir(), run = defaultRun } = {}) {
  const cursor = loadCursor(home);
  const current = {
    codex: inspectCodex(run),
    claude: inspectClaude(run),
    cursor: inspectCursor(cursor.config),
  };
  const status = { ...current };

  if (current.codex === "configured" || current.codex === "conflict") {
    requireSuccess(run("codex", ["mcp", "remove", "doodle"]), "Codex");
    status.codex = "removed";
  }
  if (current.claude === "configured" || current.claude === "conflict") {
    requireSuccess(
      run("claude", ["mcp", "remove", "--scope", "user", "doodle"]),
      "Claude Code",
    );
    status.claude = "removed";
  }
  if (current.cursor === "configured" || current.cursor === "conflict") {
    delete cursor.config.mcpServers.doodle;
    writeCursor(cursor.path, cursor.config);
    status.cursor = "removed";
  }
  return status;
}

function printStatus(status, write) {
  for (const [client, value] of Object.entries(status)) write(`${LABELS[client]}: ${value}`);
}

export function main(
  argv,
  { home = homedir(), run = defaultRun, write = (line) => console.log(line) } = {},
) {
  const command = argv[0] ?? "install";
  if (argv.length > 1 || !["install", "doctor", "uninstall"].includes(command)) {
    throw new Error("Usage: doodle-mcp [install|doctor|uninstall]");
  }

  const operation = { install: installAll, doctor: doctorAll, uninstall: uninstallAll }[command];
  const status = operation({ home, run });
  printStatus(status, write);
  if (command === "install") write("Authentication opens in your client browser on first use.");
  if (command !== "doctor") return 0;
  return Object.values(status).some((value) => ["configured"].includes(value)) &&
    !Object.values(status).some((value) => ["conflict", "invalid"].includes(value))
    ? 0
    : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`Doodle MCP installer: ${error.message}`);
    process.exitCode = 1;
  }
}
