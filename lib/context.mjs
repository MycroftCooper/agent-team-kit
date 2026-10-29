// One place where every command gets its configuration + labels + logger, so no
// command module ever hard-codes a path.
import process from "node:process";
import { loadConfig, toProjectRelative } from "./config.mjs";
import { getLabels } from "./labels.mjs";
import { createLogger } from "./util.mjs";

/**
 * @param {object} [options]
 * @param {string} [options.cwd] Project search start directory.
 * @param {string} [options.configPath] Explicit config path.
 * @param {object} [options.logger] Injected logger (tests use a memory logger).
 */
export async function createContext(options = {}) {
  const config = await loadConfig({ cwd: options.cwd ?? process.cwd(), configPath: options.configPath });
  const labels = getLabels(config.language);
  return {
    config,
    root: config.root,
    configPath: config.configPath,
    paths: config.paths,
    rel: config.rel,
    roles: config.roles,
    lang: config.language,
    labels,
    cwd: options.cwd ?? process.cwd(),
    log: options.logger ?? createLogger(),
    /** Shorthand used in every receipt/report. */
    relOf: (absolutePath) => toProjectRelative(config, absolutePath),
  };
}
