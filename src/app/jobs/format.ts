import type { Job } from "@/lib/jobs/store";

export function formatTime(ms?: number): string {
  if (ms === undefined) return "–";
  return new Date(ms).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "medium" });
}

export function describeSchedule(job: Job): string {
  if (job.scheduleType === "once") return "einmalig";
  const m = job.intervalMinutes ?? 0;
  if (m % 1440 === 0) return `alle ${m / 1440} Tage`;
  if (m % 60 === 0) return `alle ${m / 60} Std.`;
  return `alle ${m} Min.`;
}

export const STATUS_LABELS = {
  running: "läuft",
  success: "erfolgreich",
  failed: "fehlgeschlagen",
} as const;
