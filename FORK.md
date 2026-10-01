# Fork deltas vs mainline opencode

This fork (`neumark/opencode`) is the opencode build used inside [fc-opencode](https://github.com/immediately-run-worker/fc-opencode) Firecracker microVM development environments. It tracks mainline (`anomalyco/opencode`) `dev`: the `main` branch is the single integration branch — upstream history plus every fork feature — and releases are tagged off it. (Until `v1.18.32-neumark.1` the workflow was a `dev` mirror branch plus a `web-ui-title` release branch rebased onto it, with periodic dev merges before `v1.18.31-neumark.7`; after `v1.18.32-neumark.1` both were consolidated into `main`, `dev` was deleted, and `web-ui-title` is retained as historical. Release tags pin their commits and are never moved.) The fork adds a small set of server, web UI, and shell features.

Everything not listed here is stock mainline. In particular, the **experimental workspaces machinery is upstream code** (control-plane `Workspace` service, adapter runtime, `/experimental/workspace` routes, the `experimental_workspace` plugin API, workspace-aware v2 SDK client) — this fork does not modify it; it builds on it.

## Release lineage

Releases are tagged `v<upstream-version>-neumark.<N>` off `main` (through `v1.18.32-neumark.1`, off `web-ui-title`) and published manually (no CI: upstream `publish.yml` is gated on `github.repository == 'anomalyco/opencode'`). Through `v1.18.31-neumark.6` each release shipped a single `opencode-linux-x64.tar.gz` asset; `v1.18.31-neumark.7` through `v1.18.32-neumark.1` shipped both `opencode-linux-x64.tar.gz` and `opencode-linux-arm64.tar.gz` (arm64 cross-compiled by bun); from `v1.18.33-neumark.1` releases ship `opencode-linux-x64.tar.gz` only (operator decision — the deployment hosts are x64). Consumers walk the release list per-arch (fc-opencode's `pick_release_tag` picks the newest release actually shipping `opencode-linux-<arch>.tar.gz`).

| Tag | Contents |
| --- | --- |
| `v1.18.29-neumark.1` | Upstream rebuild (no fork changes) |
| `v1.18.29-neumark.2` | `OPENCODE_WEB_UI_TITLE` (`374b444`) |
| `v1.18.31-neumark.1/.2` | Upstream `dev` merges (v1.18.31 base, experimental workspaces available) |
| `v1.18.31-neumark.3` | `OPENCODE_NEW_SESSION_WORKSPACE` (`60d0229`), nice/ionice agent shell (`1059467`) |
| `v1.18.31-neumark.4` | Home page lists workspace-bound sessions (`2a40543`) |
| `v1.18.31-neumark.5` | Home page fallback project for workspace-bound sessions (`27449d3`) |
| `v1.18.31-neumark.6` | Workspace `extra.origin`: sessions belong to their origin directory (`2c0e29c`) |
| `v1.18.31-neumark.7` | First release off the rebased (linear) history; first dual-arch release — adds `opencode-linux-arm64.tar.gz`; binary code identical to `.6` (delta is this doc + history shape) |
| `v1.18.32-neumark.1` | Second rebase onto upstream `dev` (base `34aa4274`, upstream 1.18.32); no new fork features — binary delta is upstream changes only |
| `v1.18.32-neumark.2` | Firecracker cgroup fence integration (`c73da62`, feature 5) — shell-tool OOM-kill annotation + fenced LSP leaves; first release off the consolidated `main`; x64 asset only (arm64 consumers fall back to `.1`) |
| `v1.18.33-neumark.1` | Third rebase onto upstream `dev` (base `2fa3363c`, upstream 1.18.33) + sync history aggregate-scoped index reads (feature 6 — the 84MB/s event-table read spiral fix, upstream issue #52270); x64-only releases from here |
| `v1.18.33-neumark.2` | Fence-kill circuit breaker (feature 7 — `45dfb2b` + `318f171` hardening): shell commands in a session are refused after N windowed fence-killed command trees, half-open cooldown probe (`OPENCODE_FENCE_BREAKER`); pairs with the fc-opencode guest-side cwd-attributed breaker (`9d6a0aa` + `6971dba`), which catches cross-session retries through a shared cwd |

Commit hashes above are the ones the tags pin (pre-rebase history); the equivalent post-rebase commits are `240eb50`, `a2a088a`, `97d3063`, `46a088c`, `d6c987c`, `5d3cb26`.

## Features

### 1. Web UI title override — `OPENCODE_WEB_UI_TITLE`

**What it does**: sets the `<title>` of the served web UI, so each VM's browser tab shows its hostname instead of "opencode" (fc-opencode sets `OPENCODE_WEB_UI_TITLE=%H` in the guest systemd unit).

**Implementation** (`374b444`):
- `packages/core/src/flag/flag.ts`: new `OPENCODE_WEB_UI_TITLE` flag.
- `packages/opencode/src/server/shared/ui.ts`: `htmlWithTitle()` replaces the `<title>` block of every served HTML document — both the embedded UI (build-time generated asset map) and the `app.opencode.ai` proxy path used when `OPENCODE_DISABLE_EMBEDDED_WEB_UI` is set. Replacement uses a function so `$` sequences in the title are never treated as replacement patterns; the title is HTML-escaped. `cspForHtml()` recomputes the `sha256` hash of the inline theme-preload script so the strict `script-src` CSP still validates after injection.
- Tests: `packages/opencode/test/server/httpapi-ui.test.ts`; docs: `packages/web/src/content/docs/{server,web}.mdx`.

### 2. Per-session default workspace binding — `OPENCODE_NEW_SESSION_WORKSPACE`

**What it does**: binds every **new top-level session** (i.e. every new browser tab) to a **fresh workspace** of the configured adapter type — in fc-opencode, `overlayfs`: a private copy-on-write overlay of the shared repos base, so tabs cannot see each other's file changes. Subagents/children share their parent's workspace. The environment variable holds the adapter type name (e.g. `overlayfs`).

**Implementation** (`60d0229`):
- `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` — `defaultWorkspace()` runs before every session create (`create` and `createRaw`):
  - payload already carries `workspaceID` → route the session into that workspace's directory (local targets only);
  - else `OPENCODE_NEW_SESSION_WORKSPACE` set, no `parentID` (children keep the parent's workspace), and an adapter of that type is registered → `Workspace.create()` a fresh workspace and rewrite the payload to `{ directory: <workspace dir>, workspaceID }`;
  - otherwise pass through unchanged (trunk session). An unregistered type (plugin missing, fresh boot) degrades to trunk instead of erroring.
- `packages/opencode/src/session/session.ts` — `Session.CreateInput` gains an optional `directory`; an explicit directory (the default-workspace rewrite) wins over the routed instance directory.
- Integration tests: `packages/opencode/test/server/httpapi-session-workspace-default.test.ts` (trunk default, fresh binding, parallel distinctness, parented creates untouched, explicit-ID reuse, missing-adapter fallback, subagent sharing).

**Operational requirement**: upstream gates the workspace machinery behind the `experimentalWorkspaces` runtime flag (`OPENCODE_EXPERIMENTAL_WORKSPACES=true`, or the global `OPENCODE_EXPERIMENTAL`). With the flag off, `Workspace.startSync` returns *before* emitting the `Status` event that `Workspace.create` waits for, so every `POST /session` dies with `Timed out waiting for global event` → HTTP 500 — while adapter registration and overlay mounts still work, which makes the failure easy to misread as a plugin problem. Deployments **must** set `OPENCODE_EXPERIMENTAL_WORKSPACES=true` alongside `OPENCODE_NEW_SESSION_WORKSPACE`.

### 3. Workspace origin tracking and home page integration

**What it does**: workspace-bound sessions are listed, labeled, grouped, and opened under the **origin directory** they were started from (e.g. `~/repos`) — the per-session workspace directory (`~/workspaces/<slug>`) is plumbing and never surfaces as a project. Each session appears in exactly one directory context.

**Why it was needed**: three successive gaps (fixed in `.4`, `.5`, `.6`):
1. The web home page filters its session index to sessions whose `directory` exactly matches an open project card's directory (`buildHomeSessionRecords`) — workspace directories matched none, so workspace-bound sessions never listed.
2. Surviving records must resolve to a project or they are dropped; the home page's project list is a *local store of open cards* (entries carry no `id`), so `projectID: "global"` lookups miss and workspace sessions only resolved while a card for the workspace directory happened to exist (a session tab creates one via `projects.open()`), making them flicker.
3. `session.created`/`session.updated` events are delivered on the event channel of the directory the *request* ran under (the origin), but carry `info.directory` = the workspace directory; the per-directory store reducers inserted them without a directory check, so the same session appeared under both the origin context and the workspace context. (The UI has a `session.moved` reducer that would reconcile this, but no server event feeds it.)

**Implementation**:
- `2a40543` — `packages/app/src/pages/home/home-sessions-controller.tsx`: sessions with a `workspaceID` bypass the exact-directory filter.
- `27449d3` — same file: unresolvable workspace-bound sessions get a fallback project `{ worktree: session.directory, expanded: true }` (label = workspace slug) instead of being dropped.
- `2c0e29c` — origin tracking:
  - Server: `defaultWorkspace()` records `extra: { origin: <InstanceState.directory> }` on the workspace. `extra` is the existing JSON column (`WorkspaceTable.extra`), flowing `CreateInput.extra → adapter.configure(info) → config.extra → Info.extra → DB → GET /experimental/workspace`; adapters that spread their config (the overlayfs plugin does) pass it through untouched. No schema migration.
  - UI (`home-sessions-controller.tsx`): a `workspaceOrigins` signal (`workspaceID → origin | undefined`) loaded via `client.experimental.workspace.list()` reading `item.extra.origin`, with an `originsQueried` set + in-flight guard so a referenced-but-missing workspace (dangling, reclaimed, other project, flag off) cannot spin a refetch loop. Record building resolves `origin` and matches project cards / `projectForSession` against it; the fallback becomes `{ worktree: origin ?? session.directory }`; the open handler opens `project?.worktree ?? origin ?? session.directory`, so opening a workspace session never creates a project card for the workspace directory.
  - UI (`packages/app/src/context/global-sync/event-reducer.ts`): `session.created`/`session.updated` skip *inserting* a not-yet-present session into a directory context when `info.workspaceID && pathKey(info.directory) !== pathKey(input.directory)` (updates to already-present sessions remain unconditional). The workspace's own context still receives its sessions via its scoped session list.
  - Workspaces created before `.6` have `extra: null` and keep the slug-label fallback; backfilling `extra` to `{"origin": "<dir>"}` in the `workspace` table restores origin labeling.

### 4. Low-priority agent shell commands (linux)

**What it does**: agent tool shell commands run under `nice -n 19` + `ionice -c 2 -n 7` (best-effort class, lowest priority), so builds/tests yield CPU and IO to the opencode server and web UI inside small VMs.

**Implementation** (`1059467`): `packages/opencode/src/tool/shell.ts` — on `process.platform === "linux"`, `cmd()` spawns `nice -n 19 ionice -c 2 -n 7 <shell> -c <command>` (detached, stdin ignored); other platforms unchanged.

### 5. Firecracker cgroup fence integration (fc-opencode guests)

**What it does**: two integrations with the fc-opencode guest memory fences — the `opencode-serve.service` unit cgroup (MemoryHigh/Max/SwapMax 55/65/8% of MemTotal) and the per-command `fc-cmd-<pid>-*` leaves (40/50/5%, `memory.oom.group=1`) that the guest `BASH_ENV` shell hook creates for every agent command. Both are inert outside an fc-opencode guest: the cgroup base directory (`FC_AGENT_CG`, default `/sys/fs/cgroup/system.slice/opencode-serve.service`) simply does not exist anywhere else, and every entry point is best-effort. No unit or fc-opencode changes are required.

1. **Shell-tool OOM annotation.** A fence-killed command tree dies by SIGKILL (`oom.group` takes the spawned shell with it), which the spawner reports as a failed `exitCode` — previously an `orDie` defect: an unexplained tool crash the model tended to retry verbatim, straight back into the fence (observed live: one agent's `npm run verify` OOM-thrashed a 12G VM repeatedly). The tool now catches that failure in the exit race, parses the signal name from the spawner's `PlatformError` cause, and matches the dead pid against the hook's leaf (`fc-cmd-<pid>-*` — the feature-4 `nice`/`ionice` wrappers exec, preserving the pid, so the spawned shell's pid *is* the pid the hook fences): `oom_kill > 0` in the leaf's `memory.events` annotates `<shell_metadata>` that the kill is a deterministic fence kill and to retry with *lower concurrency*, not verbatim. Other external signal deaths become annotated results ("terminated by signal X") instead of defects; exit code 137 with fence evidence gets the same annotation. Timeout/abort paths are unchanged (they win the race before any kill). The leaf of an OOM-killed tree survives until a later hook invocation prunes it, well after the annotation check runs.

2. **Fenced LSP leaves.** Every LSP launch (builtin and config-defined servers both funnel through `lsp/launch.ts`) moves the spawned server into its own `fc-lsp-<binary>-<pid>` leaf under the unit cgroup, fenced at `memory.high`/`memory.max`/`memory.swap.max` = 15%/20%/5% of MemTotal with `memory.oom.group=1`. Previously all language servers lived in the daemon's `fc-home` leaf: four bloated servers (~900MB each, observed) ate the unit's budget alongside the daemon, squeezing server responsiveness whenever agent commands ran. A runaway server is now killed by its own fence and lazily respawned by the LSP layer; leaves of dead servers are pruned at the next launch (`rmdir` only succeeds on empty cgroups). The leaves carry no cpu fence on purpose — the unit-level `CPUQuota=480%` caps the aggregate and indexing speed is user-visible.

**Implementation** (`c73da62`): `packages/opencode/src/util/cgroup.ts` (base resolution via `FC_AGENT_CG`, `oomKilled(pid)` leaf scan, `fenceLsp(pid, cmd)`); `packages/opencode/src/tool/shell.ts` (`Effect.catch` on `exitCode` in the exit race, `signalOf`, `meta` annotations); `packages/opencode/src/lsp/launch.ts` (fence after the stream check). Tests: `packages/opencode/test/util/cgroup.test.ts`.

### 6. Sync history: aggregate-scoped reads (event-table read spiral)

**What it does**: `POST /sync/history` (the multi-tab sync protocol's catch-up — "events with seq > value are returned for listed aggregates, unlisted aggregates get their full history") now reads each aggregate through the `event_aggregate_seq_idx` index instead of full-scanning the whole `event` table.

**Why it was needed** (measured live on an fc-opencode guest, INCIDENT_HISTORY #12-14): the old query shape — `WHERE NOT(OR((aggregate_id = ? AND seq <= ?), ...)) ORDER BY seq` — cannot use any index (negation of OR over composite keys, and no global seq index exists), so every sync poll full-scanned the ENTIRE event table and sorted it through a temp B-tree: O(table) disk reads per call. On a long-lived session whose aggregate held ~84MB of durable events that was **84MB of disk reads per poll**, ~once per second per reconnecting client — sustained 50-84MB/s on an otherwise idle VM (`bun:sqlite` reads are io_uring-backed, invisible to `read(2)` accounting, strace, and fanotify — only `/proc/<pid>/io` `read_bytes` and per-cgroup `io.stat` see them), superlinear across incidents (1.18TB → 3.1TB) as the event log grew with the longest-lived session. Worse, the read load starved the very HTTP responses those clients were waiting for: they timed out, reconnected, and polled again — a self-sustaining read spiral (dozens of CLOSE-WAIT sockets from the reverse proxy as evidence).

**Implementation**: `packages/opencode/src/server/routes/instance/httpapi/handlers/sync.ts` — enumerate aggregates from `event_sequence` (one row per aggregate; a superset of `event`'s aggregates by FK — `selectDistinct` over `event` itself would still be a full covering-index scan per poll), then one indexed range scan per aggregate (`aggregate_id = ?` [+ `seq > watermark`]), union and sort by seq in memory: cost scales with the response, not the table; a fully-watermarked aggregate reads zero rows. Row-set semantics match the old shape on a static table; within an aggregate `seq` is unique so per-aggregate order is exactly preserved (cross-aggregate tie order was unspecified before and stays unspecified); the N+1 statements are not one snapshot — aggregates created after the enumeration are caught by the next poll, benign for a watermark catch-up protocol. Large aggregates are appended with loop-push (spread-push blows the JS stack above ~500-700k events). Reviewed by an independent Qwen3.8-Max agent pass (semantics parity verified with EXPLAIN QUERY PLAN against a scratch schema; measured 413ms → ~40ms on 200k rows). Tests: `packages/opencode/test/server/httpapi-sync.test.ts` (watermark skips a caught-up aggregate, unknown aggregates keep full history, mid-watermarks return only newer events, ghost-aggregate watermarks ignored, watermark 0 valid, global seq ordering).

### 7. Fence-kill circuit breaker (shell tool)

**What it does**: after N fence-killed command trees in a session (within a
window), further shell commands in that session are **refused** —
deterministically, as a normal tool result the model can read — for a
cooldown, then one half-open probe is allowed (a clean exit resets the
breaker, a fence kill re-trips it instantly).

**Why it was needed**: the fences kill runaway command trees deterministically,
but nothing stopped the agent from *retrying the same ballooning command
forever* — measured live as a **55-oom_kill retry cycle** (one roadmap
workflow session): each climb wedged the VM in reclaim churn (PSI memory
60-90% bursts) while the killed run's output grew the transcript, and with it
the per-step context re-assembly (the read-amplification spiral), so every
retry was more expensive than the last. The advisory annotation alone
demonstrably does not stop the cycle (55 kills despite "retry with lower
concurrency"); the breaker makes refusal deterministic. A refusal is also
~200 bytes instead of a multi-MB killed-run output — it stops the transcript
bloat at the source.

**Implementation**: `packages/opencode/src/util/fence-breaker.ts` — per-session
in-memory state machine. Closed: kills are counted with window decay and a
clean completion does **not** clear them (the real-world cycle interleaves
cheap clean commands — ls/cat/tail — between balloon attempts; only window
decay or a concluded probe clears history). Open at N windowed kills: shell
execution is refused for the cooldown (a kill recorded while open re-arms
it). Half-open after the cooldown: a single in-flight probe **claim**
(concurrent commands get a short refusal); a clean exit — neither a fence
kill, a tool timeout, nor a user abort — concludes the claim and resets; a
fence kill re-trips **unconditionally** (the cooldown elapsed but the
workload still balloons — window arithmetic does not get a vote). The gate
runs before the permission ask (a refusal never executes, so it must not
prompt) and the trip annotation keys off actual refusal state (honest when
refusal is disabled). Detection is fail-open by design (a kill masked by the
tool's timeout/abort race or an unattributed exit-137 undercounts). Knobs:
`OPENCODE_FENCE_BREAKER="N,windowSeconds,cooldownSeconds"` (defaults
`"3,3600,600"`); `"0"`/`"off"` disables the refusal (counting continues);
garbage values log once and fail **safe** to the defaults. Inert outside
fc-opencode guests. Verified end-to-end on a live guest: balloon command ×3
(counted annotations, breaker trips) → 4th attempt refused pre-spawn with
no process ever started. Independently reviewed (Qwen3.8-Max agent pass,
verdict request-changes → findings fixed: phantom probe claims erasing
sub-threshold history, gate-after-permissions, disabled-mode annotation lie,
concurrent probe claims, window-decay re-trip, timeout/abort reset, garbage
fail-open). Tests: `packages/opencode/test/util/fence-breaker.test.ts` (15:
state machine incl. clean-command interleaving regression, kill-during-
cooldown re-arm, exclusive probe claim, decay re-trip, window decay, stale
entry hygiene, settings parse incl. partial + garbage fail-safe, disable
switches, per-session isolation).

## Build and release process

```sh
# bun version is pinned by the root package.json packageManager field (bun@1.3.14)
bun install
cd packages/opencode
OPENCODE_VERSION=<x.y.z-neumark.N> bun script/build.ts --single   # linux-x64 only
# → dist/opencode-linux-x64/{bin/opencode, package.json}; smoke test runs --version
cd dist/opencode-linux-x64/bin && tar -czf /tmp/opencode-linux-x64.tar.gz *
gh release create v<x.y.z-neumark.N> /tmp/opencode-linux-x64.tar.gz \
  --repo neumark/opencode --target main
```

- The build embeds the web UI: `packages/app` is built with vite and every dist file is compiled into the binary as a generated path→file map (`opencode-web-ui.gen.ts`, served via `fs.readFile` from the bun-compiled asset store). UI-only changes therefore require a full binary rebuild and a new release.
- The pre-push hook runs `bun typecheck` (turbo, whole monorepo) and a bun version check; `bun` must be on `PATH` when pushing.
- Keep mainline current by fetching upstream (`anomalyco/opencode`) `dev` and rebasing `main` onto it (`git rebase <upstream-dev> main`, then push with `--force-with-lease`). Release tags pin released binaries and are never moved by rebases.

## Deployment contract (fc-opencode)

The guest systemd unit (`opencode-serve.service`) sets:

```ini
Environment=OPENCODE_WEB_UI_TITLE=%H
Environment=OPENCODE_NEW_SESSION_WORKSPACE=overlayfs
Environment=OPENCODE_EXPERIMENTAL_WORKSPACES=true
```

and ships an `overlayfs` workspace adapter plugin (registered through the upstream `experimental_workspace` plugin API): `configure` sets the workspace directory under `~/workspaces/<slug>` (spreading config, so `extra.origin` survives), `create`/`remove` start/stop `fc-overlay@<slug>.service`, and `target` returns `{ type: "local", directory }`. Each workspace mounts an overlay with the shared read-only repos base as `lowerdir` and a per-workspace delta as `upperdir`; the trunk `~/repos` is a separate overlay with a VM-wide shared delta, and the rest of the guest filesystem is shared by all sessions (isolation there is per-VM only).
