# History Sync Architecture (Target Design)

## Purpose
Define how **History** is kept fresh via **periodic index scans + deltas**
without breaking UI or Status.
In V1, **removals are not propagated** (history is treated as append‑only).

This document focuses on:
- Data polling / diff
- Snapshot + delta IPC
- UI reflection timing (buffered apply)

---

## Core Principles
- History is **immutable per record**, but the **dataset** can update.
- Updates are **delta‑based**, not full reloads.
- UI is the **gatekeeper** for when to apply deltas.
- **Removals are ignored** in V1 (no delete propagation).

---

## Components

### Main Process
```
HistorySyncService
├─ HistoryRepository (connectors)
└─ Source adapters (claude/codex)
```

### Renderer
```
HistoryClient (receives + queues)
HistoryManager (renders)
```

---

## HistorySyncService

### Responsibilities
- Periodically scan **session indexes**
- Compute **added / updated** deltas (removals ignored in V1)
- Build **SessionSummary** from source adapters
- Send snapshot on first load
- Send delta updates thereafter
- **Meta is derived from index entries** (single scan; no extra getMeta pass)

### Snapshot Priming + Streaming
- **Snapshot** returns the newest N summaries quickly.
- After snapshot, the service **continues scanning** and emits **delta per summary**.
- This yields **progressive UI updates** without blocking initial render.
- V1 primes at **1 item max**, even if UI requests more; the rest arrives via deltas.
- Bootstrap deltas are batched in **groups of 5** (flush immediately when remaining < 5).
- Bootstrap deltas are applied immediately by the renderer (no frame‑gating).
- Deltas are **suppressed until the first snapshot** (activation handshake) to avoid missing early events.

### Change Detection Strategy (Index‑based, V1)
Each source exposes a **session index** (latest file per session).
The sync loop is:

1. `listSessionIndexEntries()` per source.
2. Compare the entry’s file mtime with the cached session state.
3. For **new / updated** entries, build a **SessionSummary** and **emit delta immediately**.

Notes:
- We rely on **source adapters** to normalize file paths, WSL roots, and parsing.
- We do **not** use filesystem watchers in V1.
- Summary building is **parallelized** using adapter concurrency hints.
- Index scans run **in parallel per source**, and JSONL file stats are **concurrently fetched**.

### Scheduling
- Adjustable interval (per source or global)
- Manual refresh trigger (debug / user action)

**V1 fixed parameters**
- Index scan interval: **3 seconds**
- File I/O is performed **only for new/updated entries**
- Manual refresh forces a scan immediately

---

## Data Shapes

### Snapshot
```
{
  version: 1,
  generated_at,
  source,
  sessions: SessionSummary[],
  meta: { source, signature, file_count, latest_mtime, latest_size }
}
```

### Delta (V1)
```
{
  version: 1,
  generated_at,
  source,
  added: SessionSummary[],
  updated: SessionSummary[],
  meta: { source, signature, file_count, latest_mtime, latest_size }
}
```
※ V1では **removed を送らない**（append-only想定）

---

## Diff Engine

### Diff rules
- Identify by stable ID:
  - SessionKey = `source + ':' + session_id`
- Only update if **content hash changes** or timestamps advance
- Hash excludes volatile/UI‑only fields (e.g., display_time, status overlays)
- Preserve order semantics (most recent first)

### Invariants
- No duplicate IDs
- No order regressions
- Deltas never mutate unrelated entries

---

## IPC Contract

### Main → Renderer
- `history:snapshot` (fast‑path: newest N sessions)
- `history:delta` (incremental update; can arrive after snapshot)
- `history:invalidate` (force re‑sync; payload includes reason)

### Renderer → Main
- `history:ack` (optional: applied / pending)

#### Event payloads (V1)
```
history:invalidate = { version: 1, source, reason, timestamp }
history:ack        = { version: 1, source, applied: boolean, pending: number, timestamp }
```

**実装メモ**  
- `history:ack` は現在、Main側で最終ACK時刻を記録するのみ（同期挙動には影響しない）。  
- `history:invalidate` が送信された場合、該当ソースのキャッシュ/状態はリセットされる。  

---

## UI Reflection Control

### Buffered apply
Renderer buffers deltas when:
- User is scrolling
- User is reading details
- UI is in “busy mode” (search, time machine, etc.)

### Apply policy
- Apply immediately when idle
- Bootstrap delta は **即時適用**（フレーム単位の間引きなし）
- Apply on explicit user action
- Merge queued deltas before render

### UI feedback
- “New updates” badge if deltas are pending

---

## Failure Behavior
- If polling fails, **keep last good data**
- Errors never mutate UI state directly

---

## Testing Strategy
- Diff correctness (add/update)
- Stable ID behavior across sources
- Renderer buffer/flush behavior
- Snapshot → delta transitions

---

## Related Docs
- `docs/archive/2026-01-31/design/runtime-architecture.md`
- `docs/archive/2026-01-31/design/status-architecture.md`
