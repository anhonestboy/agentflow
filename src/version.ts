import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Single source of truth for the package version: read at runtime from
// package.json instead of hardcoding it. This module lives one level below the
// package root both as src/version.ts (jest) and as dist/version.js (runtime),
// so `../package.json` resolves in both cases. We read the file rather than
// importing the JSON to avoid enabling resolveJsonModule, which would pull
// package.json into tsconfig's rootDir and break the build.
const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url));
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version: string };

export const AGENTFLOW_VERSION: string = packageJson.version;
