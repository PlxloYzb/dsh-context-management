# Development contract

- Product: dsh-context-management 0.1.0, targeting DSH 0.1.2-rc.1. The accepted docs/SPEC.md and docs/ARCHITECTURE.md define behavior; record justified refinements with implementation and tests.
- Reference repositories dsh-arc-context and codex-main are read-only. This repository owns all changes and release artifacts. Do not import runtime code through absolute reference or host installation paths.
- TypeScript strict, ESM. No as any, @ts-ignore or hidden global singleton session state. Host packages remain external; acp-kernel stays exactly pinned.
- Session changes are append-only and pass through the shared transaction implementation. Adjacent summary/replacement shadow pricing uses host heuristicTokens. Never subtract the archive ledger from the host projectedTokens.
- new_context accepts an intent; commit at a safe pre-step boundary. Protect current user input and tool pairing. Cancellation and disposal own pending work.
- Retrieval is bounded historical data. Session-local sources and cursors, explicit incomplete/error states, no silent loss or ambiguous ID selection.
- Run meaningful regression tests, real host integration and the accepted Web/model release gates. Preserve failures and report unexercised conditions honestly.
- Use isolated test profiles and synthetic sessions. Never print/save model credentials or browser authentication tokens in distributable evidence. Do not change daily profile defaults.
- Update user documentation and release evidence with implementation. Deliver a tested local tarball; public npm publishing and old-package deprecation are separate actions.
