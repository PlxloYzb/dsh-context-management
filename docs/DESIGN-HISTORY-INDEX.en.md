# History Retrieval Index Design Contract

Status: **revised per review decisions, moving into implementation.**
Scope: `ArchiveReader.search` and its index. **Summary generation and window-swap strategy are out of scope.**
Goal for this round: a history reading layer whose query semantics are reliable, whose work is bounded, and whose acceleration is incremental.

## 0. Why a contract instead of more tuning

Every motivation below is measured, not inferred:

| Observation | Value | Conclusion |
|---|---|---|
| Single-shot hits (sealed archive, 12 probes) | 5/12 → 4/12 | Block-level filtering regressed once indexing was charged honestly |
| Single-shot hitting the budget | 12/12 | Never improved |
| Hits along the cursor | 11/12 | Paging remains the only working path |
| Characters processed on first index build | 74,259,292 | Unique original text is about 2.68M; the gap is nested levels re-indexing the same originals |
| Candidate blocks left by one checksum query | 64/64 | That query cannot be narrowed at block granularity |

Three directions follow: index by **unique original event** to remove duplication; the index **only produces candidates** and every hit is verified with the existing literal-match semantics; the index **only accelerates** and changes no semantics.

## 1. In scope / out of scope

**In scope**: index data model, candidate generation, ownership and dedup, cursors, archive scope, budget and metering, acceptance criteria.

**Out of scope**: summary generation (native); window-swap timing and ARC strategy; any new service or package.

**Boundary fixed this round**: history reading **must not depend on ARC's proactive compaction policy**, and **must not take over Basic's compaction backend in order to read its history**. The independent capability stays in this repository, inside the same plugin package, split into clear modules.

## 2. Index unit and build mode

- The unit is **`(seq, textBlockPath)`**: `seq` is the original event sequence, `textBlockPath` is the path inside the part produced by `eventTextParts`.
- **`seq → blocks that can produce it` is a separate many-to-many association** derived from the ledger. Blocks determine hit ownership only; they are not index units.
- Build **on demand, in segments, progressing across calls**. A unique-event index does **not** mean the whole archive must be read first.
- An **incomplete index only means "unknown"** and is never grounds for excluding a source.
- "Independent of nesting depth" describes **only** the avoidance of re-indexing the same original text once per parent level. **Source-graph resolution** (`sources()` / `resolveIndexedSources`) and **ownership maintenance** (`owners`) must be **metered separately**; no promise is made that total cost is depth-independent.

## 3. Candidates and keys

- The index **only produces candidates**. A hit is always verified by the **existing literal-match semantics**: same `foldCase`, same chunked reading, same overlap handling (advance one scalar after a hit, so overlapping occurrences stay discoverable).
- A complete token index **must not miss legitimate substring queries**. Queries are not limited to whole tokens: entity IDs, file paths, error text, Chinese, and partial values are all in scope.
- **Queries that cannot be accelerated safely fall back to scanning**, and the response says so.
- **Stop-keys**: fragments that occur too often are not indexed and the query falls back to scanning. The threshold τ is fixed from **measured frequency distribution, candidate counts and memory cost**; 20% is an experimental starting point, not a contract constant.
- The earlier claim that a "common prefix makes whole-string 3-grams mathematically unable to exclude a block" is **deleted** — a common prefix is **not** a sufficient cause, and fragments inside the value can still exclude candidates. What was measured is that **some value fragments are themselves very common, compounded by block granularity being too coarse**.

## 4. Ownership and dedup (existing semantics preserved)

Existing implementation: `owners: Map<seq, blockIndex>`, held per session in a `WeakMap`, valid across calls and across cursor pages; per seq, `owner < b` skips, otherwise the source is claimed when `(owner === undefined && owners.size < 200_000) || (owner !== undefined && b < owner)`.

**Invariants**:

- **I1 (equivalence)**: under the **same session snapshot, the same query semantics and the same initial state**, **after complete pagination** the hit **positions and ownership are identical**, including at least `(seq, path, offset)`. Comparing `seq` sets alone is **not acceptable**. The index consuming budget means **per-page splits differ**, which is allowed; what is not allowed is a different final result.
- **I2 (accounting independence)**: the index decides only whether text is read. A block excluded during candidate generation still claims all of its `sources.seqs` and still counts toward `inspected`.
- **I3 (capacity behaviour)**: **tracked** sources keep their existing **lowest-block ownership**; sources **beyond capacity** (200,000) keep the rule **"may repeat, must never be omitted"**. I3 and I4 do not conflict — they govern the tracked and the beyond-capacity cases respectively.
- **I4 (lowest-block ownership)**: within the tracked range, a `seq` is reported only under the **lowest block** that can produce it, including across cursor pages and repeated queries.

## 5. Text semantics

- **I5 (one fold)**: the scan, the query and the index share one `foldCase`, and it must be **context-free** (per code point). Only a context-free fold commutes with concatenation, which is what makes "the grams of any chunk are a subset of the grams indexed for the part containing it" hold.
- **I6 (candidate superset)**: apart from explicitly declared stop-keys, index candidates must be a **superset** of the scan condition. A collision may cost an extra read and must never drop a hit. **Every final hit is settled by literal verification.**
- **I7 (preconditions for absent)**: `absent` is allowed only when **all** of the following hold:
  1. **zero hits**;
  2. the **query range is exhausted** (no pending cursor — this pass started at zero and reached the end);
  3. **no unresolved source gaps** (`sources.incomplete` false, no `missing`);
  4. **no budget truncation** (`scanBudgetReached` false);
  5. `inspected > 0`.

  **Unindexed content or stop-keys stop counting as coverage gaps once a complete scan has verified them**; anything unverified remains a gap.
  The conservative rule is **kept**: a continuation page (one carrying a cursor) **must not independently declare archive-wide absence**.

## 6. Scope and wording of absent (resolves the §8/§9 contradiction)

- The archive contains only **shadowed original events**; **the current window is outside the archive search scope**.
- So when the target exists only in the current window, after **completely searching the archive** it is **permitted** to return a scope-qualified conclusion:

  ```json
  { "absent": true, "scope": "archived_history" }
  ```

- It is **not permitted** to claim the whole session lacks the content, nor to imply that evidence in the current window should be abandoned.
- Acceptance checks that the **scope wording is correct**, and does **not** ban `absent` outright.
- p288 is exactly this case: target `seq 5478` (`tool/result`) is still in the current window and is not an archived source.

## 7. Budget and metering

- One `WORK_BUDGET` per call; **indexing and scanning are charged to the same budget**.
- **Affordability is decided before work starts** (measuring lengths is nearly free). Content that cannot be afforded is **never indexed at all**, rather than built and discarded — paying for a discarded build spent an entire page budget in measurement (a 1.1M-character block advanced the first page by 16384 characters).
- Besides indexed and scanned text, the following must also be bounded and metered: **source-graph traversal**, **candidate processing**, **temporary memory**, and **cancellation checks**.
- The following must be reported **separately**: **cold query** (index not ready), **hot query** (index ready), and **full pagination** (through to the end) — cost and hits for each.
- The response must distinguish **untested** from **does not exist**, and must report whether the index was used, how many characters were read, whether the budget truncated the pass, and whether a stop-key forced a fallback.

## 8. Cursor contract (describes the existing implementation truthfully)

Existing behaviour, **unchanged this round**:

- The cursor body is HMAC-signed and binds `session.id`, the hash of `scope = search:<query>:<limit>`, `anchor = session.seq`, and `fingerprint`.
- `fingerprint(events, anchor)` hashes only **the single event at the anchor** (`events[anchor-1]`).
- It becomes invalid when **the session has shrunk below the anchor** (`anchor > session.seq`) or when **the event at the anchor has been rewritten** (fingerprint mismatch).
- **Appending events after the anchor does not invalidate the cursor** — the bound prefix is still valid and continuation behaves as before. The contract **must not** be worded as "an append after the anchor invalidates it", and that behaviour **must not** be changed as a side effect.

**New decision (confirmed)**: the cursor is **not bound to the index cache generation**, provided the index only ever accelerates: it changes no query semantics, no traversal order, no source scope and no offset meaning. Regression coverage must be added for continuing an old cursor **while a build is in progress**, **after eviction**, and **after a rebuild**.

## 9. Cache contract

- This round uses an **in-process, session-isolated, on-demand incremental** cache; **no on-disk persistence**.
- **The original session events are the sole source of truth**; the cache may be discarded and rebuilt at any time.
- **Capacity limit**, **eviction policy**, **cancellation** (AbortSignal) and **disposal** must be specified and tested.
- **No hidden global session state** may be used.

## 10. Archive-scope invalidation

The index covers archived originals only. When a source is restored out of the archive (window rollback, window restore), its index entries must be invalidated or invalidated wholesale.

**Implementation finding (2026-09-16, with source evidence)**

*Correctness: a stale entry cannot enter the current ledger's candidate set, so the state is **unreachable** under the current model.* The evidence is `resolveIndexedSources` (`src/archive.ts:26`-`:63`): for any shadowed `seq` it pushes that block's children (or the `sourceEventSeqs` of a `surfaceOp.replace`) and recurses, writing to `out.seqs` only when it reaches a real leaf (`user/message`, `assistant/message`, `tool/result`). The ledger is rebuilt every call by `rebuildBlockLedger(session.snapshotEvents())` from **immutable compaction events**, and sessions are **append-only**, so a `seq` that ever entered a block's source set can always be expanded to through that block. An index entry therefore never loses its block.

*Precondition*: the argument above **holds only for the current append-only model**. If a host ever supported truncation, rewind or block removal, cases such as **seq reuse, changed content at the same seq, or ledger cache invalidation** could arise, and **none of them is covered here**. The earlier sentence claiming correctness would hold even then was an **inference and is withdrawn**: this round's source evidence does not support it, and it would need its own argument and verification.

*Memory: two independent constant bounds; previously there was one.* `INDEX_ENTRY_BUDGET` (4M gram entries) bounds **stored grams**; `INDEX_EVENT_LIMIT` (200,000) bounds **containers per session**. Release is by LRU eviction (64 sessions retained) or `disposeIndex(session)`.

*The earlier claim was wrong and is corrected.* Saying index size was bounded by `INDEX_ENTRY_BUDGET` did not hold: `grams.set(seq, grams)` ran **unconditionally**, while `entries += grams.size` added zero for an empty gram set - so **an event with empty text, fewer than three code points, or every gram dropped as a stop-key kept creating `Map<seq, Set>` containers while the entry budget never tripped**, leaving the container count bounded only by session length. Containers with no grams are now **not stored** (absence already means unknown, and an empty container could only prove the same thing), with `INDEX_EVENT_LIMIT` as an independent backstop. Regression M1 pins it: after ten gram-less events plus one real literal, the container count **equals only the events that produced grams**, and M1 fails when the skip is removed.

*Remaining gap*: entries **never shrink** within a session - there is no per-entry eviction, only whole-session release. That is a structural fact and was not measured.

*Verification status*: the conclusions above come from reading the source, **not from a test**. No public un-shadow or rollback API exists in `region.ts`, so the scenario is **neither constructed nor covered**.

## 11. Acceptance

**Query families** (replacing the current 12 "look up a known complete value" probes):

| Family | Intent | Expectation |
|---|---|---|
| Entity ID + field | known ID, unknown field value | hit on the first page |
| File path + error | known path, find error context | hit on the first page |
| Old vs new version | locate either side of a change | both locatable |
| Unknown value with only a prefix | first characters known | a miss is allowed, but paging must work |
| Present only in the current window | boundary | `absent` must be qualified with `scope: archived_history` |
| Chinese and multi-byte | boundary | hit with a correct offset |

**Comparison arms**: Basic + history retrieval versus the existing ARC strategy.

**Pass conditions**:
- present literals show **no regression** against the 0.3.1 scan path;
- `absent` appears only when all of I7 holds, and its **scope wording is correct**;
- cold, hot and full-pagination cost and hits are reported **separately**.

## 12. Implementation order (this round)

1. **Add the English contract first** (this file, paired with the `.zh-CN.md`).
2. **Differential and boundary tests**: Unicode, substring, stop-keys, partial index, oversized text, nested sources, cross-page, rebuild.
3. Verify against **sealed data** and a **short host flow**.
4. **Basic + history retrieval architecture comparison** and the **24-episode long run** — only after the above passes, and **not started this round**.

## 13. Rollback

The index sits behind a switch whose state appears in the response. Any violated invariant falls back to scanning. **A fallback must be observable; silent degradation is not allowed.**

**Implementation record (2026-09-16)**: metering is exposed through `ArchiveReader.indexState(session)`. It carries index size (`events`/`entries`/`common`/`chars`) and the **work of the most recent search**: `lastColdChars` (characters spent indexing), `lastIndexedEvents`/`lastExaminedEvents`, `lastBlocksVisited` (blocks walked, i.e. source-graph roots), `lastResolvedSources` (sources resolved, i.e. source-graph output), `lastCandidatesExamined`/`lastCandidatesSkipped` (candidate processing) and `lastCancellationChecks`.

Cold versus hot: `lastColdChars === 0` means the query was hot. Measured per probe on the sealed archive (see CHANGELOG 0.5.0).

**Temporary memory** is bounded by construction rather than by a peak-allocation counter: text is always handled in bounded chunks, and index size is constrained by `INDEX_ENTRY_BUDGET` together with the 64-session retention limit. Both are readable.

**One deviation from the contract**: metering and switch state are exposed through accessors and do **not** enter the response envelope. That envelope has a fixed 1220-byte minimum grant, and these readings would displace hits or `nextCursor`/`hint` - which is what the model uses to keep searching. The cost is that **the model itself cannot see these numbers**, only the caller can. The deviation is recorded in 0.5.0 and 0.6.0; **putting them in the envelope would require reworking response packing to free the bytes**.
