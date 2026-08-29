#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ENDPOINT = "https://mcp.algodoodle.me/mcp";
const OAUTH_BASE = new URL(ENDPOINT).origin;
const PET_BASE = `${OAUTH_BASE}/downloads/v1/pets/mr-doodle`;
export const PET_FILES = Object.freeze({
  "pet.json": Object.freeze({
    size: 243,
    sha256: "b52293ab99c3980d8e183136b37ffada9cefefa615d7f4e43fa7da87b3a59ba3",
  }),
  "spritesheet.webp": Object.freeze({
    size: 1800536,
    sha256: "90f802458c1cf5b36d3eb6c5e4a55a4024e8c020f17b5a1dbcbbd5e79e527386",
  }),
});

const LABELS = {
  codex: "Codex",
  claude: "Claude Code",
  cursor: "Cursor",
  pet: "Mr Doodle",
  resume: "Notification",
};
const BRIDGE_SOURCE = fileURLToPath(
  new URL("../bridge/doodle_resume_bridge.py", import.meta.url),
);

function defaultRun(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", shell: false, ...options });
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameKeys(value, keys) {
  return isObject(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requireJsonObject(value, label) {
  if (!isObject(value)) throw new Error(`Invalid ${label} response.`);
  return value;
}

async function responseBytes(response, maximum, label) {
  response = await response;
  if (!response.ok) throw new Error(`Could not download ${label} (${response.status}).`);
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maximum) throw new Error(`Invalid ${label} size.`);
  const chunks = [];
  let size = 0;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new Error(`Invalid ${label} size.`);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maximum) throw new Error(`Invalid ${label} size.`);
  return bytes;
}

async function jsonRequest(url, options, fetchImpl, label) {
  const bytes = await responseBytes(await fetchImpl(url, options), 4096, label);
  try {
    return requireJsonObject(JSON.parse(bytes), label);
  } catch (error) {
    if (error.message === `Invalid ${label} response.`) throw error;
    throw new Error(`Invalid ${label} response.`);
  }
}

function endpoint(metadata, name, base) {
  const value = new URL(metadata[name]);
  if (value.username || value.password || value.origin !== new URL(base).origin) {
    throw new Error("Invalid OAuth server metadata.");
  }
  return value.href;
}

function startCallback(state, timeoutMs) {
  let resolveCallback;
  let rejectCallback;
  let timer;
  const result = new Promise((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== "/callback") {
      response.writeHead(404).end();
      return;
    }
    if (url.searchParams.get("state") !== state) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Invalid OAuth state. You may close this tab.");
      return;
    }
    const code = url.searchParams.get("code");
    const oauthError = url.searchParams.get("error");
    if (!code || oauthError) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Authorization was not completed. You may close this tab.");
      rejectCallback(new Error("Authorization was denied or cancelled."));
      return;
    }
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("Doodle is authorized. You may close this tab.");
    resolveCallback(code);
  });
  const listening = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      timer = setTimeout(
        () => rejectCallback(new Error("Authorization timed out.")),
        timeoutMs,
      );
      resolve(`http://127.0.0.1:${server.address().port}/callback`);
    });
  });
  return {
    listening,
    result,
    close() {
      clearTimeout(timer);
      server.close();
    },
  };
}

export function browserCommand(platform, url) {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") {
    return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
  }
  return { command: "xdg-open", args: [url] };
}

function openBrowser(url, run) {
  const { command, args } = browserCommand(process.platform, url);
  return run(command, args);
}

export async function authorizeInstaller({
  oauthBase = OAUTH_BASE,
  fetchImpl = fetch,
  run = defaultRun,
  openBrowser: launch = (url) => openBrowser(url, run),
  write = (line) => console.log(line),
  timeoutMs = 120_000,
} = {}) {
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(64).toString("base64url");
  const callback = startCallback(state, timeoutMs);
  try {
    const redirectUri = await callback.listening;
    const metadata = await jsonRequest(
      `${oauthBase}/.well-known/oauth-authorization-server`,
      { redirect: "error", signal: AbortSignal.timeout(10_000) },
      fetchImpl,
      "OAuth metadata",
    );
    const registrationEndpoint = endpoint(metadata, "registration_endpoint", oauthBase);
    const authorizationEndpoint = endpoint(metadata, "authorization_endpoint", oauthBase);
    const tokenEndpoint = endpoint(metadata, "token_endpoint", oauthBase);
    const registration = await jsonRequest(
      registrationEndpoint,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          scope: "mcp:consult",
          client_name: "Doodle MCP installer",
        }),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      },
      fetchImpl,
      "OAuth registration",
    );
    if (typeof registration.client_id !== "string" || !registration.client_id) {
      throw new Error("Invalid OAuth registration response.");
    }
    const authorization = new URL(authorizationEndpoint);
    authorization.search = new URLSearchParams({
      response_type: "code",
      client_id: registration.client_id,
      redirect_uri: redirectUri,
      scope: "mcp:consult",
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      resource: ENDPOINT,
    });
    let launched;
    try {
      launched = launch(authorization.href);
    } catch {
      launched = { status: 1 };
    }
    if (launched?.status !== 0) write(`Open this URL to authenticate: ${authorization.href}`);
    const code = await callback.result;
    const token = await jsonRequest(
      tokenEndpoint,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: registration.client_id,
          code_verifier: verifier,
          resource: ENDPOINT,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      },
      fetchImpl,
      "OAuth token",
    );
    if (typeof token.access_token !== "string" || !token.access_token) {
      throw new Error("Invalid OAuth token response.");
    }
    return token.access_token;
  } finally {
    callback.close();
  }
}

export function validatePetPackage(pet, expected = PET_FILES) {
  if (!isObject(pet) || !Buffer.isBuffer(pet.petJson) || !Buffer.isBuffer(pet.spritesheet)) {
    throw new Error("Pet package is incomplete.");
  }
  const manifest = pet.manifest;
  if (
    !sameKeys(manifest, ["schemaVersion", "id", "files"]) ||
    manifest.schemaVersion !== 1 ||
    manifest.id !== "mr-doodle" ||
    !sameKeys(manifest.files, ["pet.json", "spritesheet.webp"])
  ) {
    throw new Error("Invalid pet manifest.");
  }
  for (const name of ["pet.json", "spritesheet.webp"]) {
    const declared = manifest.files[name];
    if (
      !sameKeys(declared, ["size", "sha256"]) ||
      declared.size !== expected[name].size ||
      declared.sha256 !== expected[name].sha256
    ) {
      throw new Error("Invalid pet manifest.");
    }
    const bytes = name === "pet.json" ? pet.petJson : pet.spritesheet;
    if (bytes.length !== expected[name].size) throw new Error(`Invalid ${name} size.`);
    if (sha256(bytes) !== expected[name].sha256) throw new Error(`Invalid ${name} hash.`);
  }
  let runtime;
  try {
    runtime = JSON.parse(pet.petJson);
  } catch {
    throw new Error("Invalid pet.json runtime manifest.");
  }
  if (
    !isObject(runtime) ||
    runtime.id !== "mr-doodle" ||
    runtime.spriteVersionNumber !== 2 ||
    runtime.spritesheetPath !== "spritesheet.webp"
  ) {
    throw new Error("Invalid pet.json runtime manifest.");
  }
  return pet;
}

export async function downloadPetPackage(
  accessToken,
  { fetchImpl = fetch, petBase = PET_BASE, expected = PET_FILES } = {},
) {
  if (typeof accessToken !== "string" || !accessToken) throw new Error("Authorization failed.");
  const request = (name, maximum) =>
    responseBytes(
      fetchImpl(`${petBase}/${name}`, {
        headers: { authorization: `Bearer ${accessToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      }),
      maximum,
      name,
    );
  const manifestBytes = await request("manifest.json", 4096);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes);
  } catch {
    throw new Error("Invalid pet manifest.");
  }
  const [petJson, spritesheet] = await Promise.all([
    request("pet.json", expected["pet.json"].size),
    request("spritesheet.webp", expected["spritesheet.webp"].size),
  ]);
  return validatePetPackage({ manifest, petJson, spritesheet }, expected);
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

function petPaths(home, codexHome) {
  const root = codexHome || join(home, ".codex");
  const pets = join(root, "pets");
  return { pets, directory: join(pets, "mr-doodle") };
}

function isSymlink(path) {
  return existsSync(path) && lstatSync(path).isSymbolicLink();
}

function exactPetFile(path, expected) {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && stat.size === expected.size && sha256(readFileSync(path)) === expected.sha256;
  } catch {
    return false;
  }
}

export function doctorPet({
  home = homedir(),
  codexHome = process.env.CODEX_HOME,
  expected = PET_FILES,
} = {}) {
  const { pets, directory } = petPaths(home, codexHome);
  if (isSymlink(pets) || isSymlink(directory)) return "conflict";
  if (!existsSync(directory)) return "missing";
  try {
    if (!lstatSync(directory).isDirectory()) return "conflict";
    if (readdirSync(directory).sort().join("\0") !== "pet.json\0spritesheet.webp") {
      return "conflict";
    }
    return exactPetFile(join(directory, "pet.json"), expected["pet.json"]) &&
      exactPetFile(join(directory, "spritesheet.webp"), expected["spritesheet.webp"])
      ? "configured"
      : "conflict";
  } catch {
    return "conflict";
  }
}

function writePetFile(path, bytes) {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    if (existsSync(path)) throw new Error("Pet destination changed during installation.");
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function installPet(
  pet,
  {
    home = homedir(),
    codexHome = process.env.CODEX_HOME,
    codexInstalled,
    expected = PET_FILES,
  } = {},
) {
  if (!codexInstalled) return "not_installed";
  validatePetPackage(pet, expected);
  const current = doctorPet({ home, codexHome, expected });
  if (current === "configured") return "unchanged";
  if (current === "conflict") return "conflict";
  const { directory } = petPaths(home, codexHome);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writePetFile(join(directory, "spritesheet.webp"), pet.spritesheet);
  writePetFile(join(directory, "pet.json"), pet.petJson);
  return "configured";
}

export function uninstallPet({
  home = homedir(),
  codexHome = process.env.CODEX_HOME,
  expected = PET_FILES,
} = {}) {
  const current = doctorPet({ home, codexHome, expected });
  if (current !== "configured") return current;
  const { directory } = petPaths(home, codexHome);
  unlinkSync(join(directory, "pet.json"));
  unlinkSync(join(directory, "spritesheet.webp"));
  return "removed";
}

export function preflightInstall({
  home = homedir(),
  run = defaultRun,
  codexHome = process.env.CODEX_HOME,
  expectedPetFiles = PET_FILES,
} = {}) {
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

  const pet =
    current.codex === "not_installed"
      ? "not_installed"
      : doctorPet({ home, codexHome, expected: expectedPetFiles });
  if (pet === "conflict") throw new Error("Found a conflicting Mr Doodle installation.");
  return { cursor, current, pet };
}

function configureClients(preflight, run) {
  const { cursor, current } = preflight;

  if (current.claude !== "not_installed" && run("claude", ["update"]).status !== 0) {
    throw new Error("Could not update Claude Code.");
  }

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

export async function installAll({
  home = homedir(),
  run = defaultRun,
  codexHome = process.env.CODEX_HOME,
  authorize = authorizeInstaller,
  downloadPet = downloadPetPackage,
  expectedPetFiles = PET_FILES,
  write = (line) => console.log(line),
} = {}) {
  preflightInstall({ home, run, codexHome, expectedPetFiles });
  const accessToken = await authorize({ run, write });
  const pet = validatePetPackage(await downloadPet(accessToken), expectedPetFiles);
  const preflight = preflightInstall({ home, run, codexHome, expectedPetFiles });
  const status = configureClients(preflight, run);
  status.pet = installPet(pet, {
    home,
    codexHome,
    codexInstalled: preflight.current.codex !== "not_installed",
    expected: expectedPetFiles,
  });
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

function bridgePath(home) {
  return join(home, ".local", "bin", "doodle-resume-bridge");
}

function bridgeEnv(home) {
  return { ...process.env, HOME: home };
}

export function installResume({ home = homedir(), run = defaultRun } = {}) {
  requireSuccess(
    run("python3", [BRIDGE_SOURCE, "install-hooks"], { env: bridgeEnv(home) }),
    "notification bridge",
  );
  if (doctorResume({ home, run }).resume !== "configured") {
    requireSuccess(
      run(bridgePath(home), ["login"], { env: bridgeEnv(home) }),
      "notification bridge",
    );
  }
  return { resume: "configured" };
}

export function doctorResume({ home = homedir(), run = defaultRun } = {}) {
  const executable = bridgePath(home);
  if (!existsSync(executable)) return { resume: "missing" };
  const result = run(executable, ["status"], { env: bridgeEnv(home) });
  if (result.status !== 0) return { resume: "error" };
  return { resume: /^authenticated(?:;|$)/.test(result.stdout) ? "configured" : "login_required" };
}

export function uninstallResume({ home = homedir(), run = defaultRun } = {}) {
  const executable = bridgePath(home);
  if (!existsSync(executable)) return { resume: "missing" };
  requireSuccess(
    run(executable, ["uninstall-hooks"], { env: bridgeEnv(home) }),
    "notification bridge",
  );
  return { resume: "removed" };
}

function printStatus(status, write) {
  for (const [client, value] of Object.entries(status)) write(`${LABELS[client]}: ${value}`);
}

export async function main(
  argv,
  {
    home = homedir(),
    run = defaultRun,
    write = (line) => console.log(line),
    authorize = authorizeInstaller,
    downloadPet = downloadPetPackage,
    expectedPetFiles = PET_FILES,
    codexHome = process.env.CODEX_HOME,
  } = {},
) {
  const command = argv[0] ?? "install";
  const operations = {
    install: installAll,
    doctor: (options) => ({
      ...doctorAll(options),
      pet: doctorPet({ ...options, codexHome, expected: expectedPetFiles }),
    }),
    uninstall: (options) => ({
      ...uninstallAll(options),
      pet: uninstallPet({ ...options, codexHome, expected: expectedPetFiles }),
    }),
    "resume-install": async (options) => {
      const accessToken = await options.authorize({ run: options.run, write: options.write });
      validatePetPackage(
        await options.downloadPet(accessToken),
        options.expectedPetFiles,
      );
      return installResume(options);
    },
    "resume-doctor": doctorResume,
    "resume-uninstall": uninstallResume,
  };
  if (argv.length > 1 || !(command in operations)) {
    throw new Error(
      "Usage: doodle-mcp [install|doctor|uninstall|resume-install|resume-doctor|resume-uninstall]",
    );
  }

  const status = await operations[command]({
    home,
    run,
    write,
    authorize,
    downloadPet,
    expectedPetFiles,
    codexHome,
  });
  if (
    command === "install" &&
    [status.codex, status.claude].some((value) => value === "configured" || value === "unchanged")
  ) {
    Object.assign(status, installResume({ home, run }));
  }
  printStatus(status, write);
  if (command === "install") write("Each MCP client keeps its own OAuth session for later use.");
  if (command === "resume-install") {
    write("Restart Claude/Codex; in Codex approve the user hook once with /hooks.");
  }
  if (!command.endsWith("doctor")) return 0;
  return Object.values(status).some((value) => ["configured"].includes(value)) &&
    !Object.values(status).some((value) => ["conflict", "invalid"].includes(value))
    ? 0
    : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`Doodle MCP installer: ${error.message}`);
    process.exitCode = 1;
  }
}
