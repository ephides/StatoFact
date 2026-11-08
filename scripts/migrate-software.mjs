// Ergänzt globale Software-CIs zu den bestehenden hostbezogenen Installationen.
const url = (process.env.ARCADEDB_URL ?? "http://localhost:2480").replace(/\/+$/, "");
const database = process.env.ARCADEDB_DATABASE;
const user = process.env.ARCADEDB_ADMIN_USER;
const password = process.env.ARCADEDB_ADMIN_PASSWORD;
if (!database || !user || password === undefined) {
  throw new Error("ARCADEDB_DATABASE, ARCADEDB_ADMIN_USER und ARCADEDB_ADMIN_PASSWORD müssen gesetzt sein.");
}
const headers = {
  Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`,
  "Content-Type": "application/json",
};
const db = encodeURIComponent(database);
async function request(kind, command, params = {}, language = "sql") {
  const res = await fetch(`${url}/api/v1/${kind}/${db}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ language, command, params, limit: 100000 }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ArcadeDB ${res.status}: ${text.slice(0, 1000)}`);
  return JSON.parse(text).result;
}
const select = (sql, params = {}) => request("query", sql, params);
const execute = (sql, params = {}) => request("command", sql, params);
async function executeBatches(statements) {
  for (let i = 0; i < statements.length; i += 100) {
    const chunk = statements.slice(i, i + 100);
    await request(
      "command",
      `${chunk.map((s) => s.sql).join(";\n")};`,
      Object.assign({}, ...chunk.map((s) => s.params)),
      "sqlscript",
    );
  }
}
const id = (value) => String(value ?? "").replace(/^#/, "");
const rid = (value) => {
  const result = `#${id(value)}`;
  if (!/^#\d+:\d+$/.test(result)) throw new Error(`Ungültige CI-ID: ${value}`);
  return result;
};

async function assertFits(sql, description) {
  const [row] = await select(sql);
  const count = Number(row.c);
  if (!Number.isSafeInteger(count) || count < 0 || count > 100000) {
    throw new Error(`${description}: mehr als 100000 Einträge; Migration abgebrochen, um keine Daten zu übersehen.`);
  }
  return count;
}
const installationCount = await assertFits("SELECT count(*) AS c FROM SoftwarePackage WHERE hostId IS NOT NULL", "Installationen");
const softwareCount = await assertFits("SELECT count(*) AS c FROM Software", "Softwarepakete");
const edgeCount = await assertFits("SELECT count(*) AS c FROM Relation WHERE kind = 'installation_of'", "Software-Zuordnungen");

const installations = await select(
  "SELECT @rid, packageName, version, architecture, hostId FROM SoftwarePackage WHERE hostId IS NOT NULL LIMIT 100000",
);
const software = await select(
  "SELECT @rid, name FROM Software LIMIT 100000",
);
if (installations.length !== installationCount || software.length !== softwareCount) {
  throw new Error("Unvollständige Abfrage oder gleichzeitige Änderungen; Migration abgebrochen.");
}

const softwareByName = new Map();
for (const item of software) {
  if (softwareByName.has(item.name)) {
    throw new Error(`Softwarepaket "${item.name}" ist mehrfach vorhanden; Migration abgebrochen.`);
  }
  softwareByName.set(item.name, id(item["@rid"]));
}
const identities = new Set();
for (const item of installations) {
  if (
    typeof item.packageName !== "string" || !item.packageName ||
    typeof item.architecture !== "string" || !item.architecture ||
    typeof item.version !== "string" || !item.version ||
    !/^\d+:\d+$/.test(String(item.hostId ?? ""))
  ) {
    throw new Error(`Unvollständige Installation ${item["@rid"]}; Migration abgebrochen.`);
  }
  const key = `${item.hostId}\0${item.packageName}\0${item.architecture}`;
  if (identities.has(key)) {
    throw new Error(`Doppelte Installation ${item.packageName} für ${item.hostId}; Migration abgebrochen.`);
  }
  identities.add(key);
}

const all = installations;
const names = [...new Set(all.map((item) => item.packageName))];
if (softwareByName.size + names.filter((name) => !softwareByName.has(name)).length > 100000) {
  throw new Error("Mehr als 100000 Softwarepakete nach Migration; Migration abgebrochen.");
}
await executeBatches(
  names.filter((name) => !softwareByName.has(name)).map((name, i) => ({
    sql: `CREATE VERTEX Software SET name = :n${i}, status = 'Active', createdAt = sysdate(), updatedAt = sysdate()`,
    params: { [`n${i}`]: name },
  })),
);
const allSoftware = await select("SELECT @rid, name FROM Software LIMIT 100000");
if (allSoftware.length !== softwareCount + names.filter((name) => !softwareByName.has(name)).length) {
  throw new Error("Software-Abfrage unvollständig oder gleichzeitig geändert; Migration abgebrochen.");
}
for (const item of allSoftware) {
  if (softwareByName.has(item.name) && softwareByName.get(item.name) !== id(item["@rid"])) {
    throw new Error(`Softwarepaket "${item.name}" ist mehrfach vorhanden.`);
  }
  softwareByName.set(item.name, id(item["@rid"]));
}
const edges = await select(
  "SELECT @out AS fromId, @in AS toId FROM Relation WHERE kind = 'installation_of' LIMIT 100000",
);
if (edges.length !== edgeCount) {
  throw new Error("Software-Zuordnungen unvollständig oder gleichzeitig geändert; Migration abgebrochen.");
}
const byInstallation = new Map();
for (const edge of edges) {
  const from = id(edge.fromId);
  const to = id(edge.toId);
  if (byInstallation.has(from)) {
    throw new Error(`Installation ${from} hat mehrere Software-Zuordnungen.`);
  }
  byInstallation.set(from, to);
}
const missing = [];
for (const item of all) {
  const from = id(item["@rid"]);
  const to = softwareByName.get(item.packageName);
  if (!to) throw new Error(`Softwarepaket ${item.packageName} nicht gefunden.`);
  if (byInstallation.has(from) && byInstallation.get(from) !== to) {
    throw new Error(`Installation ${from} ist einem anderen Softwarepaket zugeordnet.`);
  }
  if (!byInstallation.has(from)) missing.push({ from, to });
}
await executeBatches(missing.map(({ from, to }, i) => ({
  sql: `CREATE EDGE Relation FROM (SELECT FROM CI WHERE @rid = :from${i}) TO (SELECT FROM CI WHERE @rid = :to${i}) SET kind = 'installation_of'`,
  params: { [`from${i}`]: rid(from), [`to${i}`]: rid(to) },
})));
await execute("CREATE INDEX IF NOT EXISTS ON Software (name) UNIQUE");
console.log(`Softwaremigration abgeschlossen: ${all.length} Installationen, ${names.length} Softwarepakete.`);
