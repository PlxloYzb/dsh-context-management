# Source reuse

Initial source and regression-test selection: src/*.ts and tests/*.ts from dsh-arc-context 0.2.0-beta.15, commit 82fc3004d10c445f82aa97a93ad2a88a3a8794cd (MIT). Original LICENSE and NOTICE retained. The new package independently adapts these modules for DSH 0.1.2-rc.1 and window management; old research claims are not product evidence.

Codex local snapshot (Apache-2.0) informs the request/deferred-window lifecycle, budget separation, per-window reminders and state/replay testing. No Codex runtime source is included in the initial TypeScript selection. Audited paths and hashes are in docs/evidence/source-manifest.json.

acp-kernel 0.0.24 remains pinned and bundled. Host @deepseek-ai packages are external peer dependencies. Final dependency inventory accompanies the release.

New implementation modules include `archive.ts`, `archive-health.ts`, and
`window-controller.ts`; new host, recovery, generated-property, paging, live
Web and scale fixtures are authored for this package. Tests copied from the
reference are adapted to real DSH nested tool-result and snapshot APIs.
No runtime import reaches either reference repository. Source maps contain
relative source provenance only; host packages remain public external imports.
