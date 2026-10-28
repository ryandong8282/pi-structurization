import { cp, mkdir } from 'node:fs/promises';

const target = new URL('../dist/skills/', import.meta.url);
await mkdir(target, { recursive: true });
await cp(new URL('../src/skills/', import.meta.url), target, { recursive: true });
