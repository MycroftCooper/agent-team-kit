---
name: atk-create-automation
description: Design or configure an ATK automation pipeline for a workspace, including shell steps, manual or local Git branch triggers, and run progress. Use for CI, smoke tests, packaging, or other repeatable project commands.
---

# Create an ATK automation pipeline

1. Identify the registered workspace and look for an existing flow under **Automations**. Reuse the built-in Smoke test or Package and release flow if it fits. Inspect the project's scripts and release policy before choosing commands.
2. Define a name, a trigger, and ordered steps with names and one shell command each. Commands start in the project root under Windows cmd.exe or POSIX /bin/sh; a nonzero exit code stops the flow. Put complex logic in a project script, and keep steps in the foreground so ATK can stop them.
3. Set the trigger per workspace. Prefer **Manual** for publishing unless the user asks to automate it. Use **New Git commit** with the requested local branch for automatic checks. The first observed commit sets the baseline; the local branch must be checked out with no tracked changes when the run starts. ATK does not fetch or switch branches.
4. Set fixed information as name=value pairs. To report results or progress, have a script emit a UTF-8 stdout line such as:

       ::atk::{"progress":40,"info":{"Tests passed":12,"Artifact":"dist/package.tgz"}}

   Progress is for the current step. Report only observed results.
5. Save through **Automations → New workflow** (or edit an existing flow) when authorized and a human session is available. Otherwise deliver the workflow name, trigger, steps and fields for the user to enter. Agent credentials cannot save or run a workflow. Validate against disposable input or with a local dry run when useful; creating a release flow does not authorize publishing it.
