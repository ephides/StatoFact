import "server-only";
import net from "node:net";
import { listCIs, upsertCI } from "@/lib/cmdb";
import { ingestItem, sanitizeItem } from "@/lib/ingest";
import { fetchAgentReport } from "@/lib/jobs/ssh-agent";
import { type FieldDef } from "@/lib/model";
import { deleteRunsOlderThan, type ParamValue } from "@/lib/jobs/store";

export interface HandlerContext {
  log: (message: string) => void;
  signal: AbortSignal;
}

export interface JobHandler {
  label: string;
  description: string;
  fields: readonly FieldDef[];
  run: (params: Record<string, ParamValue>, ctx: HandlerContext) => Promise<void>;
}

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_ITEMS = 5000;

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Ungültige URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Nur http(s)-URLs sind erlaubt.");
  }
  let res: Response;
  try {
    res = await fetch(parsed, { signal, cache: "no-store", headers: { Accept: "application/json" } });
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
    throw new Error(`Abruf von ${parsed.origin} fehlgeschlagen${cause ? `: ${cause}` : ""}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} von ${parsed.origin}`);
  const text = await res.text();
  if (text.length > MAX_BODY_BYTES) throw new Error("Antwort zu groß (max. 5 MB).");
  return JSON.parse(text);
}

function probe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export const HANDLERS: Record<string, JobHandler> = {
  agent_pull: {
    label: "Passiven Agenten abrufen (SSH)",
    description: "Ruft einen passiven Linux-Agenten über SSH mit Schlüssel und bekanntem Hostschlüssel ab und synchronisiert dessen CMDB-Daten.",
    fields: [
      { name: "host", label: "SSH-Host", kind: "text" },
      { name: "user", label: "SSH-Benutzer", kind: "text" },
      { name: "port", label: "SSH-Port", kind: "number", min: 1, max: 65535, defaultValue: 22 },
    ],
    async run(params, ctx) {
      const host = String(params.host ?? "").trim();
      const user = String(params.user ?? "").trim();
      const port = Number(params.port ?? 22);
      const report = await fetchAgentReport(host, user, port, ctx.signal);
      ctx.signal.throwIfAborted();
      if (!report || typeof report !== "object" || Array.isArray(report) ||
          !("type" in report) || (report.type !== "Device" && report.type !== "VirtualMachine")) {
        throw new Error("Agent-Report muss ein Gerät oder eine virtuelle Maschine enthalten.");
      }
      const result = await ingestItem(report);
      ctx.log(`${result.type} ${result.name}: ${result.result}, Netzwerke: ${result.networks ?? "nicht gemeldet"}, Pakete: ${result.packages ?? "nicht gemeldet"}, Services: ${result.services ?? "nicht gemeldet"}.`);
      if (result.virtualMachines !== undefined) ctx.log(`VM-Inventar: ${result.virtualMachines} VM(s).`);
    },
  },

  import_json: {
    label: "CMDB-Import (JSON)",
    description:
      'Lädt ein JSON-Array von {"type","name",…Felder} von einer URL und legt CIs an oder aktualisiert sie (Schlüssel: Typ + Name). Nicht enthaltene Felder bleiben unverändert.',
    fields: [{ name: "url", label: "URL", kind: "text" }],
    async run(params, ctx) {
      const url = String(params.url ?? "").trim();
      if (!url) throw new Error("Parameter 'url' fehlt.");
      const data = await fetchJson(url, ctx.signal);
      if (!Array.isArray(data)) throw new Error("Die Antwort ist kein JSON-Array.");
      if (data.length > MAX_ITEMS) throw new Error(`Zu viele Einträge (max. ${MAX_ITEMS}).`);

      const counts = { created: 0, updated: 0, unchanged: 0, failed: 0 };
      for (const [index, item] of data.entries()) {
        ctx.signal.throwIfAborted();
        try {
          const { type, name, values } = sanitizeItem(item);
          const result = await upsertCI(type, name, values);
          counts[result]++;
          if (result !== "unchanged") ctx.log(`${result === "created" ? "angelegt" : "aktualisiert"}: ${type} ${name}`);
        } catch (error) {
          counts.failed++;
          ctx.log(`Eintrag ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      ctx.log(
        `${data.length} Einträge: ${counts.created} neu, ${counts.updated} geändert, ${counts.unchanged} unverändert, ${counts.failed} fehlerhaft.`,
      );
      if (counts.failed > 0) throw new Error(`${counts.failed} Einträge fehlerhaft.`);
    },
  },

  tcp_check: {
    label: "Erreichbarkeit prüfen (TCP)",
    description:
      "Prüft für alle Geräte mit Management-IP, ob der TCP-Port erreichbar ist, und protokolliert das Ergebnis. Der Lauf schlägt fehl, wenn Geräte nicht erreichbar sind.",
    fields: [
      { name: "port", label: "Port", kind: "number", min: 1, max: 65535, defaultValue: 22 },
    ],
    async run(params, ctx) {
      const port = Number(params.port ?? 22);
      const devices = (await listCIs({ type: "Device" })).filter((d) => d.values.managementIp);
      ctx.log(`${devices.length} Geräte mit Management-IP, Port ${port}.`);

      let down = 0;
      for (let i = 0; i < devices.length; i += 20) {
        ctx.signal.throwIfAborted();
        const batch = devices.slice(i, i + 20);
        const results = await Promise.all(
          batch.map((d) => probe(String(d.values.managementIp), port, 3000)),
        );
        batch.forEach((d, j) => {
          if (!results[j]) down++;
          ctx.log(`${results[j] ? "erreichbar" : "NICHT erreichbar"}: ${d.name} (${d.values.managementIp})`);
        });
      }
      if (down > 0) throw new Error(`${down} Geräte nicht erreichbar.`);
    },
  },

  cleanup_runs: {
    label: "Laufprotokolle aufräumen",
    description: "Löscht Protokolle abgeschlossener Läufe, die älter als die angegebene Anzahl Tage sind.",
    fields: [
      { name: "days", label: "Älter als (Tage)", kind: "number", min: 1, max: 3650, defaultValue: 30 },
    ],
    async run(params, ctx) {
      const days = Number(params.days ?? 30);
      const deleted = await deleteRunsOlderThan(Date.now() - days * 86_400_000);
      ctx.log(`${deleted} Protokolle gelöscht.`);
    },
  },
};

export function isHandler(name: string): boolean {
  return Object.hasOwn(HANDLERS, name);
}
