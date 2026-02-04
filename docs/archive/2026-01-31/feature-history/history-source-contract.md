# HistorySource Contract (v1)

This document defines the expected interface and return shapes for HistorySource implementations.

## Required properties
- `id` (string): Source identifier (e.g., `claude`, `codex`).
- `capabilities` (object): Feature flags. Typical keys:
  - `meta` (boolean)
  - `watch` (boolean)
  - `timeMachine` (boolean)

## Required methods
All methods must **return structured results** and must not throw on routine failures.

### `getMeta()`
Returns:
- `{ source, signature, file_count, latest_mtime, latest_size }`

### `listSessions({ limit, cursor, chunk_size })`
Returns:
- `{ sessions: SessionSummary[], maybe_more: boolean, next_cursor?: number|null }`

### `loadSession({ sessionId, source_path, project_path, project_dir, load_all, limit })`
Returns:
- `{ blocks: Block[], maybe_more?: boolean, error?: string }`

### `createTimeMachine({ block })`
Returns:
- `{ success: boolean, error?: string, ... }`

## Search contract (keyword)
If a source supports keyword search, it should implement the following:

### `keywordSearch({ query, terms, limit, cursor, chunk_size, project_path, project_dir, project_scope })`
Returns:
- `{ mode: 'keyword', query, summary, candidates, next_cursor?: number|null }`

### `listSearchEntries({ cursor, chunk_size, project_path, project_dir, project_scope })`
Returns:
- `{ entries: SearchEntry[], error?: string }`

### `scanSearchEntry(entry, { terms, hits, seen, maxHits })`
Side-effect:
- Appends hits to `hits` and updates `seen`.

## Common types
### SessionSummary
Minimal expected fields (others are allowed):
- `source`
- `session_id`
- `session_label`
- `input`
- `created_at`
- `last_output_at`

### Block
Minimal expected fields (others are allowed):
- `id`
- `source`
- `session_id`
- `input`
- `output_text`
- `created_at`
- `last_output_at`
- `has_output`

## Error handling
- Return `{ error: '...' }` or `{ success: false, error: '...' }` instead of throwing.
- Empty data should return empty arrays (not `null` or `undefined`).
