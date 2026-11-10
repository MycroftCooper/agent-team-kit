export const ATK_HELP = `Agent Team Kit
  atk start [--port 1421] [--data <directory>]
  atk stop|status|logs [--data <directory>]
  atk backup [--to <new directory>]
  atk restore --from <backup directory>
  atk --version

External agents use atk-agent. No target-project installation is needed.`;

export const ATK_AGENT_HELP = `atk-agent doctor
atk-agent connect
atk-agent claim [--project <id>] [--task <id>] [--kind bug|work|request] [--wait 30000]
atk-agent watch <runId> --generation <n>
atk-agent heartbeat <runId> --generation <n>
atk-agent events <runId> --file <JSON> --generation <n>
atk-agent submit <runId> plan|result|review --file <JSON>
atk-agent stopped <runId> --generation <n>
atk-agent get <runId>
atk-agent replay
atk-agent resources list [--kind agent|skill|mcp|cli]
atk-agent resources show <kind/name>
atk-agent resources run cli/<name> [-- <args>]
atk-agent resources serve-mcp mcp/<name>
Environment: ATK_URL, ATK_AGENT_TOKEN; no model credentials.`;
