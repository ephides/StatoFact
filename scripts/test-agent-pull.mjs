import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";

const nativeRequire = createRequire(import.meta.url);

function load(file, dependencies) {
  const source = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(source, {
    module: mod, exports: mod.exports, Buffer, URL, AbortSignal,
    require: (id) => Object.hasOwn(dependencies, id) ? dependencies[id] : nativeRequire(id),
  }, { filename: file });
  return mod.exports;
}

async function main() {
  let invocation;
  let next = { stdout: '{"type":"Device","name":"example"}', stderr: "", code: 0 };
  const spawn = (command, args, options) => {
    invocation = { command, args, options };
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; };
    process.nextTick(() => {
      child.stdout.emit("data", Buffer.from(next.stdout));
      child.stderr.emit("data", Buffer.from(next.stderr));
      child.emit("close", next.code);
    });
    return child;
  };
  const { fetchAgentReport } = load("src/lib/jobs/ssh-agent.ts", {
    "server-only": {}, "node:child_process": { spawn },
  });
  const signal = new AbortController().signal;
  const result = await fetchAgentReport("10.0.0.9", "statofact", 22, signal);
  assert.equal(result.name, "example");
  assert.equal(invocation.command, "ssh");
  assert.ok(invocation.args.includes("StrictHostKeyChecking=yes"));
  assert.ok(invocation.args.includes("BatchMode=yes"));
  assert.equal(invocation.args.at(-1), "sudo -n /usr/bin/statofact-agent --pull");
  assert.equal(invocation.options.signal, signal);
  await assert.rejects(() => fetchAgentReport("-oProxyCommand=x", "statofact", 22, signal), /Host/);
  await assert.rejects(() => fetchAgentReport("host", "user;id", 22, signal), /Benutzer/);
  next = { stdout: "", stderr: "Host key verification failed", code: 255 };
  await assert.rejects(() => fetchAgentReport("host", "user", 22, signal), /Host key verification failed/);
  next = { stdout: "not json", stderr: "", code: 0 };
  await assert.rejects(() => fetchAgentReport("host", "user", 22, signal), /JSON/);
  next = { stdout: "x".repeat(4 * 1024 * 1024 + 1), stderr: "", code: 0 };
  await assert.rejects(() => fetchAgentReport("host", "user", 22, signal), /zu groß/);

  let imported;
  const logs = [];
  const { HANDLERS } = load("src/lib/jobs/handlers.ts", {
    "server-only": {},
    "@/lib/cmdb": {},
    "@/lib/ingest": { ingestItem: async (item) => { imported = item; return { ...item, result: "created", packages: 1 }; } },
    "@/lib/jobs/store": {},
    "@/lib/jobs/ssh-agent": { fetchAgentReport: async () => ({ type: "Device", name: "test", packages: [{ name: "test" }] }) },
  });
  await HANDLERS.agent_pull.run({ host: "host", user: "user", port: 22 }, { signal, log: (line) => logs.push(line) });
  assert.equal(imported.packages[0].name, "test");
  assert.match(logs[0], /Pakete: 1/);
  console.log("Agent-Pull: SSH-Validierung, Fehler, Größenlimit und Import erfolgreich getestet.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
