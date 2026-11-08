import { connection } from "next/server";
import { ArcadeDBError, ping } from "@/lib/arcadedb";

export async function GET() {
  await connection();
  try {
    return Response.json(await ping());
  } catch (error) {
    const message =
      error instanceof ArcadeDBError ? error.message : "Unbekannter Fehler";
    return Response.json({ server: false, error: message }, { status: 502 });
  }
}
