# Fork deltas vs mainline opencode — v2 port line

This branch (`v2` in `neumark/opencode`) is the **port line for OpenCode 2**. It tracks upstream (`anomalyco/opencode`) `dev` — the live v2 line, where 2.0.x releases are cut as orphan `release:` commits pinned by tags with matching `sync release versions` commits on the branch (same shape as the v1 line). The branch is based at the `v2.0.27` release-sync commit and rebases onto release-sync commits only, never moving dev tips, to keep rebases bounded. The upstream `2.0` branch is a stale April-2026 exploration branch — not the port target. `main` remains the v1 integration branch (currently `v1.19.0-neumark.1`; its `FORK.md` carries the v1 feature specs, release lineage, and the incidents that bought each feature, with `INCIDENT_HISTORY.md` in fc-opencode) until this line proves out in deployment.

**Current state: fork features ported (Phase B, `v2.0.27-neumark.3`)** — features 1, 2, 4, 5a, and 7 are in; 3 and 6 stay dropped by design. Also carried: a tmp-root fallback (`packages/util/src/global.ts`, `v2.0.27-neumark.2`) — the default `$TMPDIR/opencode` root crashed startup with EEXIST whenever a *file* named `opencode` sat in the shared tmp dir (observed live deploying the first v2 build); it now falls back to a private `mkdtemp` directory. Not yet ported: the guest-side overlayfs strategy plugin and the fc-opencode contract changes below (Phase A guest work).

## Why port (and why not a rebase)

Upstream `dev` is the v2 rewrite: `packages/opencode` is deleted, split into `cli`/`server`/`core`/`schema`/`protocol`/…; every file the v1 fork patches is gone or rewritten. This is a reimplementation project, not a rebase (already noted in `main`'s FORK.md). What v2 buys this deployment:

- The fork's most fragile dependency — the undocumented `experimental_workspace` plugin API — is replaced by a **supported** worktree-strategy plugin API (`ctx.worktree.transform` in `@opencode/plugin`; upstream ships test fixtures for plugin-provided strategies: `packages/server/test/fixture/worktree-plugin/`).
- `/sync/history` and its full-table-scan read spiral (fc-opencode incident 14, upstream issue #52270) is architecturally gone: v2 syncs clients over an SSE event feed (`event.subscribe` in `packages/server/src/handlers/event.ts`) with no polling catch-up.
- The web app natively attributes worktree sessions to their projects (workspace inventory, `managedWorkspaceDirectories`, per-workspace session grouping) — the v1 fork's feature 3 exists upstream, built properly.
- v1 is in guided-sunset maintenance (v1.19.0 is chores plus the V2 update dialog and `opencode upgrade --major`); v2 is where fixes land.
- Official linux-arm64 builds exist — the fork's x64-only releases were an operator concession, and arm64 could revive Pi-5 slots.

What it costs: v2 currently has **no LSP integration** (v1 fed language-server diagnostics to the agent; v2.0.27 retains only the config schema, `normalizeLsp`, and a settings display panel — there is no launch machinery anywhere in `packages/`), the port below is real work, v2 moves fast (~daily releases; the worktree-strategy and plugin APIs are fresh and may drift), and the daemon's IO/memory profile under this deployment's 24/7 agent-loop load is unmeasured (Phase A exists to measure it).

## Port plan — v1 fork features against v2

### 1. Web UI title override — `OPENCODE_WEB_UI_TITLE` (port, small) — **ported**

v1: `packages/opencode/src/server/shared/ui.ts` (`374b444`). v2 target: `packages/cli/src/services/web-ui.ts` — same shape: replace the `<title>` block of the embedded `index.html` (HTML-escape the value; use a function replacement so `$` sequences stay literal) and recompute the inline-theme-script CSP hash — `cspForHtml()` already exists there and hashes the served HTML. Env plumbing follows the v2 Config pattern (`packages/cli/src/env.ts`). Serve path (`opencode serve --hostname`, `OPENCODE_SERVER_PASSWORD`) is unchanged in v2.

### 2. Per-session default workspace binding — `OPENCODE_NEW_SESSION_WORKSPACE` (redesign) — **ported**

v2 model: sessions live at `Location.Ref` `{ directory, workspaceID? }`; `session.create` accepts `location` and `parentID` (children keep the parent's location natively — subagent sharing parity for free). Worktrees are first-class: `WorktreeStrategies` (`packages/core/src/worktree/strategies.ts`) holds per-project strategies; `editor.add(strategy)` registers one **and selects it as the default**; the new-session picker (main/create/existing) is client-side, and the `workspaces.defaultDestination` setting is app-local — headless/SDK creates bypass both. Port, two halves:

- The guest plugin registers an `overlayfs` worktree strategy (below).
- Server-side default binding, same contract as v1 (`60d0229`), landed at the `session.create` handler (`packages/server/src/handlers/session.ts`) with strategy selection threaded through `Worktree.create` (`strategy` input, no protocol change): env `OPENCODE_NEW_SESSION_WORKSPACE=<strategyID>`, top-level creates get a fresh strategy worktree and a rewritten `location.directory`; unregistered strategy degrades to pass-through (never errors); `parentID` creates untouched. `OPENCODE_EXPERIMENTAL_WORKSPACES` is dropped — worktrees are not experimental in v2. Integration tests: `packages/server/test/session-create-workspace-default.test.ts`.

### 3. Workspace origin tracking + home-page integration (drop — obsolete)

v2's location/project model natively lists, labels, groups, and opens worktree sessions under their project; worktree directories are tracked with their strategy (`WorktreeTable`), and the app exposes workspace inventory without project-card hacks. All three v1 gaps (exact-directory filter, unresolvable projects, per-directory store adoption) were v1-app-specific.

### 4. Low-priority agent shell commands (port, trivial) — **ported**

v1: `1059467` in `packages/opencode/src/tool/shell.ts`. v2: the spawn in `Shell.create` (`packages/core/src/shell.ts`) wraps with `nice -n 19 ionice -c 2 -n 7` on linux, keeping the pid-preserving exec property the fence annotation (5a) relies on. The `shell.create.before` plugin hook can also mutate the invocation, but a wrapped command string would show in `Info.command`; the spawn is patched as in v1.

### 5. Firecracker cgroup fence integration (split)

- **5a — OOM-killed command annotation (port, ported).** v2's `finish()` in `packages/core/src/shell.ts` already captures the kill signal (`CrossSpawnSpawner.KilledBySignal`) on the exit path; `util/cgroup.ts` (`0c929ca`) ported to `packages/core/src/util/cgroup.ts` minus `fenceLsp` (see 5b) — the guest mechanics (`FC_AGENT_CG` leaf resolution, `fc-cmd-<pid>-*` scan, `oom_kill` in `memory.events`) are opencode-independent — and the annotation is appended to the `Shell.result` capture (signal deaths without fence evidence are annotated too; exit 137 with evidence gets the fence annotation).
- **5b — fenced LSP leaves (no target).** v2 has no LSP launch machinery; nothing to fence. Dropped together with the LSP regression noted above. If upstream reintroduces LSP, fence it at the spawn site the same way.

### 6. Sync-history aggregate-scoped reads (drop — obsolete)

No `/sync/history` exists in v2; the SSE feed plus per-aggregate indexed reads replaces the polling protocol, eliminating the defect class rather than fixing it. Nothing to port; watch incidents, not code.

### 7. Fence-kill circuit breaker (port) — **ported**

v1: `45dfb2b` + `318f171` (hardened). `util/fence-breaker.ts` ported nearly verbatim to `packages/core/src/util/fence-breaker.ts` (kill/refusal message builders added beside the state machine); the gate runs at the top of `Shell.create` before the plugin hooks and the permission ask (a refused command never prompts), tripped by 5a's fence-kill detection in `Shell.result`; the shell tool pre-checks the pure `refusing()` read to return the refusal as a normal tool result before `create`'s gate claims the half-open probe. `OPENCODE_FENCE_BREAKER` knob semantics unchanged. `test/util/fence-breaker.test.ts` ported alongside. Known shared limit (reproven by the Oct 13 vm0 storm): the breaker counts fence *kills* — a page-cache re-fault storm whose trees sit under their memory caps never OOMs and never trips it; the io fences/governor remain the aggregate defense there.

### 8. Unsecured serve mode — `OPENCODE_SERVER_UNSECURED` (new, v2-only)

v1 served on the trusted tailnet with no auth; stock v2 always enforces a password (random when unset — rotating per boot, pairing screen per browser). The server layer already supports an open mode (`ServerAuth.required` is false for an empty password) but nothing could reach it: the CLI always generated one, and the pre-API `dispatch` layer enforced credentials independently of `required()`. `OPENCODE_SERVER_UNSECURED=1` (cli `server-process.ts`, read directly like the fork's other knobs — Effect Config treats an empty env value as unset, so the empty-`OPENCODE_SERVER_PASSWORD` spelling can't work) serves with an empty password; `ServerProcess.start`'s guard and `dispatch` now let the empty password through, and the middleware no-ops. Guests set it in the serve unit; `fc-sessions`/`fc-transcript-archive` detect the open mode (and verify journal passwords before trusting them — stale lines linger across mode switches).

### 9. Legacy auth.json import on fresh-database bootstrap (fix, v2-only)

v2's `20260805200742_import_legacy_credentials` migration imports a v1 `~/.local/share/opencode/auth.json`, but only on the upgrade path: a FRESH database takes `DatabaseMigration.apply`'s bootstrap branch, which creates the full schema and records every migration id WITHOUT running any `up()` — so a fresh install over a pre-staged `auth.json` (exactly the fc-opencode guest model: secrets disk stages `auth.json` into every new VM) silently loses all provider credentials. The fork runs `importLegacyCredentials` inside the bootstrap transaction (idempotent — per-integration existence checks — and tolerant of a missing file), so a seeded `auth.json` lands in `credential` on first boot. The stop-side round trip (guest DB credentials exported back to the slot's `auth.json` at VM stop) lives in fc-opencode.

## The overlayfs plugin (rewrite)

v1: `~/.config/opencode/plugins/overlay-workspace.js` against `experimental_workspace`. v2 rewrite against the promise plugin API (`@opencode/plugin`, `Plugin.define`):

- `ctx.worktree.transform((editor) => editor.add({ id: "overlayfs", create, remove, list }))` — `create` starts `fc-overlay@<slug>` and returns `{ directory: "/home/dev/workspaces/<slug>" }`; `remove` stops it (unmount + delete upper); `list` returns mounted workspaces as worktree entries. `branch` is accepted and ignored (workspaces branch from the repos-base snapshot by construction — same semantics as v1).
- Auto-reclaim: `ctx.event.subscribe` on session archived/deleted — when no other non-archived session shares the workspace, remove the worktree; archive first pushes the transcript (`fc-transcript-archive`), as in v1. Fail safe: if the session list can't be read, nothing is destroyed.
- The fc-opencode guest units (`fc-overlay@.service`, sudoers, `fc-overlay-add/remove/diff`) are unchanged — the plugin stays a thin adapter over systemd.

## fc-opencode contract changes (provisioner side)

- `opencode-serve.service`: `OPENCODE_WEB_UI_TITLE=%H` and `OPENCODE_NEW_SESSION_WORKSPACE=overlayfs` active; `OPENCODE_EXPERIMENTAL_WORKSPACES` retained while v1 guests share the image (ignored by v2). `WorkingDirectory=/home/dev/repos` — the trunk git root (fc-repos-setup inits it) that gives the binding its worktree source: v2 project resolution registers sources only for vcs-backed projects, and a plain-directory project fails `Worktree.create` with `SourceDirectoryNotFoundError` (every new-tab session 500s — found live).
- Yolo-permission global config (`TPL_OPENCODE_GLOBAL_CONFIG`): **verified natively migrated** — v2's normalizer translates the v1 `permission` block into native rulesets (live check via `/api/config`); no rewrite needed. `opencode.jsonc` is read as-is.
- The overlayfs plugin ships as `~/.config/opencode/plugins/overlayfs.js` (v2) alongside the v1 `overlay-workspace.js` for the transition; reclaim is delete-only in v2 (no archive API upstream yet — the app's archive button is stubbed).
- `fc-transcript-archive`: continuous capture until v2 grows an archive API — the plugin exports after every run reaches a terminal state and an hourly timer sweeps `--all` (same design as the deployment's claude-code hook in `docs/.claude/hooks/archive-transcript.sh`); deletion costs at most the in-flight run. Replaced by an archive-API hook when upstream ships one.
- `fc-sessions` / `fc-transcript-archive`: dual-version (v1 unauthenticated `/session`, v2 `/api/session` under basic auth with the password pulled from the guest's serve journal); v2 links are `/server/<base64url(origin)>/session/<id>`.
- Release resolver: unchanged — verified against `v2.0.27-neumark.3` (asset name `opencode-linux-x64.tar.gz`, `find`-based install, serve smoke test all match).
- Secrets channel: v2 imports legacy `~/.local/share/opencode/auth.json` credentials — on the upgrade path at migration, and (fork feature 9) on fresh-database bootstrap. Keep shipping `auth.json` through `secrets/vm$SLOT`; fc-opencode's stop path exports guest DB credentials back into it.

## Phases

1. **Phase A — stock v2 in one slot, no fork features.** Build upstream v2.0.x, run it in one VM behind the existing tailnet serve; guest plumbing only (serve unit env, yolo-config translation, the overlayfs strategy plugin with auto-reclaim and transcript archiving). Validate: long-loop agent sessions at incident-history workloads; overlay semantics (per-tab isolation, subagent sharing via `parentID`); daemon IO/memory profile (`fc-disk`, `/proc/<pid>/io`, per-cgroup `io.stat` — the incident-14 amplification class); serve stability across days. *(Status: slot 3 runs `v2.0.27-neumark.3` behind `tailscale serve :4104` with the overlayfs plugin live — binding/distinctness/parent-sharing/delete-reclaim validated end-to-end; yolo config natively migrated (verified via `/api/config`); oomd backstops hot-patched. Transcript archiving runs as continuous capture (per-run export + hourly sweep, fc-opencode `1feb472`). Soak in progress; promote when satisfied.)*
2. **Phase B — fork features.** *(Done — `v2.0.27-neumark.3`: 1, 4, 5a+7, then 2. Tests per v2's per-package `bun test` layout; `fence-breaker.test.ts` and `cgroup.test.ts` ported; feature 2 covered by `session-create-workspace-default.test.ts`.)*
3. **Promote.** When the deployment is satisfied, tag releases off this branch (`v2.0.x-neumark.N`) and point fc-opencode's resolver at them; `main` stays the v1 sunset mirror until the last v1 guest is retired.

## Open risks

- **LSP regression**: no agent-facing diagnostics in v2 as of v2.0.27 — a real capability loss for code-heavy loops. Track upstream; nothing this fork can port onto.
- **API drift**: worktree strategies and the plugin API are fresh v2 surface; expect adjustments on rebase — the price of leaving a frozen line.
- **Load profile unproven**: the Effect-based core, drizzle storage, and SSE feed have never run this deployment's 24/7 loops and giant transcripts; Phase A measures before Phase B commits.
- **Release cadence**: v2 ships ~daily; base and rebase only on `sync release versions` commits.
