---
name: atk-create-mcp
description: Package an existing MCP service for ATK or implement a new MCP server and verify its tools. Use for team MCP resources, not standalone CLI scripts.
---

# Create an ATK MCP resource

Choose global or project ownership before importing. Global commands remain unchanged;
add `--scope project --project <projectId>` to list/show/serve-mcp for project resources.
Use the claimed task's `spec.resources.project.command` to find the project's folders.
A project stdio client's launch arguments must include those scope and project flags.
Same-named configurations never override or fall back across scopes.

Decide whether to connect an existing service or implement new tools. For new tools, define their names, input schemas, result shapes, and side effects before implementing them with an SDK supported by the target runtime. Use [MCP's build guide](https://modelcontextprotocol.io/docs/develop/build-server) when you need SDK-specific instructions. A local stdio server should reserve stdout for protocol messages and send logs to stderr.

Create `mcp/<name>/mcp.json` with one of these ATK forms:

```json
{ "transport": "stdio", "command": "node", "args": ["server.mjs"] }
```

```json
{ "transport": "http", "url": "https://example.com/mcp" }
```

For stdio, put a bundled server and its required files beside `mcp.json`; ATK starts the command with that folder as the working directory. For an existing stdio server, use its documented executable and arguments. For HTTP, use the Streamable HTTP endpoint without credentials, query parameters, or fragments. The client handles service authorization; keep secrets out of the shared pack.

Find `folders.mcp` with `atk-agent resources list --kind mcp`. Import only when authorized to write to the library; otherwise deliver the folder in the approved task scope for the user to import. Confirm the configuration with `atk-agent resources show mcp/<name>`. Register the HTTP URL in the MCP client, or set its stdio launch command to `atk-agent` with arguments `resources`, `serve-mcp`, `mcp/<name>`. The ATK credential belongs in the launch environment.

Use an MCP client or the [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) to list tools and call one with safe test input. Report the difference between validating the configuration and successfully calling a tool. Do not invoke tools with external side effects as a connectivity check.
