import { writeFileSync } from "node:fs";

writeFileSync(process.argv[2]!, String(process.pid), "utf8");
setInterval(() => undefined, 1_000);
