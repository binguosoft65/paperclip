## Project rules

This repository is a fork of the Paperclip control plane. Read [AGENTS.md](./AGENTS.md) first — it is the authoritative source for:

- Required reading list (`docs/GOAL.md`, `docs/PRODUCT.md`, `docs/SPEC-implementation.md`, `docs/DEVELOPING.md`, `docs/DATABASE.md`)
- Repo map, core engineering rules, database change workflow, verification commands
- Definition of Done (incl. Greptile review gate from `CONTRIBUTING.md`)
- PR template requirements (`.github/PULL_REQUEST_TEMPLATE.md`)
- Fork-specific notes (`AGENTS.md` §12)

The skill routing rules below apply **on top of** those engineering rules — they decide *how* to approach a task, while `AGENTS.md` decides *what* the task must satisfy to land.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:

- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- 请使用中文写代码注释
