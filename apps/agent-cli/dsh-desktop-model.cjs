// Executed by the installed Electron-as-Node host so its bundled YAML parser
// can read desktop model selection. Only these three non-secret fields leave
// this process. Never open credential stores or export provider/UI configuration.
const fs = require("node:fs"), path = require("node:path");
try {
  const [asar, dshHome] = process.argv.slice(2);
  const yaml = require(path.join(asar, "dsh", "node_modules", "yaml"));
  const rows = profile => {
    const file = path.join(dshHome, "profiles", profile, "cordis.patch.yml");
    if (!fs.existsSync(file)) return [];
    const value = yaml.parse(fs.readFileSync(file, "utf8"), { logLevel: "silent" });
    return Array.isArray(value) ? value : [];
  };
  let config;
  if (!rows("headless").some(row => row.id === "agent-default-model")) {
    const selected = rows("desktop").findLast(row => row.id === "agent-default-model")?.config;
    if (selected && [selected.provider, selected.model].every(value => typeof value === "string" && /^[\w./@:-]{1,256}$/.test(value))) {
      config = { provider: selected.provider, model: selected.model };
      if (typeof selected.reasoningEffort === "string" && /^[\w-]{1,32}$/.test(selected.reasoningEffort)) config.reasoningEffort = selected.reasoningEffort;
    }
  }
  process.stdout.write(JSON.stringify(config ? [{ id: "agent-default-model", config }] : []));
} catch {
  console.error("Cannot read DSH desktop model selection. Configure the headless model or pass --dsh-patch.");
  process.exitCode = 1;
}
