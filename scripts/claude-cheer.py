#!/usr/bin/env python3
"""
Claude CLI Wrapper for Kawaii Terminal Cheer
シンプルな応援メッセージ生成用
"""

import sys
import json
import os
import shutil
import subprocess
from pathlib import Path

# Windows UTF-8対応
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

def debug(message: str):
    return


def find_cli() -> str:
    """Claude CLIのパスを探す"""
    if cli := shutil.which("claude"):
        return cli

    locations = [
        Path.home() / "AppData/Roaming/npm/claude.cmd",
        Path.home() / "AppData/Roaming/npm/claude",
        Path.home() / ".npm-global/bin/claude",
        Path("/opt/homebrew/bin/claude"),
        Path("/usr/local/bin/claude"),
    ]

    for path in locations:
        if path.exists():
            return str(path)

    raise FileNotFoundError("Claude CLI not found")


def main():
    # stdinからJSON読み取り
    try:
        stdin_content = sys.stdin.read()
        debug(f"stdin_content: {stdin_content[:200]}")

        if not stdin_content.strip():
            print(json.dumps({"error": "Empty stdin"}), flush=True)
            sys.exit(1)

        input_data = json.loads(stdin_content)
        language = input_data.get("language", "ja")
        session_id = input_data.get("session_id")  # 継続用

        debug(f"language: {language}, session_id: {session_id}")

    except Exception as e:
        print(json.dumps({"error": f"Failed to read stdin: {e}"}), flush=True)
        sys.exit(1)

    # CLI パス
    try:
        cli_path = find_cli()
    except FileNotFoundError as e:
        print(json.dumps({"error": str(e)}), flush=True)
        sys.exit(1)

    # 現在日時を取得
    from datetime import datetime
    now = datetime.now()
    datetime_str = now.strftime("%Y-%m-%d %H:%M")
    hour = now.hour

    # 時間帯の判定
    if 5 <= hour < 12:
        time_period = "朝" if language == "ja" else "morning"
    elif 12 <= hour < 17:
        time_period = "昼" if language == "ja" else "afternoon"
    elif 17 <= hour < 21:
        time_period = "夕方" if language == "ja" else "evening"
    else:
        time_period = "夜" if language == "ja" else "night"

    # プロンプト構築（シンプルに、LLMの創造性を活かす）
    if session_id:
        # 継続: 短いプロンプト
        if language == "ja":
            prompt = f"次（{time_period}、{datetime_str}）"
        else:
            prompt = f"Next ({time_period}, {datetime_str})"
    else:
        # 初回: キャラ設定と最小限の指示
        if language == "ja":
            prompt = f"あなたはかわいいアニメ女の子。開発者のそばでずっと見守りながら応援している。100文字程度で1つ応援して。現在: {datetime_str}（{time_period}）。禁止: 「早く寝て」「休んで」など作業を止めさせる応援。"
        else:
            prompt = f"You're a cute anime girl always by the developer's side, watching and cheering them on. Give one encouragement (~30 words). Now: {datetime_str} ({time_period}). Never say 'go to sleep' or 'take a break' - always encourage working."

    # モデル設定（Opus 4.5固定）
    model = os.environ.get("CHEER_MODEL") or "claude-opus-4-5-20251101"

    # コマンド構築（全ツール禁止でテキスト出力のみ）
    cmd = [
        cli_path,
        "--output-format", "stream-json",
        "--input-format", "stream-json",
        "--model", model,
        "--verbose",
        "--print", "",
        "--disallowedTools", "*",  # 全ツール禁止
    ]

    # セッション継続の場合は --resume を追加
    if session_id:
        cmd.extend(["--resume", session_id])

    debug(f"Prompt: {prompt[:300]}")

    # 環境変数
    env = {**os.environ, "CLAUDE_CODE_ENTRYPOINT": "sdk-py"}
    env.pop("ANTHROPIC_API_KEY", None)  # Maxプラン強制

    try:
        # Windows互換性のためPopenを使用
        # 安全のためtempディレクトリで実行（プロジェクトファイルへのアクセス防止）
        import tempfile
        kwargs = {
            'stdin': subprocess.PIPE,
            'stdout': subprocess.PIPE,
            'stderr': subprocess.PIPE,
            'env': env,
            'cwd': tempfile.gettempdir(),
        }
        # Windowsでコンソールウィンドウを非表示
        if sys.platform == 'win32':
            kwargs['creationflags'] = subprocess.CREATE_NO_WINDOW

        proc = subprocess.Popen(cmd, **kwargs)

        # stdin経由でプロンプト送信（stream-json形式）
        user_message = {
            "type": "user",
            "message": {
                "role": "user",
                "content": prompt,
            }
        }
        if proc.stdin:
            proc.stdin.write(json.dumps(user_message).encode('utf-8') + b'\n')
            proc.stdin.close()

        full_text = ""
        error_text = ""
        result_session_id = None

        if proc.stdout:
            for line_bytes in proc.stdout:
                line = line_bytes.decode('utf-8', errors='ignore').strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue

                event_type = event.get("type")
                if event_type == "assistant":
                    message = event.get("message", {})
                    content = message.get("content", [])
                    for block in content:
                        if block.get("type") == "text":
                            text = block.get("text", "")
                            if text:
                                full_text += text
                elif event_type == "result":
                    if event.get("is_error"):
                        error_text = event.get("result") or event.get("error") or ""
                    else:
                        if not full_text:
                            full_text = event.get("result") or full_text
                        # session_idを取得
                        result_session_id = event.get("session_id")

        proc.wait(timeout=5)

        if proc.returncode != 0:
            stderr_output = ""
            if proc.stderr:
                stderr_output = proc.stderr.read().decode('utf-8', errors='ignore')
            error_message = error_text or stderr_output or "CLI error"
            print(json.dumps({"error": f"CLI error: {error_message}"}), flush=True)
            sys.exit(1)

        message = full_text.strip()
        if not message and error_text:
            print(json.dumps({"error": f"CLI error: {error_text}"}), flush=True)
            sys.exit(1)

        result = {"message": message}
        if result_session_id:
            result["session_id"] = result_session_id
        print(json.dumps(result, ensure_ascii=False), flush=True)

    except Exception as e:
        print(json.dumps({"error": str(e)}), flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
