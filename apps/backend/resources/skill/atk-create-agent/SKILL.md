---
name: atk-create-agent
description: Create an ATK Agent profile and, when requested, prepare its role, identity registration, and external client setup. Use for a new team Agent or a reusable Agent template.
---

# Create an ATK Agent

Choose the resource owner before importing: global resources use the existing commands;
project resources add `--scope project --project <projectId>` to list/show. Read
`spec.resources.project` for the claimed project's discovery command. Use the returned
folder for that scope; project profiles live in docsRoot/resources and do not override
same-named global profiles. A task's approved write scope still applies.

Distinguish the reusable profile, the registered ATK identity, and the client that actually runs the Agent. A profile in the resource library does not register an identity or start a process.

1. Identify the Agent's job, inputs, expected outputs, and when it should hand work back. Use an existing role if it fits. For a new role, choose the actual stage: `ORCHESTRATOR` plans, `WORKER` executes, and `REVIEWER` reviews independently. State project access and allowed writes narrowly when configuring a worker role.
2. Write `agent/<name>/AGENT.md`. Describe responsibilities, how to handle the expected input, what a useful result contains, and when to stop or hand off. Keep credentials and machine-specific paths out of the profile. The registered role and the approved task scope govern what the Agent can do.
3. Find the user library with `atk-agent resources list --kind agent` and read `folders.agent` in the result. Put the profile there when authorized to write to that library. If working under a task whose file scope excludes it, deliver the resource folder within the approved scope for the user to import. Verify an imported profile with `atk-agent resources show agent/<name>`.
4. For a runnable identity, use the human ATK UI: add the role to the squad if needed, then use **Agent team → All agents → Add agent** and select the squad and role. Have the user supply the one-time credential as `ATK_AGENT_TOKEN` in the chosen client environment. The client can read the profile with `resources show`; verify identity with `atk-agent doctor`, then `atk-agent connect` to check in. Only claim real work when asked to start it.

Report the profile path and distinguish what was authored from any registration or connection that was actually verified.
