"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { FormState } from "@/app/actions";
import { isValidId } from "@/lib/cmdb";
import { parseFields } from "@/lib/form";
import { HANDLERS, isHandler } from "@/lib/jobs/handlers";
import {
  createJob,
  deleteJob,
  requestRun,
  setJobEnabled,
  type ParamValue,
  type ScheduleType,
} from "@/lib/jobs/store";

const MAX_INTERVAL_MINUTES = 10080;

export async function createJobAction(
  handler: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!isHandler(handler)) return { error: "Ungültiger Job-Typ." };

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Name ist erforderlich." };
  if (name.length > 200) return { error: "Name ist zu lang (max. 200 Zeichen)." };

  const scheduleType = String(formData.get("scheduleType") ?? "");
  if (scheduleType !== "once" && scheduleType !== "interval") {
    return { error: "Bitte einen Zeitplan wählen." };
  }

  let intervalMinutes: number | undefined;
  if (scheduleType === "interval") {
    intervalMinutes = Number(formData.get("intervalMinutes"));
    if (
      !Number.isInteger(intervalMinutes) ||
      intervalMinutes < 1 ||
      intervalMinutes > MAX_INTERVAL_MINUTES
    ) {
      return { error: `Intervall: ganze Minuten zwischen 1 und ${MAX_INTERVAL_MINUTES}.` };
    }
  }

  // Leer = sofort; sonst Ortszeit des Servers (datetime-local).
  const runAtRaw = String(formData.get("runAt") ?? "").trim();
  const firstRunAt = runAtRaw ? new Date(runAtRaw).getTime() : Date.now();
  if (Number.isNaN(firstRunAt)) return { error: "Ungültiger Startzeitpunkt." };

  const parsed = parseFields(HANDLERS[handler].fields, formData);
  if ("error" in parsed) return parsed;
  const params: Record<string, ParamValue> = parsed.values;

  let id: string;
  try {
    id = await createJob({
      name,
      handler,
      params,
      scheduleType: scheduleType as ScheduleType,
      intervalMinutes,
      firstRunAt,
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  revalidatePath("/jobs");
  redirect(`/jobs/${id}`);
}

export async function toggleJobAction(id: string, enabled: boolean): Promise<void> {
  if (!isValidId(id)) return;
  await setJobEnabled(id, enabled);
  revalidatePath("/jobs");
  revalidatePath(`/jobs/${id}`);
}

export async function runJobAction(id: string): Promise<void> {
  if (!isValidId(id)) return;
  await requestRun(id);
  revalidatePath("/jobs");
  revalidatePath(`/jobs/${id}`);
}

export async function deleteJobAction(id: string): Promise<FormState> {
  if (!isValidId(id)) return { error: "Ungültige ID." };
  try {
    await deleteJob(id);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  revalidatePath("/jobs");
  redirect("/jobs");
}
