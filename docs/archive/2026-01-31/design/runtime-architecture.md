# Runtime Architecture (History + Status)

## Purpose
Define the **end‑state runtime design** that combines:
- **History** (periodically updated data)
- **Status** (event‑driven runtime state)
- **UI reflection control** (user‑driven timing)

This document is the **overview**. Domain‑specific details live in:
- `docs/archive/2026-01-31/design/status-architecture.md`
- `docs/archive/2026-01-31/design/history-sync-architecture.md`

---

## Core Principles
- **History and Status are separate domains.**
- **Main process is the source of truth** for both domains.
- **Renderer is a thin client** that controls *when* to apply changes, not *what* the changes are.
- **UI overlays Status onto History** using `source + session_id`.

## V1 Contract Freeze
- IPC payloads are **versioned** (v1).
- Join key is **only** `source + session_id`.
- Renderer never computes status or history diffs.
- UI controls apply timing via **buffer + flush** policy.
- Status is **in‑memory only** (no persistence in V1).
- History deltas are **suppressed until the first snapshot** (active handshake).
- Removals are **not propagated** in V1.

---

## Components (Target)

### Main process
```
RuntimeCoordinator
├─ HistorySyncService      (index scan / diff / emit)
├─ StatusService           (observe / normalize / in‑memory)
├─ HistoryIPC              (snapshot + delta)
└─ StatusIPC               (snapshot + update)
```

### Renderer
```
HistoryClient   (receives history snapshot/delta; queues updates)
StatusClient    (receives status snapshot/updates)
HistoryManager  (renders history; reads StatusClient for overlay)
```

## Renderer Decomposition (Target)
`renderer.js` is treated as an entrypoint only. Implementation is split by responsibility.

Proposed modules:
- `src/renderer/runtime/history-client.js`
- `src/renderer/runtime/status-client.js`
- `src/renderer/history/history-manager.js`
- `src/renderer/terminal/tab-manager.js`
- `src/renderer/ui/settings-ui.js`
- `src/renderer/ui/session-panel.js`
- `src/renderer/app/init.js`

## Removal Checklist (Must)
These items **must be removed** from the old paths to avoid duplicate logic.

### Renderer (old)
- `src/renderer/history-manager.js`
  - Session status map / pane binding logic
  - Codex command parsing / launch inference
  - `applyNotifyEvent` and notify‑driven state updates
- `src/renderer/renderer.js`
  - Direct `notifyAPI` → HistoryManager wiring
  - Any status inference outside `StatusClient`
  - Any history polling once `HistoryClient` is wired

### Main (old)
- `src/main/notify-service.js` direct renderer coupling
  - Replace with `ClaudeHooksSource` → `StatusService` → `StatusIPC`

## IPC Robustness (V1)
### Ordering / Idempotency
- IPC events may arrive **out of order**; services must use timestamps for last‑write‑wins.
- Duplicate events must be safe to apply (idempotent updates).

## Class Diagram (Target)
```
Main Process
RuntimeCoordinator
├─ HistorySyncService
│  ├─ HistoryRepository (connectors)
│  │  ├─ ClaudeJsonlSource
│  │  └─ CodexJsonlSource
├─ StatusService
│  ├─ StatusSourceRegistry
│  │  ├─ ClaudeHooksSource
│  │  ├─ CodexJsonlStatusSource
│  │  ├─ CodexCommandSource
│  │  └─ PaneLifecycleSource
│  └─ (in‑memory only, V1)
├─ HistoryIPC
└─ StatusIPC

Renderer
HistoryClient  → HistoryManager
StatusClient   → HistoryManager (overlay)
```

## Responsibilities (Summary)
### Main
- **HistorySyncService**: 3s index scan, delta computation, IPC emission.
- **HistoryRepository**: connector registry; source‑specific index + summary building.
- **StatusService**: per session latest observation state.
- **StatusSourceRegistry**: source‑specific status ingestion.
- **StatusIPC / HistoryIPC**: snapshot + update distribution.

### Renderer
- **HistoryClient**: queues deltas, applies on UI policy.
- **StatusClient**: caches current status updates.
- **HistoryManager**: renders history; overlays status only.

---

## Data Flow Overview

### History path
1. **Sources** produce raw history data (JSONL, etc).
2. **HistorySyncService** primes a **snapshot** (newest N), then streams **delta** (no delta before snapshot).
3. **HistoryIPC** sends `history:snapshot` on load and `history:delta` thereafter.
4. **HistoryClient** queues deltas and applies them when UI allows.
5. **HistoryManager** renders cards (immutable history data).

### Status path
1. **StatusSources** emit observations (hooks, JSONL inference, CLI commands).
2. **StatusService** normalizes + applies source rules.
3. **StatusIPC** broadcasts updates.
4. **StatusClient** caches current status per session.
5. **HistoryManager** overlays status on cards by key: `source:session_id`.

---

## UI Reflection Control
The renderer decides *when* to apply updates.
Typical policies:
- **User interacting/scrolling** → buffer deltas
- **Idle or explicit refresh** → apply buffered deltas
- **Change badge** → allow user to apply when ready

This guarantees:
- No UI thrash while the user is reading/scrolling
- History can update frequently without forcing reflow

---

## Consistency Rules
- History and Status are **independently correct**.
- Join logic is **deterministic** (`source + session_id`).
- History cards never mutate themselves based on Status.
- Status is a **read‑only overlay** in the UI.

---

## Failure Behavior
- History updates can fail without affecting status
- Status updates can fail without affecting history
- Renderer can continue working with stale data until new snapshot arrives

---

## Tests (Top Level)
- HistorySyncService delta correctness
- StatusService ordering rules
- IPC snapshot/update sanity
- UI overlay join correctness

---

## Related Docs
- `docs/archive/2026-01-31/design/status-architecture.md`
- `docs/archive/2026-01-31/design/history-sync-architecture.md`
