import "server-only";
import { command, query } from "@/lib/arcadedb";
import { ModelError, isValidId, toUrlId } from "@/lib/cmdb";

export type JobStatus = "running" | "success" | "failed";
export type ScheduleType = "once" | "interval";
export type ParamValue = string | number | null;

export interface Job {
  id: string;
  name: string;
  handler: string;
  params: Record<string, ParamValue>;
  scheduleType: ScheduleType;
  intervalMinutes?: number;
  nextRunAt?: number;
  enabled: boolean;
  runRequested: boolean;
  lockedUntil?: number;
  lastRunAt?: number;
  lastStatus?: JobStatus;
}

export interface JobRun {
  id: string;
  jobId: string;
  startedAt: number;
  finishedAt?: number;
  status: JobStatus;
  log: string;
}

export const MAX_LOG_LENGTH = 20000;

function toRid(id: string): string {
  if (!isValidId(id)) throw new ModelError(`Ungültige ID: ${id}`);
  return id.startsWith("#") ? id : `#${id}`;
}

function optNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function parseParams(raw: unknown): Record<string, ParamValue> {
  if (typeof raw !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, ParamValue>) : {};
  } catch {
    return {};
  }
}

function toJob(row: Record<string, unknown>): Job {
  return {
    id: toUrlId(String(row["@rid"])),
    name: String(row.name ?? ""),
    handler: String(row.handler ?? ""),
    params: parseParams(row.params),
    scheduleType: row.scheduleType === "once" ? "once" : "interval",
    intervalMinutes: optNumber(row.intervalMinutes),
    nextRunAt: optNumber(row.nextRunAt),
    enabled: row.enabled === true,
    runRequested: row.runRequested === true,
    lockedUntil: optNumber(row.lockedUntil),
    lastRunAt: optNumber(row.lastRunAt),
    lastStatus: row.lastStatus as JobStatus | undefined,
  };
}

function toRun(row: Record<string, unknown>): JobRun {
  return {
    id: toUrlId(String(row["@rid"])),
    jobId: String(row.jobId ?? ""),
    startedAt: Number(row.startedAt ?? 0),
    finishedAt: optNumber(row.finishedAt),
    status: (row.status as JobStatus) ?? "failed",
    log: String(row.log ?? ""),
  };
}

export async function listJobs(): Promise<Job[]> {
  const rows = await query<Record<string, unknown>>("SELECT FROM Job ORDER BY name");
  return rows.map(toJob);
}

export async function getJob(id: string): Promise<Job | null> {
  if (!isValidId(id)) return null;
  const rows = await query<Record<string, unknown>>(
    "SELECT FROM Job WHERE @rid = :rid",
    { rid: toRid(id) },
  );
  return rows[0] ? toJob(rows[0]) : null;
}

export async function createJob(input: {
  name: string;
  handler: string;
  params: Record<string, ParamValue>;
  scheduleType: ScheduleType;
  intervalMinutes?: number;
  firstRunAt: number;
}): Promise<string> {
  const rows = await command<{ "@rid": string }>(
    `CREATE VERTEX Job SET name = :name, handler = :handler, params = :params,
       scheduleType = :scheduleType, intervalMinutes = :intervalMinutes,
       nextRunAt = :nextRunAt, enabled = true, runRequested = false, createdAt = :now`,
    {
      name: input.name,
      handler: input.handler,
      params: JSON.stringify(input.params),
      scheduleType: input.scheduleType,
      intervalMinutes: input.intervalMinutes ?? null,
      nextRunAt: input.firstRunAt,
      now: Date.now(),
    },
  );
  return toUrlId(rows[0]["@rid"]);
}

export async function setJobEnabled(id: string, enabled: boolean): Promise<void> {
  const job = await getJob(id);
  if (!job) throw new ModelError("Job nicht gefunden.");
  const now = Date.now();
  // Beim Aktivieren keinen verpassten Termin verlieren: sofort fällig machen.
  const nextRunAt =
    enabled && (job.nextRunAt === undefined || job.nextRunAt < now)
      ? now
      : (job.nextRunAt ?? null);
  await command("UPDATE Job SET enabled = :enabled, nextRunAt = :nextRunAt WHERE @rid = :rid", {
    enabled,
    nextRunAt,
    rid: toRid(id),
  });
}

export async function requestRun(id: string): Promise<void> {
  await command("UPDATE Job SET runRequested = true WHERE @rid = :rid", { rid: toRid(id) });
}

export async function deleteJob(id: string): Promise<void> {
  const rid = toRid(id);
  await command("DELETE FROM JobRun WHERE jobId = :id", { id: toUrlId(rid) });
  await command("DELETE FROM Job WHERE @rid = :rid", { rid });
}

export async function listRuns(jobId: string, limit = 20): Promise<JobRun[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT FROM JobRun WHERE jobId = :id ORDER BY startedAt DESC LIMIT ${Math.max(1, Math.floor(limit))}`,
    { id: toUrlId(jobId) },
  );
  return rows.map(toRun);
}

export async function deleteRunsOlderThan(cutoff: number): Promise<number> {
  const rows = await command<{ count: number }>(
    "DELETE FROM JobRun WHERE status <> 'running' AND startedAt < :cutoff",
    { cutoff },
  );
  return rows[0]?.count ?? 0;
}

// --- Scheduler-Hilfen ---

export async function listDueJobs(now: number): Promise<Job[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT FROM Job WHERE (lockedUntil IS NULL OR lockedUntil < :now)
       AND ((enabled = true AND nextRunAt <= :now) OR runRequested = true)`,
    { now },
  );
  return rows.map(toJob);
}

// Atomarer Claim: nur ein Prozess bekommt den Job (Lease bis `until`).
export async function claimJob(id: string, now: number, until: number): Promise<boolean> {
  const rows = await command<{ count: number }>(
    `UPDATE Job SET lockedUntil = :until, runRequested = false
       WHERE @rid = :rid AND (lockedUntil IS NULL OR lockedUntil < :now)`,
    { rid: toRid(id), until, now },
  );
  return (rows[0]?.count ?? 0) > 0;
}

export async function startRun(jobId: string, startedAt: number): Promise<string> {
  const rows = await command<{ "@rid": string }>(
    "CREATE VERTEX JobRun SET jobId = :jobId, startedAt = :startedAt, status = 'running', log = ''",
    { jobId: toUrlId(jobId), startedAt },
  );
  return toUrlId(rows[0]["@rid"]);
}

export async function finishRun(
  runId: string,
  status: JobStatus,
  log: string,
  finishedAt: number,
): Promise<void> {
  await command(
    "UPDATE JobRun SET status = :status, log = :log, finishedAt = :finishedAt WHERE @rid = :rid",
    { rid: toRid(runId), status, log: log.slice(0, MAX_LOG_LENGTH), finishedAt },
  );
}

export async function finishJob(
  id: string,
  update: {
    status: JobStatus;
    startedAt: number;
    // Nur setzen, wenn der Lauf planmäßig fällig war (nicht bei "Jetzt ausführen").
    schedule?: { enabled: boolean; nextRunAt: number | null };
  },
): Promise<void> {
  const sets = ["lockedUntil = null", "lastRunAt = :startedAt", "lastStatus = :status"];
  const params: Record<string, unknown> = {
    rid: toRid(id),
    startedAt: update.startedAt,
    status: update.status,
  };
  if (update.schedule) {
    sets.push("enabled = :enabled", "nextRunAt = :nextRunAt");
    params.enabled = update.schedule.enabled;
    params.nextRunAt = update.schedule.nextRunAt;
  }
  await command(`UPDATE Job SET ${sets.join(", ")} WHERE @rid = :rid`, params);
}

// Nach einem Neustart hängen gebliebene Läufe und Sperren freigeben.
export async function recoverInterrupted(now: number): Promise<void> {
  await command(
    "UPDATE JobRun SET status = 'failed', finishedAt = :now WHERE status = 'running'",
    { now },
  );
  await command("UPDATE Job SET lockedUntil = null WHERE lockedUntil IS NOT NULL");
}
