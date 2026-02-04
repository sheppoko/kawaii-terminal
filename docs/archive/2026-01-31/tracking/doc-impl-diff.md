# ドキュメント vs 実装 差分一覧（初稿）

最終更新: 2026-01-31 11:38

> 目的: 既存ドキュメントは正とは限らないため、実装との差分を明示し、
> 修正方針をケースごとに確認する。

## 差分 1: Statusの出力アイドル判定の責務
- 実装: Renderer側が `outputIdle` を保持し、ステータス表示を補正
- ドキュメント: MainがStatusの単一ソース・オブ・トゥルース
- 影響: 複数ウィンドウで表示差異が出る可能性
- 提案: Mainへ統一（status:output IPC）
- 現状: **実装対応済み**
- 判断: **実装に合わせる（Main統一）**

## 差分 2: history:ack / history:invalidate の実装
- 実装: IPCは登録済みだが、HistorySyncServiceに実装がない
- ドキュメント: ack/invalidate が仕様として記載
- 影響: 将来の保守時に混乱
- 提案: メソッド実装（契約を満たす）
- 現状: **実装対応済み（ACKは最終時刻の記録のみ）**
- 判断: **ドキュメントに合わせるが、ACKは記録のみでOK**

## 差分 3: Statusのoutput_idle反映経路
- 実装: StatusServiceに `setOutputIdle` があるがIPC経由で呼ばれない
- ドキュメント: StatusはMainが管理
- 影響: Main側のidle状態が機能していない
- 提案: status:outputの追加と送信
- 現状: **実装対応済み**
- 判断: **実装に合わせる（status:output導入）**

## 差分 4: Historyの削除伝播
- 実装: Rendererは `removed` を処理できるが、Mainは削除を送らない
- ドキュメント: V1は削除を送らない（append-only）
- 影響: なし（実装が拡張準備済み）
- 提案: ドキュメントは現状維持
- 判断: **ドキュメント維持（削除伝播なし）**
