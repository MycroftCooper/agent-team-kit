#!/usr/bin/env node
// Preserve the original Codex entry point; both engines share one lifecycle.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { main } from './agent-runner.mjs';
export { runBugOnce, resolveCodex, main } from './agent-runner.mjs';
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
