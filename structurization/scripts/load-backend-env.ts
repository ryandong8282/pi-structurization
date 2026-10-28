// Side-effect import: must be the FIRST import of any driver that reads
// backend/.env values consumed by module-level constants (e.g. the target
// modeling context budget evaluated inside pi-runtime.ts at import time).
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(process.env.PDF_EX_CODEX_ROOT || process.cwd());
try {
  const envText = readFileSync(join(ROOT, "backend", ".env"), "utf8");
  for (const line of envText.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (match && !(match[1] in process.env)) process.env[match[1]] = match[2];
  }
} catch {
  console.warn("[load-backend-env] backend/.env not found; relying on current environment");
}
