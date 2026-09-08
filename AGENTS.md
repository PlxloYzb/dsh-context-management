# Development contract

- Product: dsh-context-management 0.1.1, targeting DSH 0.1.2-rc.1. Runtime behavior is defined by the source and regression tests; document justified changes in the changelog.
- Reference repositories dsh-arc-context and codex-main are read-only. This repository owns all changes and release artifacts. Do not import runtime code through absolute reference or host installation paths.
- TypeScript strict, ESM. No as any, @ts-ignore or hidden global singleton session state. Host packages remain external; acp-kernel stays exactly pinned.
- Session changes are append-only and pass through the shared transaction implementation. Adjacent summary/replacement shadow pricing uses host heuristicTokens. Never subtract the archive ledger from the host projectedTokens.
- new_context accepts an intent; commit at a safe pre-step boundary. Protect current user input and tool pairing. Cancellation and disposal own pending work.
- Retrieval is bounded historical data. Session-local sources and cursors, explicit incomplete/error states, no silent loss or ambiguous ID selection.
- Run meaningful regression tests and real host integration. For engine changes, also run the three-arm Web/model gates in tests/live. Preserve failures in ignored test output and report unexercised conditions honestly.
- Use isolated test profiles and synthetic sessions. Never print/save model credentials or browser authentication tokens in distributable evidence. Do not change daily profile defaults.
- Keep Chinese and English READMEs concise: product introduction, package-name install/remove examples, and links to bilingual design/test documentation. Curated, sanitized public test data lives in docs/data/; keep raw generated reports under .test-runtime/ and packages under artifacts/, both ignored. npm pack must pass prepack checks. Public npm publishing is performed separately by the user.

- Installation enables the bundle only in the target profile. Replace native Basic in its existing realm; leave presets without compaction and third-party backends unchanged. Never edit preset files.
