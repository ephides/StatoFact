import "server-only";
import { createHash } from "node:crypto";
import { query } from "@/lib/arcadedb";
import { addRelation, createCI, findCI, getCI, listRelations, ModelError, updateCI, type CI, type Value } from "@/lib/cmdb";
import { sanitizeItem } from "@/lib/sanitize-item";

interface VMReport {
  provider: string;
  id: string;
  name: string;
  values: Record<string, Value>;
}

export function parseVirtualMachines(raw: unknown): VMReport[] {
  if (!Array.isArray(raw) || raw.length > 1000) {
    throw new ModelError("virtualMachines muss eine Liste mit höchstens 1000 VMs sein.");
  }
  const identities = new Set<string>();
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ModelError(`virtualMachines[${index}]: Objekt erforderlich.`);
    }
    const obj = entry as Record<string, unknown>;
    const provider = obj.provider;
    const id = obj.id;
    if ((provider !== "virtualbox" && provider !== "vmware-workstation") ||
        typeof id !== "string" ||
        !/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|path-[0-9a-f]{64})$/.test(id) ||
        (provider === "virtualbox" && id.startsWith("path-"))) {
      throw new ModelError(`virtualMachines[${index}]: ungültige Quelle oder VM-Identität.`);
    }
    const identity = `${provider}:${id}`;
    if (identities.has(identity)) throw new ModelError(`Doppelte VM-Identität: ${identity}`);
    identities.add(identity);
    const { name, values } = sanitizeItem({
      type: "VirtualMachine", name: obj.name, vcpu: obj.vcpu, ramGb: obj.ramGb, os: obj.os,
    });
    return { provider, id, name, values };
  });
}

async function findBySource(source: string): Promise<CI | null> {
  const rows = await query<{ "@rid": string }>(
    "SELECT @rid FROM VirtualMachine WHERE hypervisorSource = :source LIMIT 2", { source },
  );
  if (rows.length > 1) throw new ModelError("Mehrere VMs haben dieselbe Hypervisor-Identität.");
  if (!rows[0]) return null;
  const ci = await getCI(rows[0]["@rid"]);
  if (!ci) throw new ModelError("VM zur Hypervisor-Identität nicht gefunden.");
  return ci;
}

export async function syncVirtualMachines(host: CI, reports: VMReport[]): Promise<number> {
  const conflicts: string[] = [];
  for (const vm of reports) {
    const source = createHash("sha256").update(JSON.stringify([host.id, vm.provider, vm.id])).digest("hex");
    const existing = await findBySource(source);
    let named: CI | null;
    try {
      named = await findCI("VirtualMachine", vm.name);
    } catch (error) {
      if (!(error instanceof ModelError)) throw error;
      conflicts.push(`${vm.name}: Name nicht eindeutig`);
      continue;
    }
    if (named && named.id !== existing?.id) {
      conflicts.push(`${vm.name}: Name bereits vergeben`);
      continue;
    }
    if (existing) {
      const relations = (await listRelations(existing.id)).filter((r) => r.kind === "hosted_on" && r.direction === "out");
      if (relations.some((r) => r.otherId !== host.id)) {
        conflicts.push(`${vm.name}: anderer Host zugeordnet`);
        continue;
      }
      const changed = Object.entries(vm.values).filter(([key, value]) => existing.values[key] !== value);
      if (existing.name !== vm.name || changed.length) {
        await updateCI(existing, vm.name, Object.fromEntries(changed));
      }
      if (!relations.length) await addRelation({ fromId: existing.id, toId: host.id, kind: "hosted_on", attrs: {} });
    } else {
      const id = await createCI("VirtualMachine", vm.name, { status: "Active", ...vm.values, hypervisorSource: source });
      await addRelation({ fromId: id, toId: host.id, kind: "hosted_on", attrs: {} });
    }
  }
  if (conflicts.length) {
    throw new ModelError(`${conflicts.length} VM-Konflikt(e): ${conflicts.slice(0, 3).join("; ")}${conflicts.length > 3 ? "; weitere im nächsten Lauf" : ""}. Bereits importierte VMs bleiben erhalten.`);
  }
  return reports.length;
}
