# Fork deltas vs mainline opencode — v2 port line

This branch (`v2` in `neumark/opencode`) is the **port line for OpenCode 2**. It tracks upstream (`anomalyco/opencode`) `dev` — the live v2 line, where 2.0.x releases are cut as orphan `release:` commits pinned by tags with matching `sync release versions` commits on the branch (same shape as the v1 line). The branch is based at the `v2.0.27` release-sync commit and rebases onto release-sync commits only, never moving dev tips, to keep rebases bounded. The upstream `2.0` branch is a stale April-2026 exploration branch — not the port target. `main` remains the v1 integration branch (currently `v1.19.0-neumark.1`; its `FORK.md` carries the v1 feature specs, release lineage, and the incidents that bought each feature, with `INCIDENT_HISTORY.md` in fc-opencode) until this line proves out in deployment.

**Current state: no fork deltas.** This branch is stock upstream v2.0.27. This document is the port plan — the per-feature disposition of the v1 fork features against the v2 architecture, the fc-opencode contract changes, and the phased rollout.

## Why port (and why not a rebase)

Upstream `dev` is the v2 rewrite: `packages/opencode` is deleted, split into `cli`/`server`/`core`/`schema`/`protocol`/…; every file the v1 fork patches is gone or rewritten. This is a reimplementation project, not a rebase (already noted in `main`'s FORK.md). What v2 buys this deployment:

- The fork's most fragile dependency — the undocumented `experimental_workspace` plugin API — is replaced by a **supported** worktree-strategy plugin API (`ctx.worktree.transform` in `@opencode/plugin`; upstream ships test fixtures for plugin-provided strategies: `packages/server/test/fixture/worktree-plugin/`).
- `/sync/history` and its full-table-scan read spiral (fc-opencode incident 14, upstream issue #52270) is architecturally gone: v2 syncs clients over an SSE event feed (`event.subscribe` in `packages/server/src/handlers/event.ts`) with no polling catch-up.
- The web app natively attributes worktree sessions to their projects (workspace inventory, `managedWorkspaceDirectories`, per-workspace session grouping) — the v1 fork's feature 3 exists upstream, built properly.
- v1 is in guided-sunset maintenance (v1.19.0 is chores plus the V2 update dialog and `opencode upgrade --major`); v2 is where fixes land.
- Official linux-arm64 builds exist — the fork's x64-only releases were an operator concession, and arm64 could revive Pi-5 slots.

What it costs: v2 currently has **no LSP integration** (v1 fed language-server diagnostics to the agent; v2.0.27 retains only the config schema, `normalizeLsp`, and a settings display panel — there is no launch machinery anywhere in `packages/`), the port below is real work, v2 moves fast (~daily releases; the worktree-strategy and plugin APIs are fresh and may drift), and the daemon's IO/memory profile under this deployment's 24/7 agent-loop load is unmeasured (Phase A exists to measure it).

## Port plan — v1 fork features against v2

### 1. Web UI title override — `OPENCODE_WEB_UI_TITLE` (port, small)

v1: `packages/opencode/src/server/shared/ui.ts` (`374b444`). v2 target: `packages/cli/src/services/web-ui.ts` — same shape: replace the `<title>` block of the embedded `index.html` (HTML-escape the value; use a function replacement so `$` sequences stay literal) and recompute the inline-theme-script CSP hash — `cspForHtml()` already exists there and hashes the served HTML. Env plumbing follows the v2 Config pattern (`packages/cli/src/env.ts`). Serve path (`opencode serve --hostname`, `OPENCODE_SERVER_PASSWORD`) is unchanged in v2.

### 2. Per-session default workspace binding — `OPENCODE_NEW_SESSION_WORKSPACE` (redesign)

v2 model: sessions live at `Location.Ref` `{ directory, workspaceID? }`; `session.create` accepts `location` and `parentID` (children keep the parent's location natively — subagent sharing parity for free). Worktrees are first-class: `WorktreeStrategies` (`packages/core/src/worktree/strategies.ts`) holds per-project strategies; `editor.add(strategy)` registers one **and selects it as the default**; the new-session picker (main/create/existing) is client-side, and the `workspaces.defaultDestination` setting is app-local — headless/SDK creates bypass both. Port, two halves:

- The guest plugin registers an `overlayfs` worktree strategy (below).
- Server-side default binding, same contract as v1 (`60d0229`): a small patch at `session.create` — env `OPENCODE_NEW_SESSION_WORKSPACE=<strategyID>`, top-level creates without an explicit worktree location get a fresh strategy worktree and a rewritten `location.directory`; unregistered strategy degrades to pass-through (never errors); `parentID` creates untouched. `OPENCODE_EXPERIMENTAL_WORKSPACES` is dropped — worktrees are not experimental in v2.

### 3. Workspace origin tracking + home-page integration (drop — obsolete)

v2's location/project model natively lists, labels, groups, and opens worktree sessions under their project; worktree directories are tracked with their strategy (`WorktreeTable`), and the app exposes workspace inventory without project-card hacks. All three v1 gaps (exact-directory filter, unresolvable projects, per-directory store adoption) were v1-app-specific.

### 4. Low-priority agent shell commands (port, trivial)

v1: `1059467` in `packages/opencode/src/tool/shell.ts`. v2 target: `packages/core/src/shell.ts`, `Shell.create`'s spawn — wrap with `nice -n 19 ionice -c 2 -n 7` on linux, keeping the pid-preserving exec property the fence annotation (5a) relies on. The `shell.create.before` plugin hook can also mutate the invocation, but a wrapped command string would show in `Info.command`; patch the spawn as in v1.

### 5. Firecracker cgroup fence integration (split)

- **5a — OOM-killed command annotation (port).** v2's `finish()` in `packages/core/src/shell.ts` already captures the kill signal (`CrossSpawnSpawner.KilledBySignal`) on the exit path; port `util/cgroup.ts` (`0c929ca`'s `packages/opencode/src/util/cgroup.ts`) into `packages/core/src/util/` essentially unchanged — the guest mechanics (`FC_AGENT_CG` leaf resolution, `fc-cmd-<pid>-*` scan, `oom_kill` in `memory.events`) are opencode-independent — and annotate the `ShellResult` capture as in v1.
- **5b — fenced LSP leaves (no target).** v2 has no LSP launch machinery; nothing to fence. Dropped together with the LSP regression noted above. If upstream reintroduces LSP, fence it at the spawn site the same way.

### 6. Sync-history aggregate-scoped reads (drop — obsolete)

No `/sync/history` exists in v2; the SSE feed plus per-aggregate indexed reads replaces the polling protocol, eliminating the defect class rather than fixing it. Nothing to port; watch incidents, not code.

### 7. Fence-kill circuit breaker (port)

v1: `45dfb2b` + `318f171`. `util/fence-breaker.ts` is a pure per-session state machine and ports nearly verbatim; the gate goes in `Shell.create` before spawn (refusal is a normal tool result the model reads; before any permission ask), tripped by 5a's fence-kill detection. `OPENCODE_FENCE_BREAKER` knob semantics unchanged. Port `test/util/fence-breaker.test.ts` alongside.

## The overlayfs plugin (rewrite)

v1: `~/.config/opencode/plugins/overlay-workspace.js` against `experimental_workspace`. v2 rewrite against the promise plugin API (`@opencode/plugin`, `Plugin.define`):

- `ctx.worktree.transform((editor) => editor.add({ id: "overlayfs", create, remove, list }))` — `create` starts `fc-overlay@<slug>` and returns `{ directory: "/home/dev/workspaces/<slug>" }`; `remove` stops it (unmount + delete upper); `list` returns mounted workspaces as worktree entries. `branch` is accepted and ignored (workspaces branch from the repos-base snapshot by construction — same semantics as v1).
- Auto-reclaim: `ctx.event.subscribe` on session archived/deleted — when no other non-archived session shares the workspace, remove the worktree; archive first pushes the transcript (`fc-transcript-archive`), as in v1. Fail safe: if the session list can't be read, nothing is destroyed.
- The fc-opencode guest units (`fc-overlay@.service`, sudoers, `fc-overlay-add/remove/diff`) are unchanged — the plugin stays a thin adapter over systemd.

## fc-opencode contract changes (provisioner side)

- `opencode-serve.service`: `OPENCODE_WEB_UI_TITLE=%H` stays (after the feature-1 port); `OPENCODE_NEW_SESSION_WORKSPACE=overlayfs` stays (after feature 2); `OPENCODE_EXPERIMENTAL_WORKSPACES` is dropped.
- Yolo-permission global config (`TPL_OPENCODE_GLOBAL_CONFIG`): the v2 permission model differs (policy allow/deny, permission rulesets on `session.create`); a v1-compat layer exists (`packages/core/src/config/plugin/compatibility.ts`, compatibility roots include `~/.claude` and `~/.agents`). Verify the baked block translates; expect a v2-shaped rewrite.
- `fc-sessions`: the v1 URL scheme `/<base64url(dir)>/session/<id>` is gone — the v2 app routes by server and session id (multi-server). Rework against v2 routing.
- `fc-transcript-archive`: v1 endpoints `/session/$SID` and `/session/$SID/message` become `/api/session/:id` and `/api/session/:id/message` with new shapes; v2 also has a structured `session.export` (transfer format) that may serve the archive better than scraping message parts.
- Release resolver: keep publishing fork releases with the `opencode-linux-x64.tar.gz` asset name (`pick_release_tag` walks releases per-arch; tag scheme `v2.0.x-neumark.N`). The v1 build process in `main`'s FORK.md needs its v2 counterpart here when the first release is cut (CLI builds from `packages/cli`, `bun script/build.ts`).
- Secrets channel: v2 imports legacy `~/.local/share/opencode/auth.json` credentials at migration — keep shipping `auth.json` through `secrets/vm$SLOT`.

## Phases

1. **Phase A — stock v2 in one slot, no fork features.** Build upstream v2.0.x, run it in one VM behind the existing tailnet serve; guest plumbing only (serve unit env, yolo-config translation, the overlayfs strategy plugin with auto-reclaim and transcript archiving). Validate: long-loop agent sessions at incident-history workloads; overlay semantics (per-tab isolation, subagent sharing via `parentID`); daemon IO/memory profile (`fc-disk`, `/proc/<pid>/io`, per-cgroup `io.stat` — the incident-14 amplification class); serve stability across days.
2. **Phase B — fork features.** Port 1, 4, and 5a+7 (one cluster, one file), then 2 (server-side default binding). Tests land per v2's per-package `bun test` layout; `fence-breaker.test.ts` and `cgroup.test.ts` port nearly verbatim.
3. **Promote.** When the deployment is satisfied, tag releases off this branch (`v2.0.x-neumark.N`) and point fc-opencode's resolver at them; `main` stays the v1 sunset mirror until the last v1 guest is retired.

## Open risks

- **LSP regression**: no agent-facing diagnostics in v2 as of v2.0.27 — a real capability loss for code-heavy loops. Track upstream; nothing this fork can port onto.
- **API drift**: worktree strategies and the plugin API are fresh v2 surface; expect adjustments on rebase — the price of leaving a frozen line.
- **Load profile unproven**: the Effect-based core, drizzle storage, and SSE feed have never run this deployment's 24/7 loops and giant transcripts; Phase A measures before Phase B commits.
- **Release cadence**: v2 ships ~daily; base and rebase only on `sync release versions` commits.
