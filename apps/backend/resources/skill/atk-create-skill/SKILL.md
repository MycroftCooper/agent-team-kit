---
name: atk-create-skill
description: Turn a repeatable workflow into an ATK Skill that agents can discover and use. Use to author a new SKILL.md and any supporting material it needs.
---

# Create an ATK Skill

1. Identify the trigger, the inputs, and an observable successful result. Check `atk-agent resources list --kind skill` for overlap before adding a new skill. Use a short lowercase hyphenated name and match it to the folder name.
2. Write `skill/<name>/SKILL.md` as UTF-8. Begin with YAML frontmatter between `---` lines, with `name` and a concise `description` that says when to use it. In the body, preserve the non-obvious workflow decisions, output expectations, and stop conditions. Keep supporting examples or files in the same resource folder; link to them by relative path only when the workflow needs them.
3. Check the frontmatter and relative links, and walk through one representative request. Run any included helpers against disposable input when their behavior matters. Make sure the description would select this skill for that request and that the instructions lead to the expected result.
4. Use `folders.skill` from `atk-agent resources list --kind skill` as the import destination when authorized to write there. During an ATK run whose approved scope excludes the library, deliver the folder inside the approved scope for the user to import. After import, verify `atk-agent resources show skill/<name>` returns the expected entry. ATK serves the skill on demand; native installation into a particular client is a separate action.
