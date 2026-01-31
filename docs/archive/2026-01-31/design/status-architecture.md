# Session Status Architecture (Target Design)

## Purpose
Define a robust, long‑term architecture for **runtime status** (working / waiting_user / completed / stopped)
that is **separate from History** and can be safely overlaid on History cards in the UI.
This design prioritizes:
- Single source of truth
- Clear ownership boundaries
- Multi‑window consistency
- Extensibility for new models/sources
- Renderer slimming

Related docs:
- `docs/archive/2026-01-31/design/runtime-architecture.md`
- `docs/archive/2026-01-31/design/history-sync-architecture.md`

## Scope
### In scope
- Status collection, normalization, and aggregation
- Source‑specific ingestion (Claude hooks, Codex JSONL, CLI commands)
- Status → UI overlay on History cards
- Multi‑window propagation via IPC

### Out of scope
- History parsing / storage
- TimeMachine / history search logic
- UI visual design details

---

## Core Concepts

### 1) History vs Status (Strict Separation)
- **History** = immutable past data (sessions/blocks).
- **Status** = mutable, runtime state (working/waiting/etc).
- **UI joins them** at render time using the key: `source + session_id`.

> This allows history to stay stable, while status can be updated or dropped without rewriting history.

### 2) Identity Model
- **SessionKey** = `${source}:${session_id}`
- **PaneKey** = `pane_id`
- **Binding** = mapping between SessionKey and PaneKey

Status and binding are related but **stored separately**.

### 3) Status States
Canonical states:
- `working`
- `waiting_user`
- `completed`
- `stopped`

Normalize incoming variants:
- `running` → `working`
- `completed|done` → `completed`
- `waiting` → `waiting_user`
- `permission|permission_prompt|needs_permission` → `waiting_user`

### 4) Resolution Policy (V1)
There is **no global priority system**. Each source is treated independently.

- Status is keyed by `source + session_id`.
- For the **same key**, the **latest observation wins**.
- If `timestamp` is missing, StatusService assigns `updated_at = now`.
- `stopped` is **not terminal**; a later `working` reactivates the session.

---

## Target Component Architecture

### Main Process (Single Source of Truth)
```
StatusService (core)
├─ StatusSourceRegistry
│  ├─ ClaudeHooksSource
│  ├─ CodexJsonlStatusSource
│  ├─ CodexCommandSource
│  └─ PaneLifecycleSource
└─ StatusIPC (subscribe / snapshot / update)
```

### Renderer (Thin Client)
```
StatusClient
├─ onStatusUpdate (IPC)
└─ getStatus(sessionId, source)

HistoryManager
└─ renderHistoryCard → StatusClient overlay
```

> Renderer never computes status; it only renders it.

---

## StatusSource Contract (v1)
```js
// StatusSource Contract
// Each source is isolated and emits Observation objects.

Observation = {
  source: string,               // 'claude' | 'codex' | ...
  session_id: string,           // required
  status: 'working'|'waiting_user'|'completed'|'stopped',
  pane_id?: string,
  hook?: string,
  timestamp?: number | string   // unix ms or ISO
}
```

### Required behaviors
- **Never throw** for routine failures
- **Return structured results** or emit nothing
- **Do not mutate History**
- If `timestamp` is missing, StatusService sets `updated_at = now`

---

## StatusService (Aggregation Rules)

### Data held by StatusService
- `statusBySession: Map<SessionKey, StatusEntry>`
- `sessionToPane: Map<SessionKey, PaneId>`
- `paneToSession: Map<PaneId, SessionKey>` (1:1)

### StatusEntry fields
```
{
  session_key,
  status,
  source,
  session_id,
  pane_id?,
  updated_at,
  flags: { output_idle? }
}
```

### Update rule
1. Ignore if `Observation` is missing `source` or `session_id` or `status`.
2. Normalize status string.
3. Update if `timestamp` is newer than the current entry.

### Staleness (V1)
- No TTL is applied in V1.
- Status is cleared only by explicit events (e.g., `SessionEnd` / pane close) or manual reset.

---

## Status Sources

### 1) ClaudeHooksSource
**Input:** hook events from `NotifyService` JSONL
**Output:** direct `Observation`
- `SessionStart` → `completed`
- `UserPromptSubmit` → `working`
- `PermissionRequest` → `waiting_user`
- `Notification(permission_prompt|elicitation_dialog)` → `waiting_user`
- `Stop` → `completed`
- `SessionEnd` → `stopped`

Priority: highest

### 2) CodexJsonlStatusSource
**Input:** session summaries from HistoryService / Repository
**Inference:**
- `user seen && (no assistant after user || pending tools)` → `working`
- `assistant after user && !pending tools` → `completed`
- `pending request_user_input` → `waiting_user`

Priority: medium

Notes:
- Uses **existing JSONL discovery rules** (no fixed paths)
- Should ignore if `session_id` is missing

### 3) CodexCommandSource
**Input:** renderer → main IPC on command submission
**Purpose:** session/pane binding hints
- `codex resume <session_id>` → bind immediately
- `codex fork` → create pending launch
- `codex` (no subcommand) → pending launch

Priority: low (binding only, not status)

### 4) PaneLifecycleSource
**Input:** main PTY output + pane close events
**Purpose:** mark stalled / stopped safely
- output idle → `working` becomes `stalled` (UI flag)
- pane close → `stopped` + unbind

Priority: low

---

## Binding Resolution

### Binding strategy
- `resume <session_id>` binds immediately
- `fork` / `codex` creates **pending launch**
- When JSONL summary appears, match closest pending launch by timestamp
- Pending launch expires after **2 minutes**

### Binding rule (safe)
- Do not unbind on inactivity alone
- Unbind on `SessionEnd` (Claude) or pane close

---

## IPC Surface (Main ↔ Renderer)

### Renderer → Main
- `status:command` `{ pane_id, command, tab_id, timestamp }`
- `status:pane` `{ pane_id, event: 'open' | 'close' | 'focus' | 'blur', tab_id, timestamp }`
- `status:output` (optional, if main cannot observe PTY output)
  `{ pane_id, idle, timestamp }`

**実装メモ**  
- Rendererが出力アイドル判定を行い、`status:output` で Main に通知する。  

### Main → Renderer
- `status:snapshot`
  ```
  {
    version: 1,
    generated_at,
    entries: StatusEntry[]
  }
  ```
- `status:update`
  ```
  {
    version: 1,
    entries: StatusEntry[],
    removed: SessionKey[]
  }
  ```

### Security / Trust
- Validate that sender owns `tab_id` / `pane_id`
- Ignore untrusted IPC senders

---

## UI Overlay Rules

### Rendering
- For each History card:
  - Key = `${source}:${session_id}`
  - Lookup StatusEntry in StatusClient
  - Render status badge only if:
    - `entry` exists

### Stalled indicator
- If `status === working` AND `output_idle === true` → show stalled style  
  ※ 現行UIはCodexのみ `waiting_user` 表示に寄せる（互換目的）

### Do not mutate history
- Status is **never written into history blocks**

---

## Persistence (V1)
- **No persistence** in V1.
- Status is in‑memory only and resets on app restart.

---

## Multi‑Window Consistency
- StatusService is global and authoritative
- Each window receives `status:snapshot` on load
- Updates are broadcast to all windows
- Renderer only caches and displays; no local authority

---

## Extensions for New Models
To add a new model:
1. Implement `HistorySource` (for history)
2. Implement `StatusSource` (if runtime status is needed)
3. Register both in their registries

Result: **UI integration requires no new logic** as long as `source + session_id` is valid.

---

## Invariants (must always hold)
- History never depends on Status
- Status never mutates History data
- `source + session_id` is the only join key
- Renderer is not a source of truth

---

## File Structure Proposal
```
src/main/status/
  status-service.js
  status-store.js
  status-ipc.js
  sources/
    claude-hooks-source.js
    codex-jsonl-source.js
    codex-command-source.js
    pane-lifecycle-source.js

src/renderer/status-client.js
```

---

## Testing Strategy (Required for Stability)
- **Contract tests** for StatusSource
- **Aggregation tests** for ordering
- **Binding tests** (resume/fork/pending)
- **IPC tests** (multi-window snapshot + updates)

---

## Key Design Decisions (Summary)
- Status is **main‑owned** for consistency
- Status sources are **pluggable** like History sources
- Renderer only **subscribes and renders**
- Join happens in UI via `source + session_id`
