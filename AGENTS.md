# AGENTS.md

Guidance for human and AI contributors working in this repository.

## 1. Purpose

Paperclip is a control plane for AI-agent companies.
The current implementation target is V1 and is defined in `docs/SPEC-implementation.md`.

## 1.5 Priority When Rules Conflict

When rules in this file, `CONTRIBUTING.md`, `docs/SPEC-implementation.md`, or `docs/PRODUCT.md` point in different directions, resolve by this order. Higher items always win over lower:

1. **User data integrity & audit completeness** — never lose, corrupt, or silently truncate user-visible state (issues, comments, cost events, activity log, secrets). A "fix" that drops audit rows or hides a failed mutation behind a successful response is not a fix.
2. **V1 SPEC compliance** — `docs/SPEC-implementation.md` is the build contract. Behavior that diverges from it requires updating the contract first, not retrofitting docs to match the code.
3. **Multi-company isolation** — every entity is company-scoped. A perf gain that lets agent A read company B's data is unacceptable, full stop.
4. **Cross-platform stability** (Windows / macOS / Linux) — paperclip runs on contributor laptops including NTFS. A Linux-only convenience that breaks Windows is a regression (cf. §12 Fork-Specific NTFS notes).
5. **Performance** — important, but never above the four above.
6. **Developer convenience** — least important. "It's easier this way for the maintainer" is not a reason to violate 1–5.

When a PR involves a trade-off, name which level you are trading away in the `Risks` section of the PR template. That lets a reviewer judge whether the trade is acceptable.

## 2. Read This First

Before making changes, read in this order:

1. `docs/GOAL.md`
2. `docs/PRODUCT.md`
3. `docs/SPEC-implementation.md`
4. `docs/DEVELOPING.md`
5. `docs/DATABASE.md`

`docs/SPEC.md` is long-horizon product context.
`docs/SPEC-implementation.md` is the concrete V1 build contract.

## 3. Repo Map

- `cli/`: `paperclipai` CLI (onboard / configure / worktree / doctor / issue management)
- `server/`: Express REST API and orchestration services
- `ui/`: React + Vite board UI
- `packages/db/`: Drizzle schema, migrations, DB clients
- `packages/shared/`: shared types, constants, validators, API path constants
- `packages/adapters/`: agent adapter implementations (Claude, Codex, Cursor, etc.)
- `packages/adapter-utils/`: shared adapter utilities
- `packages/plugins/`: plugin system packages
- `scripts/`: build, release, dev-runner, Vitest harness, smoke scripts referenced by `package.json`
- `tests/`: Playwright `e2e` and `release-smoke` suites
- `evals/`: agent eval harness (`promptfoo`)
- `docker/`: Dockerfile and compose configs
- `releases/`: published changelog files (`releases/v*.md`)
- `patches/`: pnpm dependency patches
- `skills/`: gstack-style developer skills loaded by Claude Code in this repo
- `.agents/skills/`: maintainer-facing skills (release-changelog, doc-maintenance, company-creator, etc.)
- `.github/`: PR template, CODEOWNERS, workflows
- `docs/`: operational and product docs

## 4. Dev Setup (Auto DB)

Use embedded PGlite in dev by leaving `DATABASE_URL` unset.

```sh
pnpm install
pnpm dev
```

This starts:

- API: `http://localhost:3100`
- UI: `http://localhost:3100` (served by API server in dev middleware mode)

Quick checks:

```sh
curl http://localhost:3100/api/health
curl http://localhost:3100/api/companies
```

Reset local dev DB:

```sh
rm -rf data/pglite
pnpm dev
```

## 5. Core Engineering Rules

1. Keep changes company-scoped.
Every domain entity should be scoped to a company and company boundaries must be enforced in routes/services.

2. Keep contracts synchronized.
If you change schema/API behavior, update all impacted layers:
- `packages/db` schema and exports
- `packages/shared` types/constants/validators
- `server` routes/services
- `ui` API clients and pages

3. Preserve control-plane invariants.
- Single-assignee task model
- Atomic issue checkout semantics
- Approval gates for governed actions
- Budget hard-stop auto-pause behavior
- Activity logging for mutating actions

4. Do not replace strategic docs wholesale unless asked.
Prefer additive updates. Keep `docs/SPEC.md` and `docs/SPEC-implementation.md` aligned.

5. Keep repo plan docs dated and centralized.
When you are creating a plan file in the repository itself, new plan documents belong in `docs/plans/` and should use `YYYY-MM-DD-slug.md` filenames. This applies to **all** plan-style files, including those produced by the `writing-plans` / `planning-with-files` skills or any other superpowers-style workflow — do **not** create a parallel `docs/superpowers/plans/` tree. Design specs follow the same rule: land them in `docs/specs/`, not `docs/superpowers/specs/`. This does not replace Paperclip issue planning: if a Paperclip issue asks for a plan, update the issue's `plan` document via the Paperclip platform instead of creating a repo markdown file.

## 6. Database Change Workflow

When changing data model:

1. Edit `packages/db/src/schema/*.ts`
2. Ensure new tables are exported from `packages/db/src/schema/index.ts`
3. Generate migration:

```sh
pnpm db:generate
```

4. Validate compile:

```sh
pnpm -r typecheck
```

Notes:
- `packages/db/drizzle.config.ts` reads compiled schema from `dist/schema/*.js`
- `pnpm db:generate` compiles `packages/db` first

## 7. Verification Before Hand-off

Default local/agent test path:

```sh
pnpm test
```

This is the cheap default and only runs the Vitest suite. Browser suites stay opt-in:

```sh
pnpm test:e2e
pnpm test:release-smoke
```

Run the browser suites only when your change touches them or when you are explicitly verifying CI/release flows.

For normal issue work, run the smallest relevant verification first. Do not default to repo-wide typecheck/build/test on every heartbeat when a narrower check is enough to prove the change.

Run this full check before claiming repo work done in a PR-ready hand-off, or when the change scope is broad enough that targeted checks are not sufficient:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

If anything cannot be run, explicitly report what was not run and why.

## 8. API and Auth Expectations

- Base path: `/api`
- Board access is treated as full-control operator context
- Agent access uses bearer API keys (`agent_api_keys`), hashed at rest
- Agent keys must not access other companies

When adding endpoints:

- apply company access checks
- enforce actor permissions (board vs agent)
- write activity log entries for mutations
- return consistent HTTP errors (`400/401/403/404/409/422/500`)

## 9. UI Expectations

- Keep routes and nav aligned with available API surface
- Use company selection context for company-scoped pages
- Surface failures clearly; do not silently ignore API errors

## 10. Pull Request Requirements

When creating a pull request (via `gh pr create` or any other method), you **must** read and fill in every section of [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md). Do not craft ad-hoc PR bodies — use the template as the structure for your PR description. Required sections:

- **Thinking Path** — trace reasoning from project context to this change (see `CONTRIBUTING.md` for examples)
- **What Changed** — bullet list of concrete changes
- **Verification** — how a reviewer can confirm it works
- **Risks** — what could go wrong
- **Model Used** — the AI model that produced or assisted with the change (provider, exact model ID, context window, capabilities). Write "None — human-authored" if no AI was used.
- **Checklist** — all items checked

## 11. Definition of Done

A change is done when all are true:

1. Behavior matches `docs/SPEC-implementation.md`
2. Typecheck, tests, and build pass
3. Contracts are synced across db/shared/server/ui
4. Docs updated when behavior or commands change
5. PR description follows the [PR template](.github/PULL_REQUEST_TEMPLATE.md) with all sections filled in (including Model Used)
6. Greptile review score is 5/5 and every Greptile comment is addressed (see `CONTRIBUTING.md` for the policy)

## 12. Fork-Specific: HenkDz/paperclip

> **Scope**: The Hermes externalization rules below are authoritative **only on the `feat/externalize-hermes-adapter` branch**. Other branches (master, `claude/*` feature branches, etc.) may not need them. The "Local Dev" hints (NTFS quirks, port 3101+, vite build workaround) and the "Fork QoL Patches" still apply on most fork branches. When unsure, confirm with the branch maintainer before treating any sub-section as binding.

This is a fork of `paperclipai/paperclip` with QoL patches and an **external-only** Hermes adapter story on branch `feat/externalize-hermes-adapter` ([tree](https://github.com/HenkDz/paperclip/tree/feat/externalize-hermes-adapter)).

### Branch Strategy

- `feat/externalize-hermes-adapter` → core has **no** `hermes-paperclip-adapter` dependency and **no** built-in `hermes_local` registration. Install Hermes via the Adapter Plugin manager (`@henkey/hermes-paperclip-adapter` or a `file:` path).
- Older fork branches may still document built-in Hermes; treat this file as authoritative for the externalize branch.

### Hermes (plugin only)

- Register through **Board → Adapter manager** (same as Droid). Type remains `hermes_local` once the package is loaded.
- UI uses generic **config-schema** + **ui-parser.js** from the package — no Hermes imports in `server/` or `ui/` source.
- Optional: `file:` entry in `~/.paperclip/adapter-plugins.json` for local dev of the adapter repo.

### Local Dev

- Fork runs on port 3101+ (auto-detects if 3100 is taken by upstream instance)
- `npx vite build` hangs on NTFS — use `node node_modules/vite/bin/vite.js build` instead
- Server startup from NTFS takes 30-60s — don't assume failure immediately
- Kill ALL paperclip processes before starting: `pkill -f "paperclip"; pkill -f "tsx.*index.ts"`
- Vite cache survives `rm -rf dist` — delete both: `rm -rf ui/dist ui/node_modules/.vite`

### Fork QoL Patches (not in upstream)

These are local modifications in the fork's UI. If re-copying source, these must be re-applied:

1. **stderr_group** — amber accordion for MCP init noise in `RunTranscriptView.tsx`
2. **tool_group** — accordion for consecutive non-terminal tools (write, read, search, browser)
3. **Dashboard excerpt** — `LatestRunCard` strips markdown, shows first 3 lines/280 chars

### Plugin System

PR #2218 (`feat/external-adapter-phase1`) adds external adapter support. See root `AGENTS.md` for full details.

- Adapters can be loaded as external plugins via `~/.paperclip/adapter-plugins.json`
- The plugin-loader should have ZERO hardcoded adapter imports — pure dynamic loading
- `createServerAdapter()` must include ALL optional fields (especially `detectModel`)
- Built-in UI adapters can shadow external plugin parsers — remove built-in when fully externalizing
- Reference external adapters: Hermes (`@henkey/hermes-paperclip-adapter` or `file:`) and Droid (npm)

## 13. Boundary Scenarios for Contributors

Recurring "is this PR OK?" situations, worked as examples of how §1.5 priorities apply. When you feel friction with a rule ("this case is different"), find the closest scenario here first.

### Scenario A — "I want to add a chat surface that hits an LLM directly"

A contributor proposes a `POST /api/chat` route, or a "chat with the CEO" page, that calls an LLM provider directly from the server and bypasses the issue/comment model.

- `docs/PRODUCT.md` "Do not" list explicitly excludes chat-app territory: "Do not make the core product a general chat app... not a chatbot."
- **Direction**: route the conversation through issues + comments (per PRODUCT.md "conversation stays attached to work objects"), or ship it as a plugin (per §12 "thin core, rich edges"). A direct chat endpoint in core is the wrong layer.

### Scenario B — "Atomic checkout is slowing us down — can we skip the lock for high-throughput agents?"

A perf-motivated PR removes or weakens the execution lock around issue checkout to reduce p95 latency.

- §1.5 priorities **2 (SPEC compliance)** and **3 (isolation)** both bind here: `docs/SPEC-implementation.md` declares "atomic checkout required for `in_progress` transition" as a control-plane invariant, not a perf preference. Two agents both claiming the same issue is the failure mode the lock exists to prevent.
- **Direction**: optimize *inside* the lock (shorter critical section, better index, fewer round-trips) or *outside* the lock (batch wakeups, pre-warm caches). Do not remove the invariant.

### Scenario C — "My new adapter imports helpers from `server/`"

An external adapter PR adds `import { something } from '@paperclipai/server'` so it can reuse server-side utilities.

- §12 Fork-Specific Plugin System rule: "The plugin-loader should have ZERO hardcoded adapter imports — pure dynamic loading." The principle extends both ways: adapters should not reach into core either.
- **Direction**: expose the helper through `packages/adapter-utils` or the adapter SDK. If a helper genuinely belongs in core only, the adapter receives it as injected context, not via direct import.

### Scenario D — "For the dashboard, I want one query joining across all companies the user can see"

A "convenience" query bypasses company-scoped routes to deliver a unified view to a board operator with multi-company access.

- §1.5 priority **3 (isolation)** binds even when the operator legitimately has access to multiple companies — isolation must be enforced at the boundary, not relaxed because the caller "should be allowed anyway".
- **Direction**: keep the route company-scoped; have the dashboard call it per company on the client, or aggregate at a higher layer that explicitly enforces "this operator can see companies X, Y, Z."

### Scenario E — "Greptile flagged my PR but the comments are nitpicks I disagree with"

A contributor pushes back on Greptile review comments instead of addressing them, citing taste disagreement.

- `CONTRIBUTING.md` and §11 Definition of Done #6 treat Greptile 5/5 with every comment addressed as a merge prerequisite, not a suggestion.
- **Direction**: address each comment — either fix it, or reply with the specific reason it does not apply here, and request re-review. "Greptile is wrong" without per-comment reasoning is not a valid resolution.

### Adding new scenarios

If your situation truly is not covered above, open a discussion in Discord `#dev` (per `CONTRIBUTING.md`) before writing the code. Boundary cases that surface there should be folded back into this section as new scenarios.

## 14. Communication Style for AI Contributors

Every PR in this repo requires a `Model Used` field (see `.github/PULL_REQUEST_TEMPLATE.md`), so AI participation is explicit, not hidden. This section sets the tone expected from that participation — in PR descriptions, review replies, comments, and commit messages.

### Honesty over reassurance

- When verification fails, say it failed. "Tests pass" without running them is worse than "I could not run tests because X".
- When you do not know, say "I do not know" or "I am not sure — please verify". A confident wrong answer wastes more reviewer time than an admitted uncertainty.
- When you are guessing at intent, say "I interpreted this as X — if you meant Y, redirect me". Do not silently pick an interpretation and ship it.

### No flattery, no theatrical agreement

- Avoid PR comments like "You're absolutely right!", "Great catch!", "Perfect, fixed!". They add noise and pattern-match to AI slop.
- Just state what changed: "Fixed — replaced the regex with `parseURL` per your comment, line 42." That is the whole comment.
- The same applies to commit messages and PR descriptions. State the change, not the praise.

### Concrete verification, not summaries

- In the PR template `Verification` section, paste the actual command and the actual output (or a meaningful excerpt), not a summary like "all tests pass" or "manually verified".
- Example: `pnpm test → 247 passed, 0 failed (Vitest 3.2.4)`. If you skipped a suite because it needs Playwright with a logged-in browser, say that explicitly and name the suite.
- "Manual smoke test" without naming what was smoked is not a smoke test.

### Refuse out-of-scope requests with a reason

- If a request would violate §1.5 priorities, the `docs/PRODUCT.md` "Do not" list, or any §13 scenario, decline and explain why. Do not silently work around it and hope the reviewer does not notice.
- Example: a request to weaken atomic checkout "just for this benchmark" — decline, cite §1.5 #2 and #3 and §13 Scenario B, and propose the in-lock or out-of-lock alternative.

### Do not write speculative code or config

- Do not add adapter configs, route handlers, schema fields, or feature flags for capabilities that are not being shipped *in this PR*. The capability owner can add them when the capability is real.
- Do not refactor "while you are in the file" unless the refactor is in scope for the PR. Drive-by refactors hide behavior changes and bloat the review.
- Do not add abstractions in anticipation of a second caller that does not exist yet. One concrete implementation beats a premature framework.
- Background: unvalidated config is not free — it is a future debugging tax on whoever inherits the file. A PR that ships 30 lines of "this is roughly how X should work" creates 30 unverified assumptions.

### Match scope to what was requested

- If asked to fix a bug, fix the bug. Do not also update unrelated docs, rename files, or tighten linter rules in the same PR.
- If asked for one PR, keep it one logical change (per `CONTRIBUTING.md` "One PR = one logical change").
- If you notice an out-of-scope issue worth fixing, flag it in the PR description or open a follow-up issue. Do not bundle it.

### When in doubt, ask

- The cost of asking one clarifying question is one conversation turn. The cost of getting it wrong is a wasted PR cycle, possibly a reverted commit, possibly a multi-round Greptile loop.
- "I am about to do X — is that what you meant?" is rarely the wrong move.
