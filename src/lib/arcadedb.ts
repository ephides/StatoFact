import "server-only";

type Params = Record<string, unknown>;

interface ArcadeResponse<T> {
  result: T[];
}

export class ArcadeDBError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ArcadeDBError";
  }
}

function config() {
  const url = (process.env.ARCADEDB_URL ?? "http://localhost:2480").replace(
    /\/+$/,
    "",
  );
  const database = process.env.ARCADEDB_DATABASE;
  const user = process.env.ARCADEDB_USER ?? "root";
  const password = process.env.ARCADEDB_PASSWORD ?? "";
  return { url, database, user, password };
}

async function request<T>(
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown } = {},
): Promise<T> {
  const { url, user, password } = config();
  const auth = Buffer.from(`${user}:${password}`).toString("base64");

  let res: Response;
  try {
    res = await fetch(`${url}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
    });
  } catch {
    throw new ArcadeDBError(`ArcadeDB nicht erreichbar unter ${url}`);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new ArcadeDBError(
      `ArcadeDB-Fehler ${res.status}: ${text.slice(0, 500)}`,
      res.status,
    );
  }
  return (await res.json()) as T;
}

function databaseName(): string {
  const { database } = config();
  if (!database) {
    throw new ArcadeDBError("ARCADEDB_DATABASE ist nicht gesetzt");
  }
  return encodeURIComponent(database);
}

/** Lesende Abfrage (idempotent), z. B. SELECT. */
export async function query<T = Record<string, unknown>>(
  command: string,
  params: Params = {},
  language = "sql",
  limit?: number,
): Promise<T[]> {
  const data = await request<ArcadeResponse<T>>(
    `/api/v1/query/${databaseName()}`,
    { method: "POST", body: { language, command, params, ...(limit === undefined ? {} : { limit }) } },
  );
  return data.result;
}

/** Schreibender Befehl, z. B. INSERT, UPDATE, CREATE. */
export async function command<T = Record<string, unknown>>(
  commandText: string,
  params: Params = {},
  language = "sql",
): Promise<T[]> {
  const data = await request<ArcadeResponse<T>>(
    `/api/v1/command/${databaseName()}`,
    { method: "POST", body: { language, command: commandText, params } },
  );
  return data.result;
}

/** Führt mehrere SQL-Anweisungen in einem ArcadeDB-Batch aus. */
export async function batch(
  script: string,
  params: Params = {},
): Promise<void> {
  await request<ArcadeResponse<unknown>>(
    `/api/v1/command/${databaseName()}`,
    {
      method: "POST",
      body: {
        language: "sqlscript",
        command: script,
        params,
        autoCommit: true,
      },
    },
  );
}

export async function listDatabases(): Promise<string[]> {
  const data = await request<ArcadeResponse<string>>("/api/v1/databases");
  return data.result;
}

export async function ping(): Promise<{
  server: boolean;
  authenticated: boolean;
  databases?: string[];
}> {
  const { url } = config();
  let ready: Response;
  try {
    ready = await fetch(`${url}/api/v1/ready`, { cache: "no-store" });
  } catch {
    throw new ArcadeDBError(`ArcadeDB nicht erreichbar unter ${url}`);
  }
  if (!ready.ok) return { server: false, authenticated: false };
  try {
    return {
      server: true,
      authenticated: true,
      databases: await listDatabases(),
    };
  } catch (error) {
    if (error instanceof ArcadeDBError && error.status === 403) {
      return { server: true, authenticated: false };
    }
    throw error;
  }
}
