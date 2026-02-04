# Codex JSONL ステートマシン（決定論）

このドキュメントは、Codex の JSONL ログのみを使って **緑(working) / オレンジ(waiting) / 青(done-ish)** を決定するための仕様です。
新規セッションでもこの1枚を読めば実装と理由が分かることを目的にしています。

## 目的
- ステータス表示を **決定論 (0/1)** で安定させる
- **時間や出力可視など JSONL 外の情報は一切使わない**
- 間違いのコスト順位を以下に固定する
  1. **完了なのに緑のまま**（最悪）
  2. **緑なのに青のまま**
  3. **入力待ちなのに緑のまま**

## 制約（絶対）
- JSONL における **時間概念は禁止**（timestamp 比較・idle などは使わない）
- 出力可視判定・UI の idle 判定・タブ通知ロジックは使わない
- 加点/スコアリングは禁止（0/1 の判定のみ）

## 用語とステータス
- **working (緑)**: 何かやっていそう
- **waiting_user (オレンジ)**: ユーザ入力待ちが確定
- **completed (青)**: 仕事が終わったっぽい（最大精度推定）

> NOTE: `waiting_user` を青に使わない。意味が逆転して事故るため。

## JSONL から読み取る信号
**必須（判定に使う）**
- **user message**
  - `response_item` の `message` で `role: user`
  - `<environment_context>` / AGENTS / system などの **指示系入力は除外**
- **assistant message**
  - `response_item` の `message` で `role: assistant`
- **tool call 開始**
  - `response_item` の `function_call` / `custom_tool_call`
  - `response_item` の `local_shell_call` で `status: in_progress | incomplete`
- **tool call 完了**
  - `response_item` の `function_call_output` / `custom_tool_call_output`
  - `response_item` の `local_shell_call` で `status: completed`
- **request_user_input 未解決**
  - `function_call` の `name: request_user_input` が開始されたが
    対応する `function_call_output` がまだ無い
- **turn_aborted**
  - `event_msg` の `type: turn_aborted`

**参考（判定に使わない）**
- `token_count` は **完了の保証にならない**ので判定に使わない

> NOTE: `event_msg: request_user_input` は rollout には保存されないため使わない。

## 判定ルール（決定論）
以下は JSONL の **出現順序のみ**を使う。

### 1) 緑 (working)
- **最後の user message を見たら緑を開始**
- その後、以下のどちらかが true の間は緑を維持
  - assistant message がまだ無い
  - 未完了の tool call がある

### 2) オレンジ (waiting_user)
- **未解決の request_user_input がある場合のみオレンジ**
- ただし **緑を経由したセッションのみ**に適用

### 3) 青 (completed)
- **以下がすべて true のとき青**
  1. 最後の user message 以降に **assistant message がある**
  2. 未完了の tool call がゼロ
  3. 未解決 request_user_input がゼロ
- **turn_aborted は completed 扱い（青）**
  - 緑のまま残るのが最悪なので、確定停止は青に寄せる
> NOTE: tool output だけでは青にしない（assistant 返答必須）。

## 遷移ルール（重要）
- 許可する遷移: **緑 → オレンジ / 青** のみ
- **青 → 緑** は「新しい user message」または「新規 tool call 開始」のときのみ
- オレンジ → 緑 は「request_user_input が解決して、次の user message が来たとき」

## 実装ポイント（どこでやるか）
- `src/main/history/domain/sources/codex-jsonl-source.js`
  - `inferCodexStatusHint(entries)` をこのロジックで実装
  - **timestamp 参照は禁止**（順序のみ）
- `src/main/status/sources/codex-jsonl-source.js`
  - `inferStatusFromSummary` は `status_hint` だけ採用
- `src/main/status/status-service.js`
  - `normalizeStatus` に `completed` を追加
- `src/renderer/styles.css`
  - `.status-completed` を青に割当
  - `.status-waiting_user` はオレンジ
- `src/renderer/history-manager.js`
  - 出力 idle 由来の推定は禁止
  - `status` 表示は `working / waiting_user / completed` のみ

## 例（簡易）
- user → assistant → (tool完了) → 青
- user → tool output のみ → 緑
- user → request_user_input (未解決) → オレンジ
- user → (tool pending) → 緑
- user → (turn_aborted) → 青
