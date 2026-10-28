import { devMain } from "./dev-runner.js";

const controller = new AbortController();
const cancel = () => controller.abort(new Error("Cancelled by operator"));
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
try {
  process.exitCode = await devMain(process.argv.slice(2), { signal: controller.signal });
} finally {
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
}
