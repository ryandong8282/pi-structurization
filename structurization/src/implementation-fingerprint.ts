import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

async function filesBelow(root: string, directory: string): Promise<string[]> {
  const result: string[] = [];
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop()!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) result.push(path);
    }
  }
  return result.sort((left, right) => relative(root, left).localeCompare(relative(root, right)));
}

async function hashFiles(root: string, files: string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const path of files) {
    hash.update(relative(root, path).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function computeImplementationFingerprints(packageRoot: string): Promise<{
  source_fingerprint: string;
  build_fingerprint: string;
}> {
  const sourceFiles = (await filesBelow(packageRoot, join(packageRoot, "src")))
    .filter((path) => /\.(?:ts|json)$/iu.test(path));
  const sourceFingerprint = await hashFiles(packageRoot, sourceFiles);
  const buildInputs = [
    ...sourceFiles,
    join(packageRoot, "package.json"),
    join(packageRoot, "tsconfig.json"),
  ];
  const buildHash = createHash("sha256");
  buildHash.update(await hashFiles(packageRoot, buildInputs));
  buildHash.update("\0");
  buildHash.update(process.version);
  return {
    source_fingerprint: sourceFingerprint,
    build_fingerprint: buildHash.digest("hex"),
  };
}
