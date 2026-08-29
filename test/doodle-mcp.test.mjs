import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import * as installer from "../bin/doodle-mcp.mjs";
import {
  ENDPOINT,
  doctorAll,
  doctorResume,
  installAll,
  installResume,
  main,
  uninstallAll,
  uninstallResume,
} from "../bin/doodle-mcp.mjs";

const TEST_PET_JSON = Buffer.from(
  `${JSON.stringify({
    id: "mr-doodle",
    spriteVersionNumber: 2,
    spritesheetPath: "spritesheet.webp",
  })}\n`,
);
const TEST_SPRITESHEET = Buffer.from("test-webp-bytes");
const TEST_EXPECTED_FILES = {
  "pet.json": {
    size: TEST_PET_JSON.length,
    sha256: createHash("sha256").update(TEST_PET_JSON).digest("hex"),
  },
  "spritesheet.webp": {
    size: TEST_SPRITESHEET.length,
    sha256: createHash("sha256").update(TEST_SPRITESHEET).digest("hex"),
  },
};

function testPetPackage() {
  const files = structuredClone(TEST_EXPECTED_FILES);
  return {
    manifest: { schemaVersion: 1, id: "mr-doodle", files },
    petJson: TEST_PET_JSON,
    spritesheet: TEST_SPRITESHEET,
  };
}

function installAuthenticated(options) {
  return installAll({
    ...options,
    authorize: async () => "access-token",
    downloadPet: async () => testPetPackage(),
    expectedPetFiles: TEST_EXPECTED_FILES,
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

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

function fakeRunner({ installed = ["codex", "claude"], codex, claude, claudeUpdateStatus = 0 } = {}) {
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

    if (command === "claude" && args[0] === "update") {
      return result(claudeUpdateStatus);
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

test("install configures native clients and preserves unrelated Cursor entries", async (t) => {
  const home = temporaryHome(t);
  writeCursor(home, { mcpServers: { other: { command: "other-mcp" } }, setting: true });
  const runner = fakeRunner();

  const status = await installAuthenticated({ home, run: runner.run });

  assert.deepEqual(runner.state.codex, { url: ENDPOINT, resource: ENDPOINT });
  assert.equal(runner.state.claude, ENDPOINT);
  assert.deepEqual(readCursor(home), {
    mcpServers: { other: { command: "other-mcp" }, doodle: { url: ENDPOINT } },
    setting: true,
  });
  assert.equal(statSync(cursorPath(home)).mode & 0o777, 0o600);
  assert.deepEqual(status, {
    codex: "configured",
    claude: "configured",
    cursor: "configured",
    pet: "configured",
  });
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

test("install updates Claude before registering Doodle", async (t) => {
  const home = temporaryHome(t);
  const runner = fakeRunner({ installed: ["claude"] });

  await installAuthenticated({ home, run: runner.run });

  const update = runner.calls.findIndex(
    ({ command, args }) => command === "claude" && args[0] === "update",
  );
  const register = runner.calls.findIndex(
    ({ command, args }) => command === "claude" && args.slice(0, 2).join(" ") === "mcp add",
  );
  assert.ok(update >= 0);
  assert.ok(register > update);
});

test("install stops before configuration when Claude update fails", async (t) => {
  const home = temporaryHome(t);
  const runner = fakeRunner({ installed: ["claude"], claudeUpdateStatus: 1 });

  await assert.rejects(
    installAuthenticated({ home, run: runner.run }),
    /Could not update Claude Code/,
  );
  assert.equal(runner.calls.some(({ args }) => args[0] === "mcp" && args[1] === "add"), false);
  assert.equal(existsSync(cursorPath(home)), false);
});

test("install is idempotent", async (t) => {
  const home = temporaryHome(t);
  const runner = fakeRunner();

  await installAuthenticated({ home, run: runner.run });
  const second = await installAuthenticated({ home, run: runner.run });

  assert.equal(runner.calls.filter(({ args }) => args[1] === "add").length, 2);
  assert.deepEqual(second, {
    codex: "unchanged",
    claude: "unchanged",
    cursor: "unchanged",
    pet: "unchanged",
  });
  assert.deepEqual(readCursor(home).mcpServers, { doodle: { url: ENDPOINT } });
});

test("install skips unavailable native clients", async (t) => {
  const home = temporaryHome(t);
  const runner = fakeRunner({ installed: [] });

  const status = await installAuthenticated({ home, run: runner.run });

  assert.deepEqual(status, {
    codex: "not_installed",
    claude: "not_installed",
    cursor: "configured",
    pet: "not_installed",
  });
  assert.deepEqual(readCursor(home).mcpServers.doodle, { url: ENDPOINT });
});

test("install rejects a conflicting native registration before writing", async (t) => {
  const home = temporaryHome(t);
  const path = writeCursor(home, { mcpServers: { other: { url: "https://example.test/mcp" } } });
  const before = readFileSync(path, "utf8");
  const runner = fakeRunner({
    installed: ["codex"],
    codex: { url: "https://wrong.test/mcp", resource: "https://wrong.test/mcp" },
  });

  await assert.rejects(
    installAuthenticated({ home, run: runner.run }),
    /conflicting Codex registration/,
  );
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(runner.calls.some(({ args }) => args.includes("add")), false);
});

test("invalid Cursor JSON fails without overwrite or temporary file", async (t) => {
  const home = temporaryHome(t);
  const path = writeCursor(home, "{invalid-json\n");
  const before = readFileSync(path, "utf8");
  const runner = fakeRunner({ installed: [] });

  await assert.rejects(
    installAuthenticated({ home, run: runner.run }),
    /Invalid Cursor MCP configuration/,
  );
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

test("CLI defaults to install and rejects extra arguments", async (t) => {
  const home = temporaryHome(t);
  const runner = fakeRunner({ installed: [] });
  const lines = [];

  assert.equal(
    await main([], {
      home,
      run: runner.run,
      write: (line) => lines.push(line),
      authorize: async () => "access-token",
      downloadPet: async () => testPetPackage(),
      expectedPetFiles: TEST_EXPECTED_FILES,
    }),
    0,
  );
  assert.equal(lines.join("\n").includes("password"), false);
  await assert.rejects(
    main(["install", "extra"], { home, run: runner.run, write: () => {} }),
    /Usage:/,
  );
});

test("install also configures completion notifications for detected Claude or Codex", async (t) => {
  const home = temporaryHome(t);
  const native = fakeRunner({ installed: ["codex"] });
  const calls = [];
  const run = (command, args, options = {}) => {
    calls.push({ command, args: [...args], home: options.env?.HOME });
    if (command === "python3" || command === join(home, ".local", "bin", "doodle-resume-bridge")) {
      return { status: 0, stdout: "", stderr: "" };
    }
    return native.run(command, args, options);
  };
  const lines = [];

  assert.equal(
    await main(["install"], {
      home,
      run,
      write: (line) => lines.push(line),
      authorize: async () => "access-token",
      downloadPet: async () => testPetPackage(),
      expectedPetFiles: TEST_EXPECTED_FILES,
    }),
    0,
  );
  assert.ok(calls.some(({ command, args }) => command === "python3" && args.at(-1) === "install-hooks"));
  assert.ok(
    calls.some(
      ({ command, args }) =>
        command === join(home, ".local", "bin", "doodle-resume-bridge") && args[0] === "login",
    ),
  );
  assert.match(lines.join("\n"), /^Notification: configured$/m);
});

test("resume install uses the bundled bridge without a shell", (t) => {
  const home = temporaryHome(t);
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, home: options.env.HOME });
    return { status: 0, stdout: "" };
  };

  assert.deepEqual(installResume({ home, run }), { resume: "configured" });
  assert.equal(calls[0].command, "python3");
  assert.match(calls[0].args[0], /bridge\/doodle_resume_bridge\.py$/);
  assert.deepEqual(calls[0].args.slice(1), ["install-hooks"]);
  assert.equal(calls[1].command, join(home, ".local", "bin", "doodle-resume-bridge"));
  assert.deepEqual(calls[1].args, ["login"]);
  assert.equal(calls.every((call) => call.home === home), true);
});

test("resume-install rejects authorization before hooks or bridge writes", async (t) => {
  const home = temporaryHome(t);
  const marker = join(home, "hooks-were-written");
  const calls = [];
  const run = (command, args) => {
    calls.push({ command, args: [...args] });
    writeFileSync(marker, "unexpected mutation");
    return { status: 0, stdout: "", stderr: "" };
  };

  await assert.rejects(
    main(["resume-install"], {
      home,
      run,
      write: () => {},
      authorize: async () => {
        throw new Error("Authorization denied.");
      },
    }),
    /Authorization denied/,
  );

  assert.deepEqual(calls, []);
  assert.equal(existsSync(marker), false);
});

test("resume-install validates the protected package before hooks or bridge writes", async (t) => {
  const home = temporaryHome(t);
  const marker = join(home, "hooks-were-written");
  const calls = [];
  const run = (command, args) => {
    calls.push({ command, args: [...args] });
    writeFileSync(marker, "unexpected mutation");
    return { status: 0, stdout: "", stderr: "" };
  };

  await assert.rejects(
    main(["resume-install"], {
      home,
      run,
      write: () => {},
      authorize: async () => "access-token",
      downloadPet: async () => {
        throw new Error("Invalid pet package.");
      },
      expectedPetFiles: TEST_EXPECTED_FILES,
    }),
    /Invalid pet package/,
  );

  assert.deepEqual(calls, []);
  assert.equal(existsSync(marker), false);
});

test("Windows browser launch uses direct shell-free argv", () => {
  const url = "https://mcp.algodoodle.me/oauth/authorize?state=x&scope=mcp%3Aconsult";

  assert.deepEqual(installer.browserCommand("win32", url), {
    command: "rundll32.exe",
    args: ["url.dll,FileProtocolHandler", url],
  });
});

test("resume doctor and uninstall report only safe status", (t) => {
  const home = temporaryHome(t);
  const executable = join(home, ".local", "bin", "doodle-resume-bridge");
  mkdirSync(dirname(executable), { recursive: true });
  writeFileSync(executable, "placeholder");
  const run = (_command, args) => ({
    status: 0,
    stdout: args[0] === "status" ? "authenticated; no runs\n" : "sensitive output",
  });

  assert.deepEqual(doctorResume({ home, run }), { resume: "configured" });
  assert.deepEqual(uninstallResume({ home, run }), { resume: "removed" });
});

test("npm-style bin symlink launches the CLI", (t) => {
  const directory = temporaryHome(t);
  const link = join(directory, "doodle-mcp");
  symlinkSync(resolve("bin/doodle-mcp.mjs"), link);

  const result = spawnSync(process.execPath, [link, "doctor"], { encoding: "utf8" });

  assert.match(result.stdout, /^Codex:/m);
  assert.match(result.stdout, /^Cursor:/m);
});

test("README documents event-driven completion notification without GUI auto-resume", () => {
  const readme = readFileSync(resolve("README.md"), "utf8");

  assert.match(readme, /completion notification/i);
  assert.match(readme, /notify-test --client codex/);
  assert.match(readme, /clipboard/i);
  assert.doesNotMatch(readme, /resumes the original session/i);
});

test("install rejects authorization before any local mutation", async (t) => {
  const home = temporaryHome(t);
  const runner = fakeRunner({ installed: ["codex"] });
  let downloaded = false;

  await assert.rejects(
    main(["install"], {
      home,
      run: runner.run,
      write: () => {},
      authorize: async () => {
        throw new Error("Authorization denied.");
      },
      downloadPet: async () => {
        downloaded = true;
        return testPetPackage();
      },
      expectedPetFiles: TEST_EXPECTED_FILES,
    }),
    /Authorization denied/,
  );

  assert.equal(downloaded, false);
  assert.equal(runner.calls.some(({ args }) => args.includes("add")), false);
  assert.equal(runner.calls.some(({ command }) => command === "python3"), false);
  assert.equal(existsSync(cursorPath(home)), false);
  assert.equal(existsSync(join(home, ".codex", "pets", "mr-doodle")), false);
});

test("install rejects an invalid download before any local mutation", async (t) => {
  const home = temporaryHome(t);
  const runner = fakeRunner({ installed: ["codex"] });

  await assert.rejects(
    main(["install"], {
      home,
      run: runner.run,
      write: () => {},
      authorize: async () => "access-token",
      downloadPet: async () => {
        throw new Error("Invalid spritesheet.webp hash.");
      },
      expectedPetFiles: TEST_EXPECTED_FILES,
    }),
    /Invalid spritesheet\.webp hash/,
  );

  assert.equal(runner.calls.some(({ args }) => args.includes("add")), false);
  assert.equal(runner.calls.some(({ command }) => command === "python3"), false);
  assert.equal(existsSync(cursorPath(home)), false);
  assert.equal(existsSync(join(home, ".codex", "pets", "mr-doodle")), false);
});

test("ephemeral OAuth uses state and S256 PKCE and returns only the access token", async (t) => {
  let base;
  let registration;
  let tokenForm;
  let authorizationUrl;
  const requestOptions = [];
  const oauthServer = createServer(async (request, response) => {
    if (request.url === "/.well-known/oauth-authorization-server") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          authorization_endpoint: `${base}/oauth/authorize`,
          token_endpoint: `${base}/oauth/token`,
          registration_endpoint: `${base}/oauth/register`,
        }),
      );
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (request.url === "/oauth/register") {
      registration = JSON.parse(Buffer.concat(chunks));
      response.statusCode = 201;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ client_id: "installer-client" }));
      return;
    }
    if (request.url === "/oauth/token") {
      tokenForm = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ access_token: "memory-only-token", refresh_token: "ignore" }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  base = await listen(oauthServer);
  t.after(() => oauthServer.close());

  const token = await installer.authorizeInstaller({
    oauthBase: base,
    fetchImpl: (url, options) => {
      requestOptions.push(options);
      return fetch(url, options);
    },
    timeoutMs: 1_000,
    write: () => {},
    openBrowser: (url) => {
      authorizationUrl = new URL(url);
      setImmediate(async () => {
        const callback = new URL(authorizationUrl.searchParams.get("redirect_uri"));
        callback.searchParams.set("code", "authorization-code");
        callback.searchParams.set("state", "wrong-state");
        assert.equal((await fetch(callback)).status, 400);
        callback.searchParams.set("state", authorizationUrl.searchParams.get("state"));
        assert.equal((await fetch(callback)).status, 200);
      });
      return { status: 0 };
    },
  });

  assert.equal(token, "memory-only-token");
  assert.equal(registration.scope, "mcp:consult");
  assert.deepEqual(registration.redirect_uris, [authorizationUrl.searchParams.get("redirect_uri")]);
  assert.equal(authorizationUrl.searchParams.get("scope"), "mcp:consult");
  assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(tokenForm.get("code"), "authorization-code");
  assert.equal(tokenForm.get("resource"), ENDPOINT);
  assert.equal(requestOptions.length, 3);
  assert.equal(requestOptions.every(({ redirect }) => redirect === "error"), true);
  assert.equal(
    createHash("sha256").update(tokenForm.get("code_verifier")).digest("base64url"),
    authorizationUrl.searchParams.get("code_challenge"),
  );
});

test("ephemeral OAuth times out without returning or persisting credentials", async (t) => {
  let base;
  const oauthServer = createServer((request, response) => {
    if (request.url === "/.well-known/oauth-authorization-server") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          authorization_endpoint: `${base}/oauth/authorize`,
          token_endpoint: `${base}/oauth/token`,
          registration_endpoint: `${base}/oauth/register`,
        }),
      );
      return;
    }
    response.statusCode = 201;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ client_id: "installer-client" }));
  });
  base = await listen(oauthServer);
  t.after(() => oauthServer.close());

  await assert.rejects(
    installer.authorizeInstaller({
      oauthBase: base,
      timeoutMs: 20,
      write: () => {},
      openBrowser: () => ({ status: 0 }),
    }),
    /timed out/i,
  );
});

test("OAuth metadata rejects endpoint URLs containing credentials", async (t) => {
  let base;
  const oauthServer = createServer(async (request, response) => {
    if (request.url === "/.well-known/oauth-authorization-server") {
      const credentialEndpoint = new URL(`${base}/oauth/authorize`);
      credentialEndpoint.username = "attacker";
      credentialEndpoint.password = "password";
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          authorization_endpoint: credentialEndpoint.href,
          token_endpoint: `${base}/oauth/token`,
          registration_endpoint: `${base}/oauth/register`,
        }),
      );
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (request.url === "/oauth/register") {
      response.statusCode = 201;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ client_id: "installer-client" }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  base = await listen(oauthServer);
  t.after(() => oauthServer.close());

  await assert.rejects(
    installer.authorizeInstaller({
      oauthBase: base,
      timeoutMs: 1_000,
      write: () => {},
      openBrowser: (url) => {
        const authorization = new URL(url);
        setImmediate(async () => {
          const callback = new URL(authorization.searchParams.get("redirect_uri"));
          callback.searchParams.set("error", "access_denied");
          callback.searchParams.set("state", authorization.searchParams.get("state"));
          await fetch(callback);
        });
        return { status: 0 };
      },
    }),
    /Invalid OAuth server metadata/,
  );
});

test("install orders preflight, auth, validated download, clients, pet, then bridge", async (t) => {
  const home = temporaryHome(t);
  const native = fakeRunner({ installed: ["codex"] });
  const order = [];
  let mutationSeen = false;
  const petDirectory = join(home, ".codex", "pets", "mr-doodle");
  const run = (command, args, options = {}) => {
    if (command === "python3") {
      assert.equal(existsSync(join(petDirectory, "pet.json")), true);
      assert.equal(existsSync(join(petDirectory, "spritesheet.webp")), true);
      order.push("bridge");
      return { status: 0, stdout: "", stderr: "" };
    }
    if (command === join(home, ".local", "bin", "doodle-resume-bridge")) {
      return { status: 0, stdout: "authenticated\n", stderr: "" };
    }
    if (args.includes("add") || (command === "claude" && args[0] === "update")) {
      if (!mutationSeen) order.push("clients");
      mutationSeen = true;
    }
    return native.run(command, args, options);
  };

  await main(["install"], {
    home,
    run,
    write: () => {},
    authorize: async () => {
      assert.equal(native.calls.some(({ args }) => args[0] === "--version"), true);
      assert.equal(mutationSeen, false);
      order.push("authorize");
      return "access-token";
    },
    downloadPet: async (token) => {
      assert.equal(token, "access-token");
      assert.equal(mutationSeen, false);
      order.push("download");
      return testPetPackage();
    },
    expectedPetFiles: TEST_EXPECTED_FILES,
  });

  assert.deepEqual(order, ["authorize", "download", "clients", "bridge"]);
});

test("install rechecks local conflicts after browser authorization", async (t) => {
  const home = temporaryHome(t);
  const runner = fakeRunner({ installed: ["codex"] });
  const conflict = { mcpServers: { doodle: { url: "https://wrong.test/mcp" } } };

  await assert.rejects(
    installAll({
      home,
      run: runner.run,
      authorize: async () => "access-token",
      downloadPet: async () => {
        writeCursor(home, conflict);
        return testPetPackage();
      },
      expectedPetFiles: TEST_EXPECTED_FILES,
      write: () => {},
    }),
    /conflicting Cursor registration/,
  );

  assert.deepEqual(readCursor(home), conflict);
  assert.equal(runner.calls.some(({ args }) => args.includes("add")), false);
});

test("protected download uses only fixed URLs and an in-memory bearer header", async () => {
  const calls = [];
  const pet = testPetPackage();
  const responses = {
    "manifest.json": Buffer.from(JSON.stringify(pet.manifest)),
    "pet.json": pet.petJson,
    "spritesheet.webp": pet.spritesheet,
  };
  const fetchImpl = async (url, options) => {
    calls.push({
      url,
      authorization: options.headers.authorization,
      redirect: options.redirect,
    });
    return new Response(responses[url.split("/").at(-1)], { status: 200 });
  };

  const downloaded = await installer.downloadPetPackage("secret-token", {
    fetchImpl,
    petBase: "https://downloads.example/pets/mr-doodle",
    expected: TEST_EXPECTED_FILES,
  });

  assert.deepEqual(downloaded.petJson, TEST_PET_JSON);
  assert.deepEqual(
    calls.map(({ url }) => url),
    [
      "https://downloads.example/pets/mr-doodle/manifest.json",
      "https://downloads.example/pets/mr-doodle/pet.json",
      "https://downloads.example/pets/mr-doodle/spritesheet.webp",
    ],
  );
  assert.equal(calls.every(({ authorization }) => authorization === "Bearer secret-token"), true);
  assert.equal(calls.every(({ redirect }) => redirect === "error"), true);
  assert.equal(calls.some(({ url }) => url.includes("secret-token")), false);
});

test("package validator pins schema, files, sizes, hashes, and runtime contract", () => {
  const valid = testPetPackage();
  assert.deepEqual(installer.PET_FILES, {
    "pet.json": {
      size: 243,
      sha256: "b52293ab99c3980d8e183136b37ffada9cefefa615d7f4e43fa7da87b3a59ba3",
    },
    "spritesheet.webp": {
      size: 1800536,
      sha256: "90f802458c1cf5b36d3eb6c5e4a55a4024e8c020f17b5a1dbcbbd5e79e527386",
    },
  });
  assert.doesNotThrow(() => installer.validatePetPackage(valid, TEST_EXPECTED_FILES));

  const unknown = testPetPackage();
  unknown.manifest.files.extra = { size: 0, sha256: "0".repeat(64) };
  assert.throws(() => installer.validatePetPackage(unknown, TEST_EXPECTED_FILES), /manifest/);

  const wrongSize = testPetPackage();
  wrongSize.manifest.files["pet.json"] = {
    ...wrongSize.manifest.files["pet.json"],
    size: TEST_PET_JSON.length + 1,
  };
  assert.throws(() => installer.validatePetPackage(wrongSize, TEST_EXPECTED_FILES), /manifest/);

  const wrongHash = testPetPackage();
  wrongHash.petJson = Buffer.from(TEST_PET_JSON);
  wrongHash.petJson[0] ^= 1;
  assert.throws(() => installer.validatePetPackage(wrongHash, TEST_EXPECTED_FILES), /hash/);

  const malformed = testPetPackage();
  malformed.petJson = Buffer.from("{not-json");
  const malformedExpected = {
    ...TEST_EXPECTED_FILES,
    "pet.json": {
      size: malformed.petJson.length,
      sha256: createHash("sha256").update(malformed.petJson).digest("hex"),
    },
  };
  malformed.manifest.files = malformedExpected;
  assert.throws(() => installer.validatePetPackage(malformed, malformedExpected), /pet\.json/);

  const incomplete = testPetPackage();
  delete incomplete.spritesheet;
  assert.throws(() => installer.validatePetPackage(incomplete, TEST_EXPECTED_FILES), /incomplete/);
});

test("pet lifecycle is conservative and Codex-only", (t) => {
  const home = temporaryHome(t);
  const pet = testPetPackage();
  const directory = join(home, ".codex", "pets", "mr-doodle");

  assert.equal(
    installer.installPet(pet, { home, codexInstalled: false, expected: TEST_EXPECTED_FILES }),
    "not_installed",
  );
  assert.equal(existsSync(directory), false);
  assert.equal(installer.doctorPet({ home, expected: TEST_EXPECTED_FILES }), "missing");

  assert.equal(
    installer.installPet(pet, { home, codexInstalled: true, expected: TEST_EXPECTED_FILES }),
    "configured",
  );
  assert.deepEqual(readFileSync(join(directory, "spritesheet.webp")), TEST_SPRITESHEET);
  assert.deepEqual(readFileSync(join(directory, "pet.json")), TEST_PET_JSON);
  assert.equal(installer.doctorPet({ home, expected: TEST_EXPECTED_FILES }), "configured");
  assert.equal(
    installer.installPet(pet, { home, codexInstalled: true, expected: TEST_EXPECTED_FILES }),
    "unchanged",
  );

  assert.equal(installer.uninstallPet({ home, expected: TEST_EXPECTED_FILES }), "removed");
  assert.equal(existsSync(join(directory, "pet.json")), false);
  assert.equal(existsSync(join(directory, "spritesheet.webp")), false);
});

test("pet conflicts stay byte-for-byte untouched", (t) => {
  const home = temporaryHome(t);
  const pet = testPetPackage();
  const directory = join(home, ".codex", "pets", "mr-doodle");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "pet.json"), TEST_PET_JSON);
  const before = readFileSync(join(directory, "pet.json"));

  assert.equal(installer.doctorPet({ home, expected: TEST_EXPECTED_FILES }), "conflict");
  assert.equal(
    installer.installPet(pet, { home, codexInstalled: true, expected: TEST_EXPECTED_FILES }),
    "conflict",
  );
  assert.deepEqual(readFileSync(join(directory, "pet.json")), before);
  assert.equal(installer.uninstallPet({ home, expected: TEST_EXPECTED_FILES }), "conflict");
  assert.deepEqual(readFileSync(join(directory, "pet.json")), before);
});

test("pet uses CODEX_HOME and uninstall preserves non-package files", (t) => {
  const home = temporaryHome(t);
  const codexHome = join(home, "custom-codex");
  const directory = join(codexHome, "pets", "mr-doodle");

  assert.equal(
    installer.installPet(testPetPackage(), {
      home,
      codexHome,
      codexInstalled: true,
      expected: TEST_EXPECTED_FILES,
    }),
    "configured",
  );
  writeFileSync(join(directory, "notes.txt"), "keep me");

  assert.equal(installer.doctorPet({ home, codexHome, expected: TEST_EXPECTED_FILES }), "conflict");
  assert.equal(
    installer.uninstallPet({ home, codexHome, expected: TEST_EXPECTED_FILES }),
    "conflict",
  );
  assert.equal(readFileSync(join(directory, "notes.txt"), "utf8"), "keep me");
  assert.deepEqual(readFileSync(join(directory, "pet.json")), TEST_PET_JSON);
  assert.deepEqual(readFileSync(join(directory, "spritesheet.webp")), TEST_SPRITESHEET);
});

test("pet rejects a symlinked pets directory without writing outside Codex", (t) => {
  const home = temporaryHome(t);
  const outside = join(home, "outside");
  const pets = join(home, ".codex", "pets");
  mkdirSync(dirname(pets), { recursive: true });
  mkdirSync(outside);
  symlinkSync(outside, pets, "dir");

  assert.equal(installer.doctorPet({ home, expected: TEST_EXPECTED_FILES }), "conflict");
  assert.equal(
    installer.installPet(testPetPackage(), {
      home,
      codexInstalled: true,
      expected: TEST_EXPECTED_FILES,
    }),
    "conflict",
  );
  assert.equal(installer.uninstallPet({ home, expected: TEST_EXPECTED_FILES }), "conflict");
  assert.deepEqual(readdirSync(outside), []);
});

test("README states the auth-first public-package boundary", () => {
  const readme = readFileSync(resolve("README.md"), "utf8");

  assert.match(readme, /before making any local changes/i);
  assert.match(readme, /contains no pet binary/i);
  assert.match(readme, /Codex-only/i);
  assert.match(readme, /own OAuth session/i);
});
