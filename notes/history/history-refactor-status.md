# 目的
History/TimeMachine周りを「Source分離・Builder分離・JSONL I/O分離」で整理し、
新しいモデル/データソース追加を「HistorySourceを1つ追加するだけ」に近づける。

# どこまで終わったか（実装済み）
- HistoryService（司令塔）: src/main/history/app/history-service.js
- HistoryRepository（集約/キャッシュ/ソート）: src/main/history/domain/repository.js
- Source登録マップ（Registry相当）: src/main/history/domain/sources/index.js
- JsonlReader（head/tail/stream読み取り）: src/main/history/infra/jsonl-reader.js
- Utils: text/claude/codex + path/wsl/keyword/file-stats
  - src/main/history/utils/text-utils.js
  - src/main/history/utils/claude-utils.js
  - src/main/history/utils/codex-utils.js
- JsonlSource抽象 + Claude/Codex Source分離
  - src/main/history/domain/sources/jsonl-source.js
  - src/main/history/domain/sources/claude-jsonl-source.js
  - src/main/history/domain/sources/codex-jsonl-source.js
- Builder層の分離
  - SessionIndexBuilder: src/main/history/domain/builders/session-index-builder.js
  - Codex BlockBuilder: src/main/history/domain/builders/codex-blocks.js
  - TimeMachineBuilder: src/main/history/domain/builders/time-machine.js
- Claude BlockBuilder: src/main/history/domain/builders/claude-blocks.js
- Claude/Codex TimeMachine安定化（source_id優先・UUIDv7・session_metaの扱い調整）
- Claude入力抽出の精度改善（local-command transcript除外）
- Timeline/一覧から「入力なしブロック」を除外（UI + Repository）
- TimeMachine失敗時の詳細ログ（source側でconsole.error）
- HistoryServiceの旧TimeMachine/scan/summary実装の削除（Source/Repository委譲）
- keywordSearchAll/loadAllRecentのall集約をRepositoryに移動（cursor維持）
- HistorySource契約の明文化（notes/history/history-source-contract.md）
- 契約テスト追加（test/history-source-contract.test.js）
- HistoryService内の重複定数/キャッシュの撤去（history-constants + Source/Repositoryへ）
- **HistorySyncService追加（main）**: src/main/history/app/history-sync-service.js
  - snapshot→delta の新しい同期経路を実装
  - 初回スナップショットは 1件（snapshotPrimeLimit）
  - bootstrap delta は 5件単位で送信（bootstrapBatchSize）
  - snapshot が来るまで delta を抑制する active ハンドシェイク
- **HistoryIPC追加（main）**: src/main/history/app/history-ipc.js
- **HistoryClient追加（renderer）**: src/renderer/runtime/history-client.js
- **HistoryManagerの外部履歴モード移行**
  - snapshot/delta 経由に切り替え（listChanges/polling撤去）
  - session一覧は renderer 側で 400件に clamp
- **旧 listChanges 経路の撤去**
  - IPC/preload/Repository/listChanges を削除
- **Status分離（main↔renderer）**
  - StatusService / StatusIPC / StatusClient を導入
  - notify → status 経路へ移行（renderer直結を削除）
- **renderer.js 分割（左ペイン抽出）**
  - left-pane.js + ui-utils.js を追加（renderer.js から左ペイン管理を移動）
- **renderer.js 分割（ウィンドウUI抽出）**
  - window-ui.js を追加（タイトルバー/デバッグメニュー/リサイズを移動）
- **renderer.js 分割（ターミナルUI抽出）**
  - terminal-ui.js を追加（検索/コンテキストメニュー/ヘルス表示を移動）
- **renderer.js 分割（設定UI/ショートカット抽出）**
  - settings-ui.js を追加（設定パネル/ショートカット/ホイール入力を移動）
- **renderer.js 分割（ショートカット/タブスイッチャー/ドラッグ&ドロップ抽出）**
  - shortcuts.js を追加（ショートカット定義/パース/マネージャ）
  - tab-switcher.js を追加（Alt+Tab風スイッチャー）
  - terminal-dnd.js を追加（ターミナルD&D）
- **renderer.js 分割（アクション/メニュー抽出）**
  - action-dispatcher.js を追加（ショートカット/メニューのアクション実行）
- **renderer.js 分割（ターミナルショートカット抽出）**
  - terminal-shortcuts.js を追加（キー入力ハンドリング）
- **renderer フォルダ整理**
  - ui/（left-pane, window-ui, settings, tab-switcher）
  - terminal/（terminal, terminal-ui, terminal-dnd, terminal-shortcuts）
  - actions/（shortcuts, action-dispatcher）
- **HistoryManager 縮退（右パネル撤去）**
  - history-manager.js から history list/detail/旧search を削除
  - scheduleRender は左サイドバー専用
  - 右パネル要素（history-list / history-detail / history-session-list）依存を撤去
- **TimeMachine 実装の完全一本化**
  - HistoryService の旧TimeMachine経路を削除し、Repository → Source に一本化
- **main/history 構造整理（app/domain/infra/utils）**
  - app: history-service / history-sync-service / history-ipc
  - domain: repository / builders / sources / history-constants
  - infra: jsonl-reader / file-stats / path-utils / wsl-*
  - utils: block/claude/codex/text/keyword/search + session utils

# テスト状況
- **未再実行**（リファクタ後に大きく変更あり）
- 追加テスト:
  - test/claude-blocks.test.js
  - test/claude-timemachine.test.js
  - test/codex-timemachine.test.js（source_id経路のみの統合）
  - test/codex-utils.test.js（isTargetCodexUserMessage追加）
  - test/codex-blocks.test.js
  - test/history-repository.test.js
  - test/claude-utils.test.js（local-command除外）
  - test/history-sources.test.js
  - test/jsonl-reader.test.js

# 現状の挙動（確定）
- **HistorySyncService**は「**index scan → summary build → delta**」の流れ
  - 初回スナップショットは **1件だけ返す**（`snapshotPrimeLimit = 1`）
  - その後は **bootstrap delta を 5件単位**で送信（`bootstrapBatchSize = 5`）
  - **snapshot が返るまで delta は抑制**（active ハンドシェイク）
  - **3秒間隔のスキャン**、watcherは未使用
  - **remove は送らない**（V1: 追加/更新のみ）
  - **meta は index entries から算出**（getMeta の二重 scan を撤去）
  - **summary 生成は並列化済み**（SessionIndexBuilder の concurrency を利用）
  - **sourceごとのindex scanは並列実行**、JSONLのstatも並列化
- **Renderer側**は bootstrap delta を **即時適用**（frame gating なし）
  - 通常の delta は「ユーザー操作中のみ」バッファリング
- **履歴の上限 400** は renderer 側で clamp 済み

# 劣化の理由（なぜ遅くなったか）
- **毎tickで full index scan**（sourceごとの readdir/stat が重い）
- **初期表示/増分更新がリファクタ前より遅い**（現状は full scan が主因）

# 追加でやったほうが良いと発見したところ
- **TimeMachineの重複実装の解消**  
  現在 `history-service.js` と `builders/time-machine.js` に同等の処理が残っており、
  バグ修正が二重適用になる。Source一本化の方針と逆行するため、
  `HistoryService` 側の旧実装は削除 or Builder委譲が必要。
- **TimeMachineのI/O順序バグ対策**  
  出力ファイルopen待ち中に入力が読み終わる競合で「0行」になる問題が出た。
  `builders/time-machine.js` では修正済みだが、
  `history-service.js` 側の旧実装にも同じ修正を適用した（残存する限り注意）。
- **TimeMachine失敗時の診断ログの標準化**  
  Claude/Codexで最低限の診断（targetの有無、行数、paths）を出すようにしたが、
  出力先（main process stderr）の明記/UI表示の検討は未実施。

# 現在の課題（劣化 / 未解決）
## 性能劣化（許容）
- **full scan が重い**（sourceごとの readdir/stat）
- **初期表示/増分更新が遅い**（体感で劣化）
- watcher 未使用を前提に **full scan を許容**（差分更新は計画から除外）

## UI反映の問題
- bootstrap の段階反映は実測で確認済み（renderer 側の apply はOK）

## 設計上の残課題
- renderer.js 巨大化の解消が未完

# 決定事項（平易）
- 「all（全ソースまとめ）」は **Repositoryで集約** に統一（keywordSearchAll/loadAllRecentもRepository集約）
- snapshot は **先**、delta は **後**（active ハンドシェイク）

# おすすめ（理由）
- **Repository集約に統一**  
  集約・キャッシュ・ソートが1箇所になり、Source追加時にHistoryServiceを触らずに済む。
- **HistoryServiceから旧実装を除去してSource/Builder/Readerに一本化**  
  修正の二重適用を防げて、責務分離が明確になる。
- **HistorySource契約の明文化＋契約テスト**  
  新しいSourceを追加してもUI/Repositoryが壊れない保証になる。
- **定数・キャッシュの単一化**  
  値の乖離やキャッシュ不整合を防げる。

# 作業計画（Source一本化の筋）
1) **“all” 集約の方針決定と一本化**  
   - Repository集約に統一する（またはAllSourceで一本化する）  
   - HistoryService側の独自集計や重複キャッシュを削除
2) **HistoryServiceの旧実装の除去**  
   - `history-service.js` 内の TimeMachine実装を削除し、`builders/time-machine.js` + Source経由に一本化  
   - 旧実装に依存する呼び出しが残っていないかを `rg` で確認
3) **HistoryServiceの薄型化（司令塔に専念）**  
   - Claude/Codex固有の読み取り・パース・集計ロジックを Source/Builder/Reader に寄せる  
   - `HistoryService` から `collect* / scan* / build*` 系の実装を撤去
4) **HistorySource契約の明文化**  
   - `capabilities`・戻り値形（sessions/blocks/errors）・必須フィールドの統一  
   - Source単位の契約テスト追加（最低限: listSessions/loadSession/createTimeMachine）
5) **定数・キャッシュの単一化**  
   - HistoryService内の重複定数/キャッシュを共通モジュールに寄せる  
   - Source/Repositoryが唯一のキャッシュレイヤになるよう整理する

# 追加作業計画（性能回復）
1) **summary 生成の並列化** ✅
   - SessionIndexBuilder の concurrency を再利用（済）
2) **meta 再計算の TTL 化** ✅
   - getMeta の二重 scan を撤去し、index entries から meta を算出（済）
3) **bootstrap 反映の見え方の最終整理**
   - renderer の batching を検証し、必要なら apply ポリシー調整

# 完了条件（シニアレビュー通過ライン）
- HistoryServiceからソース固有ロジックが消え、Source/Builder/Readerに責務が集約
- TimeMachine実装が1箇所に統合され、重複が無い
- Sourceの戻り値契約が明文化され、契約テストが通る
- npm test が安定パスし、履歴UIで既存機能の退行が無い

# 残作業（未完了）
- npm test 再実行

# 補足
- 現状はHistoryServiceがまだ多くの実装詳細を抱えているため、
  「HistorySourceを1つ追加するだけ」には未到達。
- 破損JSONLの自動掃除は不要という指示で削除済み（設計対象外）。
- デバッグログは**通常無効**（必要時のみ有効化する方針）。

# 設計ガイド（違う方向に走らないために）
## 原則
- **差分の吸収はSource内部で完結**させる（取得方法/形式/パース/正規化）。
- **Repositoryは集約・キャッシュ・ソートのみ**に徹する。
- **HistoryServiceは司令塔**であり、Source実装の詳細を持たない。
- 出力はすべて **共通フォーマット（SessionSummary / Block）** に正規化する。

## 追加時の考え方（DB/HTTP/JSONL 共通）
- 新しいデータソースは **HistorySourceを1つ追加**するのが原則。
- ただし **Source内部に Parser/Builder/Client を持つ設計**であることが条件。
  - JSONLなら JsonlReader
  - DBなら DBClient / RowMapper
  - HTTPなら ApiClient / ResponseMapper

## 理想のSourceクラスツリー（完成形）
※「将来」と書かれたクラスは **実装不要（今回のスコープ外）**
HistoryService
├─ HistoryRepository（集約/キャッシュ/ソートのみ）
├─ HistorySourceRegistry（source名→Source実装）
├─ HistorySource（インターフェース）
│  ├─ JsonlSource（抽象）
│  │  ├─ ClaudeJsonlSource
│  │  └─ CodexJsonlSource
│  ├─ DbSource（将来）
│  │  ├─ PostgresSource
│  │  └─ SqliteSource
│  └─ ApiSource（将来）
│     ├─ ClaudeApiSource
│     └─ CodexApiSource
├─ Builder層
│  ├─ SessionIndexBuilder
│  ├─ BlockBuilder
│  │  ├─ ClaudeBlockBuilder
│  │  └─ CodexBlockBuilder
│  └─ TimeMachineBuilder
│     ├─ ClaudeTimeMachine
│     └─ CodexTimeMachine
└─ Low-level I/O / Client
   ├─ JsonlReader
   ├─ DbClient
   └─ ApiClient

## Parser/Builder/Clientの責務
- **Source**: 取得/フィルタ/正規化/変換の“入口”。
- **Builder**: 生データ → Block/SessionSummary への変換ロジック。
- **Reader/Client**: I/O担当（ファイル/DB/HTTP）。

## やってはいけないこと
- HistoryServiceに「特定ソース専用のパース」を戻さない。
- Repositoryに「source固有の処理」を入れない。
- Source外に「生データ形式依存のロジック」を散らさない。
