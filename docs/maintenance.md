# Maintenance checks

Use Node.js 24 or later. From a disposable checkout, run `npm ci` followed by
`npm run check`. The aggregate runs the existing type checks, complete default
Server and Web test suites, and `build:check`, in that order. A failure stops
the aggregate and remains visible. Both test suites cap workers at two.

`build:check` builds a snapshot of indexed file paths using current working
tree bytes and verifies that the original `server/dist` and `web/dist` stay
unchanged. Stage new files before verification so they enter the snapshot.
Type checks and tests can write caches; use isolated test data and avoid
running checks against an active project's data or session directories.

The [CI workflow](../.github/workflows/scienceevolve-ci.yml) uses the same
aggregate on push, pull requests and manual runs, with read permissions and a
30 minute timeout. Failed isolated build diagnostics are retained for 14 days.
Optional native Harness tests, live gateways, Inspire, Windows and deployment
are outside this default check. A workflow file, a successful Actions run and
a required merge check are separate states.

Rule ownership:

- Runtime and API types live in `server/src/types.ts`; the Web display tuple
  and guard live in `web/src/project-status.ts`, with derived types re-exported
  from `web/src/types.ts`. API fallback and strict cache validation remain
  separate callers. `web/src/project-status.test.ts` checks the actual Server
  lifecycle, retained Web extensions and display mapping, including a drift
  counterexample. Similar names alone do not establish equal semantics.
- Browser-compatible rules already shared with Web live under
  `server/src/internal/shared/`. Keep Node, storage and adapters out of their
  dependency graph. Harness boundaries are checked by
  `server/tests/harness-architecture.test.ts`.
- Browser-reachable Server imports are discovered from production Web source
  and checked transitively by `server/tests/browser-shared-dependencies.test.ts`.
  The check follows local aliases, re-exports and literal dynamic imports or
  require calls, permits explicit type-only edges, and rejects computed direct
  loads. New runtime packages need concrete browser verification; declaration
  files alone are insufficient, including initial entries. Production runtime
  imports into excluded Web test modules fail rather than bypass the scan.
  Entry discovery follows local implementation imports outside `web/src`,
  including aliased bridges and cycles; those paths cannot hide a Server
  dependency. Declaration-only local bridges require explicit type-only use.
  This is a static dependency check, not a
  sandbox for arbitrary JavaScript loaders.
- Trace decoding and grouping live in `web/src/trace-model.ts`; rendering and
  navigation state remain in `WorkspacePage.tsx`, including its original
  `buildTraceEntries` / `TraceEntry` export paths.
- Pure Main route, display and finish validation lives in `server/src/main-decision.ts`.
  `orchestrator.ts` retains the original function and error-class exports and
  owns state commits, control authority and event ordering.
- The Facade's `onLiveHarnessEvent` carries validated canonical `HarnessEvent`
  values. Its Record intersection preserves generic observation callbacks.
  Keep the Adapter's raw `onOfficialHarnessEvent` boundary distinct; its
  compatibility bridge still needs explicit interpretation. Runtime ingress
  validation, invocation identity, deduplication and ordering remain required.
- Public runtime fixes start in the Server source and reach the SDK through
  its pinned manifest and exact fixes; see [host boundaries](main-sdk-parity.md)
  and the SDK checkout's `sdk/scripts/sync-main-runtime.mjs`. Server CI belongs
  to this host and is not copied into generated SDK runtime files.

The fingerprints in `server/tests/fixtures/shared-source-fingerprints.json`
pin reviewed Server source bytes. SDK delivery has its own pinned revision
and subset; the recommendation and Explainer services are Server entries.
Review source changes, ownership and behavior before updating fingerprints,
and retain every registered check and its exact byte comparison.

Preserve input defaults, failures, permissions, event ordering, historical
reads and recovery. For each independent change, run the relevant checks,
review the staged diff and commit only that change; keep pre-existing work
out of the commit. Record both source and target commits for public fixes.

The shared local/CI command borrows only the common-entrypoint idea from
[DSH's pinned gate runner](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/scripts/run-gates.ts),
without importing its scheduler or coverage policies. Workflow syntax follows
[GitHub Actions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax).
