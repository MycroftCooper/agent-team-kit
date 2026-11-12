---
name: atk-create-cli
description: Build an ATK command-line resource as a Node.js entry point, including wrappers for installed tools. Use when agents should run a script with arguments and consume its result.
---

# Create an ATK CLI resource

Choose global or project ownership before importing. Commands without scope use global
resources. Add `--scope project --project <projectId>` to list/show/run for project
resources; put these flags before `--` when running a script. The claimed task exposes
`spec.resources.project.command`. Use that scope's folders and keep the scope when
verifying or invoking the tool; project entries never fall back to global ones.

1. Define the input arguments, output, failure behavior, and any file or service the command changes. Use a direct Node.js implementation for a small tool or a thin wrapper when an appropriate executable is already available. Document runtime prerequisites when there are any.
2. Write `cli/<name>/main.mjs`. ATK runs it from the caller's working directory and forwards everything after `--` as arguments. Read them from `process.argv.slice(2)`. Resolve files bundled with the resource relative to `import.meta.url`, and work on the caller's project only when intended. When invoking another executable, pass the arguments separately rather than building a shell command from input.
3. Provide usable `--help`, a meaningful nonzero exit code for failures, and diagnostics on stderr. Keep stdout parseable when the caller expects structured output. Validate a representative successful invocation and invalid input using disposable fixtures; exercise writes only within the authorized scope.
4. Find `folders.cli` with `atk-agent resources list --kind cli`. Import when authorized to write there, or deliver the folder inside the approved task scope for the user to import. Test an imported resource from the intended working directory with `atk-agent resources run cli/<name> -- --help`, then run a harmless representative invocation. Give the user the command, accepted arguments, and what it returns.
