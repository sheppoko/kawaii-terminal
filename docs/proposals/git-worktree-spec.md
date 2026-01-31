# Git Worktree 仕様（kawaii-terminal）

## 目的
- マルチエージェント作業を前提に、Git worktree を使った安全な並行作業を実現する。
- worktree が削除された場合でも、ユーザーに明確な警告を出し、必要なら「元CWDで再開」できるようにする。
- resume と worktree の相性問題を UI/ロジックで緩和する（“当時の状態ではない”を明示）。

## 用語
- **元CWD / ベースリポジトリ**: worktree の親となる実リポジトリの作業ディレクトリ。
- **worktree CWD**: `git worktree add` によって作られた作業ディレクトリ。
- **セッション**: Claude / Codex の JSONL ログ単位。
- **移植セッション**: worktree が消えた際に、元CWDで再開するために JSONL を作り直した新セッション。

## UX 要件
### Active Agents セクション
- Active Agents が 0 件でも **CWD グループを表示し続ける**。
- グループ内のセッションカードは空でよい。
- CWD ヘッダに `+` ボタン（メニュー）を置く。

### `+` メニュー
- **New agent**
  - `claude` / `codex`（存在確認済のものだけ表示）
- **New worktree agent**
  - `claude` / `codex`（存在確認済のものだけ表示）

### 復元時の警告表示
- worktree が見つからない場合は必ず **警告ダイアログ**を出す。
- 文言に「当時の worktree 状態ではない」ことを明確に記載する。

例: 
> worktree フォルダが削除されています。\n元CWDで再開しますか？\n（当時のworktree状態ではありません）

## 動作仕様

### 1) New agent
- クリック時点の CWD をそのまま使用。
- 新しいタブで `claude` / `codex` を起動。

### 2) New worktree agent
- 対象 CWD が Git リポジトリであることを確認。
- `git worktree add` で worktree 作成。
- **worktree CWD で新規セッションを起動**（resume ではない）。

> 理由: resume は CWD スコープ依存のため、元CWDで開始すると worktree に触らない保証ができない。

### 3) Resume（worktree セッション）
- **worktree フォルダが存在する**
  - その worktree CWD で通常 resume。
- **worktree フォルダが存在しない**
  - 警告を表示 → ユーザー許可があれば「移植セッション」作成 → 元CWDで resume。
  - ユーザーが拒否した場合は何もしない。

### 4) JSONL 移植（元CWDで再開するための処理）
- **Claude**
  - JSONL は `~/.claude/projects/<CWDからエンコードしたディレクトリ>` 配下に保存される。
  - worktree の JSONL を **元CWDのプロジェクト領域**にコピーし、新しい session_id を発行する。
  - JSONL 内の `cwd` / `pane_id` など、CWD 由来フィールドを元CWDに書き換える。

- **Codex**
  - JSONL は `~/.codex/sessions/` 配下。
  - 新しい session_id の JSONL を作成し、`cwd` を元CWDに書き換える。

- どちらも **新セッションとして起動**（履歴は引き継ぐが、作業状態は復元できない）。

### 5) “当時の状態ではない” 明示
- 移植セッション起動時に必ずトースト or バナーで伝える。
- 例: 「worktree は削除されていたため、元CWDで再開しました。コード状態は当時と異なる可能性があります。」

## 保存するメタ情報
worktree セッション作成時に以下を保存する（ローカルストレージ or 設定ファイル）:
- `sessionId`
- `source` (`claude` / `codex`)
- `repoRoot`
- `baseCwd`
- `worktreePath`
- `branch`（存在すれば）
- `headSha`（作成時点の HEAD）
- `createdAt`

> worktree フォルダの存在確認には `worktreePath` を使う。

## Git コマンド（例）
- リポジトリ判定: `git -C <cwd> rev-parse --show-toplevel`
- worktree 作成: `git -C <repoRoot> worktree add <worktreePath> -b <branch>`
- worktree 一覧: `git -C <repoRoot> worktree list --porcelain`

## エラーハンドリング
- Git が無い / リポジトリでない → New worktree agent を非表示 or 無効化。
- `worktreePath` が既に存在 → 別名を促す。
- JSONL 移植が失敗 → エラーダイアログ + 元CWDで新規セッション開始の選択肢。

## 非目標
- worktree の自動再生成（ユーザーが「最新になってしまう」ことを嫌うため）
- 未コミット差分の復元

## 未決定事項
- worktree パス命名規則（例: `<repo>/.worktrees/<sessionId>` or `<repo>-wt-<shortid>`）
- branch 命名規則（例: `agent/<timestamp>`）
- JSONL 移植時の「どこまで書き換えるか」の詳細（cwd/pane_id 以外の field を含めるか）
- 警告ダイアログの UI 詳細（文言/ボタン文言）
