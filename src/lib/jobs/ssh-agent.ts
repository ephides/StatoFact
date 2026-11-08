import "server-only";
import { spawn } from "node:child_process";
import { isIP } from "node:net";

const MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_ERROR = 16 * 1024;

export async function fetchAgentReport(host: string, user: string, port: number, signal: AbortSignal): Promise<unknown> {
  if ((!isIP(host) && !/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host)) || host.startsWith("-")) {
    throw new Error("Ungültiger SSH-Host.");
  }
  if (!/^[a-z_][a-z0-9_-]{0,31}$/i.test(user)) throw new Error("Ungültiger SSH-Benutzer.");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Ungültiger SSH-Port.");
  signal.throwIfAborted();
  const args = ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "PasswordAuthentication=no", "-o", "ConnectTimeout=15", "-p", String(port), "-l", user, host, "sudo -n /usr/bin/statofact-agent --pull"];
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"], signal });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let bytes = 0;
    let errorBytes = 0;
    let tooLarge = false;
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) {
        tooLarge = true;
        child.kill();
      } else output.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errorBytes < MAX_ERROR) errors.push(chunk.subarray(0, MAX_ERROR - errorBytes));
      errorBytes += chunk.length;
    });
    child.once("error", (error) => reject(new Error(`SSH-Abruf fehlgeschlagen: ${error.message}`)));
    child.once("close", (code) => {
      if (tooLarge) return reject(new Error("Agent-Report zu groß (max. 4 MB)."));
      if (code !== 0) return reject(new Error(`SSH-Abruf fehlgeschlagen (Code ${code}): ${Buffer.concat(errors).toString("utf8").trim().slice(0, 1000)}`));
      try {
        resolve(JSON.parse(Buffer.concat(output).toString("utf8")));
      } catch {
        reject(new Error("Agent lieferte keinen gültigen JSON-Report."));
      }
    });
  });
}
