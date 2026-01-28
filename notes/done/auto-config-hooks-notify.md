# 将来実装案: Claude hooks / Codex JSONL 監視

## 目的
- ユーザーが手作業で hooks 設定を編集しなくても、
  Kawaii Terminal から **安定して「完了通知 + session_id」** を受け取れるようにする。
- Claude は **working / waiting_user / completed / stopped** を安全に検知して履歴カードへ反映する。
- Codex は **working / waiting_user** を対象にする（stopped は OSC で判定）。
- 「安定優先・クロスプラットフォーム (macOS / Windows / WSL / Linux)」を前提に、
  既存のユーザー設定を **壊さない・上書きしない** 方針で安全に実現する。

## 前提
- **Claude** は hooks によって `session_id` を含むイベントを受け取れる。
- **Codex** は新規セッション起動時に rollout JSONL を即作成し、以後追記される。
- Claude の状態検知は **hooks を基準**に行う（コマンド検知は不要）。
- Claude JSONL は **履歴/検索用のみ** とし、状態判定には使わない。
- Codex は JSONL とタブイベントで **working / waiting_user** を扱う。

## 対象ファイル (探索候補)
### Claude
- **`~/.claude/settings.json` を対象**にする（Claude Code が読む公式の場所）
- `settings.local.json` は **対象外**（Claude Code が読み込まないため）
- 反映には **`/hooks` でレビュー**が必要（起動時スナップショット）

### Codex
- JSONL 探索は **既存の履歴ソース実装の探索仕様に準拠**し、固定パスにしない
  - 既存実装: `src/main/history/domain/sources/codex-jsonl-source.js`

### WSL
- WSL 内も **`~/.claude/settings.json` を対象**
- Codex の JSONL も **既存探索仕様**で WSL まで含める
- UNC (`\\wsl$\\Distro\\home\\user\\...`) を経由して読書き
- Windows 側 path で通知先を渡し、WSLENV `/p` で正規変換

## 基本方針 (安全設計)
1. **明示的にユーザーが有効化したときだけ** 書き換え実行
2. 書き換え前に **バックアップ** を作る（初回のみ）
3. 既存設定は **必ずマージ**（上書きや削除はしない）
4. 失敗時は **何も変更しない**
5. 書き換えは idempotent（何度実行しても同じ結果）

## 追加する設定 (概念)
### Claude hooks (例)
- 目的: SessionStart / UserPromptSubmit / PermissionRequest / Notification / Stop / SessionEnd で `session_id` と状態を取得
- Hook で `KAWAII_PANE_ID` を読んで pane へ紐づける
- **公式の hook lifecycle**: `SessionStart`=セッション開始/再開、`Notification`=通知送出、`Stop`=応答完了
- `Notification` は **permission_prompt / elicitation_dialog のみ状態判定に使う**
  - `idle_prompt` は **状態を変えない**（既に `Stop` で waiting_user が確定できるため）
  - ただし **状態は `PermissionRequest` / `Stop` を優先**して決める
- **公式仕様**: `hooks.<Event>` は **ルール配列**で、各要素は `{ matcher?, hooks:[...] }`
  - `matcher` は **PreToolUse / PermissionRequest / PostToolUse** のみ対象
  - 文字列パターンで **ツール名にマッチ**（大小区別）。`*` / 空文字 / 省略で「すべて一致」
  - 正規表現パターンも可（例: `Edit|Write`）
  - `hooks` は **実行する処理の配列**（`type: "command" | "prompt"`。`timeout` は秒で任意）
- 本設計では **`settings.json` のみ**に追記する（他の設定ファイルは触らない）
- 実際の command は **同梱の hook runner を直接実行**
  - Windows: PowerShell スクリプト（`kawaii-notify.ps1`）
  - macOS/Linux/WSL: POSIX shell スクリプト（`kawaii-notify.sh`）

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "<HOOK_SCRIPT_PATH>" }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "<HOOK_SCRIPT_PATH>" }] }
    ],
    "PermissionRequest": [
      { "hooks": [{ "type": "command", "command": "<HOOK_SCRIPT_PATH>" }] }
    ],
    "Notification": [
      { "hooks": [{ "type": "command", "command": "<HOOK_SCRIPT_PATH>" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "<HOOK_SCRIPT_PATH>" }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "<HOOK_SCRIPT_PATH>" }] }
    ]
  }
}
```

### Codex (通知設定は変更しない)
- **Codex の notify は一切追記しない**
- 代わりに **rollout JSONL の作成/更新監視** で状態を反映する
- 「ユーザーの既存 notify を壊さない」「通知設定の追加で挙動が変わるのを避ける」ため

## 受け渡し環境変数
- `KAWAII_PANE_ID` : pane を識別
- `KAWAII_NOTIFY_PATH` : 追記ファイル先
- `KAWAII_TERMINAL_INSTANCE_ID` : インスタンス識別（多重起動防止）
- `KAWAII_NOTIFY_DEBUG_PATH` : hooks の raw を出すデバッグ用（任意）

### WSL 変換例
```
WSLENV=KAWAII_PANE_ID/u:KAWAII_NOTIFY_PATH/p:KAWAII_NOTIFY_DEBUG_PATH/p
```
- `KAWAII_PANE_ID` は文字列だけ渡せればよいので `/u`
- `KAWAII_NOTIFY_PATH` は Windows -> WSL のパス変換が必要なので `/p`
- `KAWAII_NOTIFY_DEBUG_PATH` も `/p`

## 具体的な書き換え手順 (擬似フロー)
1. **設定ファイル探索**
   - Claude: `settings.json` が無ければ作成対象として採用
   - Codex: `config.toml` は触らない（通知設定を変更しない）

2. **読み取り + パース**
   - Claude: JSON パースエラーが出たら即中断
   - Codex: JSONL 監視はファイル読み取りのみ

3. **安全マージ**
   - Claude: hooks が無ければ作成。既存の **ルール配列** に自分の command を追加。
   - Codex: 追加書き換えは行わない

4. **バックアップ**
   - `<file>.bak` を初回のみ作成

5. **原子的に書き込み**
   - tmp ファイルに書き込み → rename

6. **検証**
   - 再読み込みして正しく反映されているか確認

## Claude JSON マージ詳細
- 既存 `hooks` があればそのまま保持
- `hooks.SessionStart` / `hooks.UserPromptSubmit` / `hooks.PermissionRequest` / `hooks.Notification` / `hooks.Stop` / `hooks.SessionEnd`
  - 配列でなければ配列化
  - 既に同じ script があれば追加しない

## Codex JSONL 監視仕様 (安全ライン)
- **監視対象**: 既存の JSONL 探索仕様に準拠（固定パスにしない）
- **検知**:
  - JSONL 生成後、**入力を含む最新のセッション要約ブロック**を対象に紐づけ
  - **user message 後に assistant message が無い / 未完了 tool call がある** → working
  - **request_user_input が未解決** → waiting_user
  - **assistant message があり、未完了 tool call が無い** → completed
  - tool output のみでは completed にしない
  - `codex resume` は **新規 JSONL を作らない場合がある**ため、`session_id` が見える場合のみ即紐づけ
- **禁止事項**:
  - JSONL の更新間隔や「一定時間更新が無い」ことを根拠に状態判定しない
  - タイムアウトや更新停止を理由に紐づけ解除しない
- **許容事項**:
  - 同一 session を複数クライアントで操作し、JSONL が混在しても許容する
- **起動コマンド判定 (ホワイトリスト + ブラックリスト)**
  - **用途は「タブへの暫定紐づけ」のみ**（状態の根拠にしない）
  - **判定手順**
    1) 先頭トークンが `codex` / `codex.exe` / パス末尾が `codex(.exe)` のときのみ対象  
    2) `-h/--help/-V/--version` を含む場合は **非TUI** とみなす
    3) `subcommand` は「先頭の非フラグトークン」（`resume` / `fork` など）として解釈
    4) グローバルフラグは前後どちらにも現れるため、**先頭の非フラグ**をサブコマンドとする
    5) `subcommand` が空 → **TUI 起動候補**
    6) `subcommand` が `resume` / `fork` → **TUI 起動候補**
    7) それ以外は **非TUI**（ブラックリストに該当 / 未知コマンドは TUI とみなさない）
  - **ホワイトリスト (TUI 起動の可能性あり)**
    - `codex`（サブコマンド無し）
    - `codex resume ...`
    - `codex fork ...`
  - **ブラックリスト (TUI 起動しない / 即終了)**
    - `-h`, `--help`
    - `-V`, `--version`
    - `completion`
    - `exec` (alias: `e`)
    - `review`
    - `login` (`status`)
    - `logout`
    - `apply` (alias: `a`)
    - `mcp`, `mcp-server`
    - `app-server` (`generate-ts`, `generate-json-schema`)
    - `sandbox` (alias: `debug`)
    - `execpolicy` (`check`)
    - `cloud` (alias: `cloud-tasks`)
    - `features` (`list`)
    - `responses-api-proxy` (internal)
    - `stdio-to-uds` (internal)
  - **補足**
    - `fork` は **新しいセッションが作られる**ため、与えられた session_id には紐づけない
    - `resume` は **同一セッションを再開**するため、session_id が見える場合のみ紐づける
    - `exec` 系は `codex exec resume ...` を含め **非TUI**（タブ紐づけしない）
- **紐づけルール (ギリギリ安全)**:
  - `codex resume <session_id>` は **その session_id に即紐づけ**
  - `codex fork <session_id>` は **新セッション扱い**（次の JSONL に紐づけ）
  - `codex` 単体起動は **そのタブで次に検出された JSONL を紐づけ**
    - **タイムアウトで破棄しない**（pane 終了か次の起動で上書き）
  - TUI 内 `/resume` は検知できないため **紐づけの変更は行わない**

### Codex CLI サブコマンド一覧（codex 実装準拠）
- codex (subcommand 無し = TUI)
- resume (TUI)
- fork (TUI / 新セッション)
- exec (alias: `e`)
- review
- login (sub: `status`)
- logout
- mcp
- mcp-server
- app-server (sub: `generate-ts`, `generate-json-schema`)
- completion
- sandbox (alias: `debug`; sub: `seatbelt` / `landlock` / `windows`)
- execpolicy (sub: `check`)
- apply (alias: `a`)
- cloud (alias: `cloud-tasks`)
- features (sub: `list`)
- responses-api-proxy (internal)
- stdio-to-uds (internal)

## 状態の定義と検知
### UI 表示仕様（履歴セッションカード）
- **テキスト表示はしない**（ドット/マークのみ）
- **基本ドット**:
  - **working**: 緑色の点滅ドット
  - **waiting_user**: オレンジ色の点灯ドット
  - **completed**: 青色の点灯ドット
  - **stopped / 状態未確定 / 未紐づけ**: ドット非表示
  - **ドット表示は紐づいた pane がある場合のみ**
- **停止マーク（補助）**:
  - **緑ドットに停止マーク**を重ねる
    - working なのに **画面更新が停止**したとき（出力停止ヒューリスティック）
    - **ユーザー入力が必要**な状態が確定したとき（waiting_user など）
  - 状態そのものは **hooks/JSONL を正とし、停止マークは補助情報のみ**

### Claude（hooks 基準）
- **completed**: `SessionStart` / `Stop` 受信時（起動直後 or 応答完了後の待機状態）
- **working**: `UserPromptSubmit` 受信時（ユーザー入力が送られた）
- **waiting_user**: `PermissionRequest` 受信時
- **Notification**: `permission_prompt` / `elicitation_dialog` のみ状態更新
  - `permission_prompt` → **waiting_user**
  - `elicitation_dialog` → **waiting_user**
  - `idle_prompt` は **no-op**
- **stopped**: `SessionEnd` 受信時
- **補足**:
  - `Stop` は **ユーザー中断時に発火しない**。中断後に `SessionEnd` が来た場合は stopped で扱う。
  - **プロンプト復帰の CWD OSC** を検知した場合も stopped 扱いで **紐づけ解除**（強制終了対策）

### Codex（JSONL 基準 + OSC）
- **working**: JSONL の **user message 後に assistant message が無い**、または **未完了 tool call がある**
  - **コマンド入力検知は紐づけ用のみ**で、状態の根拠にしない
- **completed**: JSONL の **assistant message があり、未完了 tool call が無い**
- **補足**: tool output だけでは completed にしない
- **waiting_user**: `request_user_input` が **未解決のとき**
- **stopped**: **プロンプト復帰の CWD OSC が出た時点**を終了として扱う
  - zsh/bash: `PROMPT_COMMAND` / `precmd` で CWD を OSC 送信済み
  - PowerShell: `prompt` 関数で CWD を OSC 送信済み
- **検知できない状態**:
  - **許可待ち**（ExecApproval/Elicitation）は JSONL に残らないため判定不可
    - rollout の永続化対象から除外されている（`codex-rs/core/src/rollout/policy.rs`）
  - **途中進行**（ストリーミング中の中間状態）は JSONL からは確定不可
- **タブ終了/PTY終了**: そのタブに紐づく working は **stopped 扱い**

## 状態遷移 (概要)
- Claude: SessionStart → completed / UserPromptSubmit → working / Stop → completed / PermissionRequest → waiting_user / SessionEnd → stopped
- Codex: SessionMeta → (表示なし) / input → working / assistant → completed / OSC復帰 → stopped

## 安定性の定義 (アプリ内での 99% を目標)
- Claude: **UserPromptSubmit/Stop/SessionEnd** で状態更新
- Claude: **Notification/PermissionRequest** で waiting_user を更新
- Codex: **JSONL の user/assistant メッセージ + tool 未完了判定**で working/completed を更新
- Codex: **stopped は OSC で更新**（JSONL の更新停止は根拠にしない）

## 通知フォーマット（アプリ内取り込み用）
- Hook スクリプトは **1行1JSON (JSONL)** で追記する。
- 最低限のフィールド:
  - `source`: `claude` | `codex`
  - `event`: `working` | `waiting_user` | `completed` | `stopped`
  - `session_id`: session identifier
  - `pane_id`: `KAWAII_PANE_ID` 由来（必須）
  - `timestamp`: ISO 文字列
- 破損行は無視し、次行から復旧（安全性優先）。

## セッション→ペインのレジストリ
- `session_id` と `pane_id` を紐づける **ライブレジストリ** をアプリ内で保持。
- Codex は **起動コマンド検知で「起動マーカー」を記録**し、次に検出された JSONL に紐づける
  - **タイムアウトで破棄しない**（pane 終了か次の起動で上書き）
- **resume 操作時**:
  1) 紐づいた pane が存在し、status が working/waiting_user/completed の場合は **その pane に切り替え**
  2) 紐づきが無い場合は **新規タブで resume/fork**
- stopped 受信時:
  - **状態は stopped として記録**（ドット表示は **紐づいた pane がある場合のみ**）

## 例外・失敗時の扱い
- ファイルが存在しない → **`settings.json` を新規作成**
- パース失敗 → 変更しない・UIで通知
- 権限不足 → 変更しない・UIで通知
- `codex resume <session_id>` が失敗し JSONL が生成されない場合は、**OSC でプロンプト復帰を検知した時点で紐づけ解除**

## セキュリティ
- 書き換えはユーザー明示許可のときのみ
- 実行ファイルパスはアプリ内リソース固定
- 既存設定の破壊を避ける

## UI/UX の想定
- 設定画面に **Claude hooks 自動設定** トグル（Codex JSONL 監視は常時）
- 「今すぐ適用」ボタン
- カードの **resume 操作**は、該当ペインがあれば **そのペインへ移動**（resumeの代替）
- 失敗時はエラー表示 + リカバリ案内
- Codex のタブ紐づけが不確定なときは **新規タブで resume** を案内

## テスト観点
- macOS / Windows / WSL / Linux でファイル書き換え成功
- 既存 hooks があっても壊さず追記できる
- Codex config は一切変更しない
- WSLENV 変換で通知先が正しく動作
- Claude working / waiting_user / completed / stopped がカードに反映される
- Codex working / waiting_user がカードに反映される（JSONL 監視）
- 設定を戻したい場合、バックアップから復元可能

---

## まとめ
- **自動書き換えは実現可能**
- 安定性優先のため、
  - Claude: hooks（working/waiting_user/completed/stopped）
  - Codex: JSONL 監視（working/waiting_user）
  だけを対象にする

