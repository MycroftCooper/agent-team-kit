#!/usr/bin/env node
// Entry point for the `atk` CLI.
import process from "node:process";
import { runCli } from "../lib/dispatch.mjs";

try {
  const code = await runCli(process.argv.slice(2));
  if (typeof code === "number") process.exitCode = code;
} catch (error) {
  const debug = process.argv.includes("--debug");
  process.stderr.write(`atk: ${error?.message ?? error}\n`);
  if (debug && error?.stack) process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
}
