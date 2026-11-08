import "server-only";
import { HANDLERS } from "@/lib/jobs/handlers";
import {
  claimJob,
  finishJob,
  finishRun,
  listDueJobs,
  recoverInterrupted,
  startRun,
  type Job,
} from "@/lib/jobs/store";

const TICK_MS = 5_000;
const JOB_TIMEOUT_MS = 5 * 60_000;
const LEASE_MS = JOB_TIMEOUT_MS + 60_000;
const MAX_CONCURRENT = 4;

interface SchedulerState {
  timer: NodeJS.Timeout;
  running: Set<string>;
  lastError?: string;
}

const globalState = globalThis as { __statofactScheduler?: SchedulerState };

async function execute(job: Job, wasDue: boolean): Promise<void> {
  const startedAt = Date.now();
  const runId = await startRun(job.id, startedAt);
  const lines: string[] = [];
  const log = (message: string) =>
    lines.push(`${new Date().toISOString()} ${message}`);

  let status: "success" | "failed" = "success";
  const handler = Object.hasOwn(HANDLERS, job.handler) ? HANDLERS[job.handler] : undefined;
  try {
    if (!handler) throw new Error(`Unbekannter Handler "${job.handler}".`);
    const signal = AbortSignal.timeout(JOB_TIMEOUT_MS);
    const aborted = new Promise<never>((_, reject) =>
      signal.addEventListener("abort", () => reject(new Error("Zeitüberschreitung.")), { once: true }),
    );
    // Hängt ein Handler, ohne das Signal zu beachten, bricht das Race den Lauf trotzdem ab.
    await Promise.race([handler.run(job.params, { log, signal }), aborted]);
    log("Erfolgreich beendet.");
  } catch (error) {
    status = "failed";
    log(`Fehler: ${error instanceof Error ? error.message : String(error)}`);
  }

  const finishedAt = Date.now();
  await finishRun(runId, status, lines.join("\n"), finishedAt);

  let schedule: { enabled: boolean; nextRunAt: number | null } | undefined;
  if (wasDue) {
    schedule =
      job.scheduleType === "interval" && job.intervalMinutes
        ? { enabled: true, nextRunAt: finishedAt + job.intervalMinutes * 60_000 }
        : { enabled: false, nextRunAt: null };
  }
  await finishJob(job.id, { status, startedAt, schedule });
}

async function tick(state: SchedulerState): Promise<void> {
  try {
    const now = Date.now();
    const due = await listDueJobs(now);
    for (const job of due) {
      if (state.running.size >= MAX_CONCURRENT) break;
      if (state.running.has(job.id)) continue;
      if (!(await claimJob(job.id, now, now + LEASE_MS))) continue;

      const wasDue = job.enabled && job.nextRunAt !== undefined && job.nextRunAt <= now;
      state.running.add(job.id);
      void execute(job, wasDue)
        .catch((error) => console.error(`[jobs] ${job.name}:`, error))
        .finally(() => state.running.delete(job.id));
    }
    state.lastError = undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== state.lastError) console.error(`[jobs] Scheduler: ${message}`);
    state.lastError = message;
  }
}

export function startScheduler(): void {
  if (process.env.JOBRUNNER === "off" || globalState.__statofactScheduler) return;

  const state: SchedulerState = {
    timer: setInterval(() => void tick(state), TICK_MS),
    running: new Set(),
  };
  state.timer.unref();
  globalState.__statofactScheduler = state;

  recoverInterrupted(Date.now())
    .catch((error) => console.error("[jobs] Wiederherstellung fehlgeschlagen:", error))
    .finally(() => void tick(state));
  console.log("[jobs] Scheduler gestartet.");
}
