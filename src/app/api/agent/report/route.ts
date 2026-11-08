import { timingSafeEqual } from "node:crypto";
import { ModelError } from "@/lib/cmdb";
import { ingestItem } from "@/lib/ingest";

const MAX_BODY_BYTES = 4 * 1024 * 1024;

function authorized(request: Request, expected: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  const token = process.env.AGENT_TOKEN;
  if (!token || token.length < 16) {
    return Response.json({ error: "Agent-API nicht konfiguriert (AGENT_TOKEN, mind. 16 Zeichen)." }, { status: 503 });
  }
  if (!authorized(request, token)) {
    return Response.json({ error: "Nicht autorisiert." }, { status: 401 });
  }

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return Response.json({ error: "Anfrage zu groß." }, { status: 413 });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "Ungültiges JSON." }, { status: 400 });
  }

  try {
    const { type, name, result, networks, packages, services, virtualMachines } = await ingestItem(body);
    return Response.json({ type, name, result, networks, packages, services, virtualMachines });
  } catch (error) {
    if (error instanceof ModelError) {
      return Response.json({ error: error.message }, { status: 422 });
    }
    console.error("Agent-Report fehlgeschlagen:", error);
    return Response.json({ error: "Interner Fehler." }, { status: 500 });
  }
}
