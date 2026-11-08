// Datenmodell des Rechenzentrums. Wird von der App und vom Schema-Setup
// (scripts/setup-db.mjs) gemeinsam genutzt, daher ohne Imports und nur mit
// löschbarer TypeScript-Syntax.

export const STATUSES = [
  "Planned",
  "Ordered",
  "Installed",
  "Active",
  "Maintenance",
  "Decommissioned",
] as const;

export type FieldKind = "text" | "textarea" | "number" | "select";

export interface FieldDef {
  name: string;
  label: string;
  kind: FieldKind;
  options?: readonly string[];
  min?: number;
  max?: number;
  defaultValue?: string | number;
}

export const COMMON_FIELDS: readonly FieldDef[] = [
  { name: "status", label: "Status", kind: "select", options: STATUSES, defaultValue: "Active" },
  { name: "owner", label: "Verantwortlich", kind: "text" },
  { name: "description", label: "Beschreibung", kind: "textarea" },
];

export const DEVICE_TYPES = [
  "Server",
  "Switch",
  "Router",
  "Firewall",
  "Storage",
  "PDU",
  "UPS",
  "PatchPanel",
  "Other",
] as const;

export const ENVIRONMENTS = ["Production", "Staging", "Test", "Development"] as const;

export const NETWORK_FIELDS: readonly FieldDef[] = [
  { name: "interfaces", label: "Netzwerkschnittstellen", kind: "textarea" },
  { name: "gateway", label: "Standard-Gateway", kind: "text" },
  { name: "dnsServers", label: "DNS-Server", kind: "text" },
];

export interface CITypeDef {
  label: string;
  plural: string;
  fields: readonly FieldDef[];
}

export const CI_TYPES = {
  Site: {
    label: "Standort",
    plural: "Standorte",
    fields: [
      { name: "code", label: "Kürzel", kind: "text" },
      { name: "address", label: "Adresse", kind: "text" },
      { name: "country", label: "Land", kind: "text" },
    ],
  },
  Room: {
    label: "Raum",
    plural: "Räume",
    fields: [
      { name: "floor", label: "Etage", kind: "text" },
      { name: "coolingKw", label: "Kühlleistung (kW)", kind: "number", min: 0, max: 100000 },
    ],
  },
  Rack: {
    label: "Rack",
    plural: "Racks",
    fields: [
      { name: "heightU", label: "Höhe (HE)", kind: "number", min: 1, max: 60, defaultValue: 42 },
      { name: "maxPowerW", label: "Max. Leistung (W)", kind: "number", min: 0, max: 1000000 },
      { name: "maxWeightKg", label: "Max. Gewicht (kg)", kind: "number", min: 0, max: 10000 },
      { name: "row", label: "Reihe", kind: "text" },
      { name: "position", label: "Position in der Reihe", kind: "text" },
    ],
  },
  Device: {
    label: "Gerät",
    plural: "Geräte",
    fields: [
      { name: "deviceType", label: "Gerätetyp", kind: "select", options: DEVICE_TYPES, defaultValue: "Server" },
      { name: "vendor", label: "Hersteller", kind: "text" },
      { name: "model", label: "Modell", kind: "text" },
      { name: "serialNumber", label: "Seriennummer", kind: "text" },
      { name: "assetTag", label: "Asset-Tag", kind: "text" },
      { name: "heightU", label: "Höhe (HE)", kind: "number", min: 1, max: 60, defaultValue: 1 },
      { name: "powerW", label: "Leistungsaufnahme (W)", kind: "number", min: 0, max: 100000 },
      { name: "managementIp", label: "Management-IP", kind: "text" },
      ...NETWORK_FIELDS,
    ],
  },
  VirtualMachine: {
    label: "Virtuelle Maschine",
    plural: "Virtuelle Maschinen",
    fields: [
      { name: "vcpu", label: "vCPU", kind: "number", min: 1, max: 1024 },
      { name: "ramGb", label: "RAM (GB)", kind: "number", min: 1, max: 100000 },
      { name: "diskGb", label: "Disk (GB)", kind: "number", min: 1, max: 10000000 },
      { name: "os", label: "Betriebssystem", kind: "text" },
      { name: "managementIp", label: "Primäre IP", kind: "text" },
      ...NETWORK_FIELDS,
    ],
  },
  Application: {
    label: "Anwendung",
    plural: "Anwendungen",
    fields: [
      { name: "version", label: "Version", kind: "text" },
      { name: "environment", label: "Umgebung", kind: "select", options: ENVIRONMENTS, defaultValue: "Production" },
    ],
  },
  Software: {
    label: "Softwarepaket",
    plural: "Softwarepakete",
    fields: [],
  },
  SoftwarePackage: {
    label: "Softwareinstallation",
    plural: "Softwareinstallationen",
    fields: [
      { name: "packageName", label: "Paketname", kind: "text" },
      { name: "version", label: "Version", kind: "text" },
      { name: "architecture", label: "Architektur", kind: "text" },
      { name: "hostId", label: "System-CI-ID", kind: "text" },
    ],
  },
  Service: {
    label: "Service",
    plural: "Services",
    fields: [
      { name: "serviceKey", label: "Servicekennung", kind: "text" },
      { name: "hostId", label: "System-CI-ID", kind: "text" },
      { name: "bindings", label: "Lauschende Ports", kind: "textarea" },
      { name: "executables", label: "Ausführbare Dateien", kind: "textarea" },
      { name: "discoverySource", label: "Erfasst durch", kind: "text" },
    ],
  },
  Network: {
    label: "Netzwerk",
    plural: "Netzwerke",
    fields: [
      { name: "vlanId", label: "VLAN-ID", kind: "number", min: 1, max: 4094 },
      { name: "cidr", label: "CIDR", kind: "text" },
    ],
  },
} as const satisfies Record<string, CITypeDef>;

export type CIType = keyof typeof CI_TYPES;
export const CI_TYPE_NAMES = Object.keys(CI_TYPES) as CIType[];
export const NAVIGABLE_CI_TYPES = CI_TYPE_NAMES.filter((type) => type !== "SoftwarePackage");

export function isCIType(value: string): value is CIType {
  return Object.hasOwn(CI_TYPES, value);
}

export function fieldsFor(type: CIType): readonly FieldDef[] {
  return [...CI_TYPES[type].fields, ...COMMON_FIELDS];
}

export const RELATION_FIELDS: Record<string, FieldDef> = {
  rackUnit: { name: "rackUnit", label: "Unterste HE", kind: "number", min: 1, max: 60 },
  feed: { name: "feed", label: "Strang", kind: "select", options: ["A", "B", "C"] },
  outlet: { name: "outlet", label: "Steckdose/Port", kind: "text" },
  portFrom: { name: "portFrom", label: "Port (diese Seite)", kind: "text" },
  portTo: { name: "portTo", label: "Port (Gegenseite)", kind: "text" },
  cableId: { name: "cableId", label: "Kabel-ID", kind: "text" },
  ip: { name: "ip", label: "IP-Adresse", kind: "text" },
  discoverySource: { name: "discoverySource", label: "Erfasst durch", kind: "text" },
};

export interface RelationKindDef {
  label: string;
  inverse: string;
  rules: readonly (readonly [CIType, CIType])[];
  fields: readonly string[];
  // höchstens eine ausgehende Beziehung dieser Art pro CI
  single?: boolean;
}

export const RELATION_KINDS = {
  located_in: {
    label: "befindet sich in",
    inverse: "enthält",
    rules: [
      ["Room", "Site"],
      ["Rack", "Room"],
      ["Device", "Rack"],
      ["Device", "Room"],
    ],
    fields: ["rackUnit"],
    single: true,
  },
  hosted_on: {
    label: "läuft auf",
    inverse: "hostet",
    rules: [
      ["VirtualMachine", "Device"],
      ["Application", "VirtualMachine"],
      ["Application", "Device"],
    ],
    fields: [],
    single: true,
  },
  powered_by: {
    label: "wird versorgt von",
    inverse: "versorgt",
    rules: [["Device", "Device"]],
    fields: ["feed", "outlet"],
  },
  connected_to: {
    label: "verbunden mit",
    inverse: "verbunden mit",
    rules: [["Device", "Device"]],
    fields: ["portFrom", "portTo", "cableId"],
  },
  member_of: {
    label: "Mitglied von",
    inverse: "Mitglieder",
    rules: [
      ["Device", "Network"],
      ["VirtualMachine", "Network"],
    ],
    fields: ["ip"],
  },
  depends_on: {
    label: "hängt ab von",
    inverse: "wird benötigt von",
    rules: [
      ["Application", "Application"],
      ["Application", "Network"],
      ["VirtualMachine", "VirtualMachine"],
      ["SoftwarePackage", "SoftwarePackage"],
    ],
    fields: [],
  },
  installed_on: {
    label: "installiert auf",
    inverse: "hat installiert",
    rules: [
      ["SoftwarePackage", "Device"],
      ["SoftwarePackage", "VirtualMachine"],
    ],
    fields: [],
    single: true,
  },
  installation_of: {
    label: "Installation von",
    inverse: "Installationen",
    rules: [["SoftwarePackage", "Software"]],
    fields: [],
    single: true,
  },
  service_on: {
    label: "läuft auf",
    inverse: "Services",
    rules: [["Service", "Device"], ["Service", "VirtualMachine"]],
    fields: ["discoverySource"],
    single: true,
  },
  provided_by: {
    label: "bereitgestellt durch",
    inverse: "stellt Service bereit",
    rules: [["Service", "SoftwarePackage"]],
    fields: ["discoverySource"],
  },
} as const satisfies Record<string, RelationKindDef>;

export type RelationKind = keyof typeof RELATION_KINDS;

export function isRelationKind(value: string): value is RelationKind {
  return Object.hasOwn(RELATION_KINDS, value);
}

export function isAllowedRelation(
  kind: RelationKind,
  from: CIType,
  to: CIType,
): boolean {
  return (RELATION_KINDS[kind].rules as readonly (readonly [CIType, CIType])[]).some(
    ([f, t]) => f === from && t === to,
  );
}
