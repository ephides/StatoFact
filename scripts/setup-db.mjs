// Idempotentes Schema-Setup (inkl. Migration vom einfachen CI-Modell).
// Benötigt Admin-Zugang: ARCADEDB_ADMIN_USER / ARCADEDB_ADMIN_PASSWORD.
import {
  CI_TYPES,
  COMMON_FIELDS,
  RELATION_FIELDS,
} from "../src/lib/model.ts";

const url = (process.env.ARCADEDB_URL ?? "http://localhost:2480").replace(/\/+$/, "");
const database = process.env.ARCADEDB_DATABASE;
const user = process.env.ARCADEDB_ADMIN_USER;
const password = process.env.ARCADEDB_ADMIN_PASSWORD;

if (!database || !user || password === undefined) {
  console.error(
    "ARCADEDB_DATABASE, ARCADEDB_ADMIN_USER und ARCADEDB_ADMIN_PASSWORD müssen gesetzt sein.",
  );
  process.exit(1);
}

const headers = {
  Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`,
  "Content-Type": "application/json",
};

async function post(path, body) {
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${path}: ${text}`);
  return JSON.parse(text);
}

const db = encodeURIComponent(database);
const sql = (command) => post(`/api/v1/command/${db}`, { language: "sql", command });
const select = (command) =>
  post(`/api/v1/query/${db}`, { language: "sql", command }).then((r) => r.result);

async function run(command) {
  await sql(command);
  console.log(`OK  ${command}`);
}

const sqlType = (field) => (field.kind === "number" ? "INTEGER" : "STRING");

const databases = await fetch(`${url}/api/v1/databases`, { headers })
  .then((r) => r.json())
  .then((d) => d.result);

if (!databases.includes(database)) {
  await post("/api/v1/server", { command: `create database ${database}` });
  console.log(`Datenbank '${database}' angelegt`);
}

await run("CREATE VERTEX TYPE CI IF NOT EXISTS");

// Migration: Namen müssen nicht mehr global eindeutig sein, und der Typ
// steckt jetzt im Vertex-Typ statt in der Property CI.type.
const indexes = await select("SELECT FROM schema:indexes");
for (const index of indexes) {
  if (index.typeName === "CI" && index.unique && index.name === "CI[name]") {
    await run("DROP INDEX `CI[name]`");
  }
}
await run("DROP PROPERTY CI.type IF EXISTS");

await run("CREATE PROPERTY CI.name IF NOT EXISTS STRING (mandatory true, notnull true)");
await run("CREATE PROPERTY CI.createdAt IF NOT EXISTS DATETIME");
await run("CREATE PROPERTY CI.updatedAt IF NOT EXISTS DATETIME");
for (const field of COMMON_FIELDS) {
  await run(`CREATE PROPERTY CI.${field.name} IF NOT EXISTS ${sqlType(field)}`);
}

for (const [type, def] of Object.entries(CI_TYPES)) {
  await run(`CREATE VERTEX TYPE ${type} IF NOT EXISTS EXTENDS CI`);
  for (const field of def.fields) {
    await run(`CREATE PROPERTY ${type}.${field.name} IF NOT EXISTS ${sqlType(field)}`);
  }
}
await run("CREATE PROPERTY VirtualMachine.hypervisorSource IF NOT EXISTS STRING");
await run("CREATE INDEX IF NOT EXISTS ON VirtualMachine (hypervisorSource) UNIQUE");
await run("CREATE INDEX IF NOT EXISTS ON Software (name) UNIQUE");

await run("CREATE EDGE TYPE Relation IF NOT EXISTS");
await run("CREATE PROPERTY Relation.kind IF NOT EXISTS STRING (mandatory true, notnull true)");
for (const field of Object.values(RELATION_FIELDS)) {
  await run(`CREATE PROPERTY Relation.${field.name} IF NOT EXISTS ${sqlType(field)}`);
}

// Jobrunner: Jobs und ihre Läufe (Zeitstempel als Epoch-Millisekunden).
await run("CREATE VERTEX TYPE Job IF NOT EXISTS");
const jobProps = {
  name: "STRING (mandatory true, notnull true)",
  handler: "STRING (mandatory true, notnull true)",
  params: "STRING",
  scheduleType: "STRING (mandatory true, notnull true)",
  intervalMinutes: "INTEGER",
  nextRunAt: "LONG",
  enabled: "BOOLEAN",
  runRequested: "BOOLEAN",
  lockedUntil: "LONG",
  lastRunAt: "LONG",
  lastStatus: "STRING",
  createdAt: "LONG",
};
for (const [name, def] of Object.entries(jobProps)) {
  await run(`CREATE PROPERTY Job.${name} IF NOT EXISTS ${def}`);
}

await run("CREATE VERTEX TYPE JobRun IF NOT EXISTS");
const runProps = {
  jobId: "STRING (mandatory true, notnull true)",
  startedAt: "LONG",
  finishedAt: "LONG",
  status: "STRING",
  log: "STRING",
};
for (const [name, def] of Object.entries(runProps)) {
  await run(`CREATE PROPERTY JobRun.${name} IF NOT EXISTS ${def}`);
}
await run("CREATE INDEX IF NOT EXISTS ON JobRun (jobId) NOTUNIQUE");

console.log("Schema bereit.");
