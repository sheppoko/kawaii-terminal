#!/usr/bin/env python3
"""
Claude CLI Wrapper for Kawaii Terminal history search.
Supports search (block payload) and deepsearch (folder scan).
"""

import sys
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

def debug(message: str):
    return


def find_cli() -> str:
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


def parse_json(text: str):
    try:
        return json.loads(text)
    except Exception:
        start = text.find('{')
        end = text.rfind('}')
        if start >= 0 and end > start:
            try:
                return json.loads(text[start:end + 1])
            except Exception:
                return None
    return None


def run_claude(messages, allow_tools: bool, model: str, folder_path: Optional[str] = None):
    try:
        cli_path = find_cli()
    except FileNotFoundError as e:
        return {"error": str(e)}

    add_dirs = []
    if allow_tools and folder_path:
        try:
            p = Path(folder_path)
            if p.exists():
                add_dirs.append(str(p))
        except Exception:
            pass

    cmd = [
        cli_path,
        "--output-format", "stream-json",
        "--input-format", "stream-json",
        "--model", model,
        "--verbose",
        "--print", "",
    ]
    if add_dirs:
        cmd.extend(["--add-dir", *add_dirs])
    if not allow_tools:
        cmd.extend(["--disallowedTools", "*"])

    env = {**os.environ, "CLAUDE_CODE_ENTRYPOINT": "sdk-py"}
    env.pop("ANTHROPIC_API_KEY", None)

    working_dir = tempfile.gettempdir()
    if allow_tools and add_dirs:
        working_dir = add_dirs[0]

    kwargs = {
        'stdin': subprocess.PIPE,
        'stdout': subprocess.PIPE,
        'stderr': subprocess.PIPE,
        'env': env,
        'cwd': working_dir,
    }
    if sys.platform == 'win32':
        kwargs['creationflags'] = subprocess.CREATE_NO_WINDOW

    try:
        proc = subprocess.Popen(cmd, **kwargs)
    except Exception as e:
        return {"error": str(e)}

    try:
        if proc.stdin:
            for message in messages:
                proc.stdin.write(json.dumps(message).encode('utf-8') + b'\n')
            proc.stdin.close()
    except Exception as e:
        try:
            proc.kill()
        except Exception:
            pass
        return {"error": f"Failed to write stdin: {e}"}

    full_text = ""
    error_text = ""

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

    try:
        proc.wait(timeout=5)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass

    if proc.returncode != 0:
        stderr_output = ""
        if proc.stderr:
            stderr_output = proc.stderr.read().decode('utf-8', errors='ignore')
        error_message = error_text or stderr_output or "CLI error"
        return {"error": f"CLI error: {error_message}"}

    payload = parse_json(full_text.strip())
    if payload is None:
        return {"error": "Invalid response"}
    return payload


def build_search_prompt(query: str, blocks):
    return (
        "You are a strict JSON generator. Output JSON only (no markdown).\n"
        "Return an object: {\"query\": string, \"summary\": string, \"candidates\": "
        "[{\"score\": number, \"why\": string, \"block\": object}]}.\n"
        "Rules:\n"
        "- Always respond.\n"
        "- candidates must be an array (possibly empty).\n"
        "- Each candidate.block must be EXACTLY one element from the provided Blocks array (verbatim copy). Do not invent ids or edit text.\n"
        "- If none match, return candidates: [] and a short summary.\n\n"
        f"Query: {query}\n\nBlocks (JSON array):\n{json.dumps(blocks, ensure_ascii=False)}"
    )


def build_deep_prompt(query: str, folder_path: str):
    return (
        "You can read files. Search JSONL/NDJSON history under the folder below.\n"
        "Each line is a JSON object. Prefer entries that look like a terminal history block with fields such as: id, input, output_text, created_at, pane_id, session_id.\n"
        "Return JSON only with schema: {\"query\": string, \"summary\": string, \"candidates\": "
        "[{\"score\": number, \"why\": string, \"block\": object}]}.\n"
        "Rules:\n"
        "- Only include blocks that exist in the files.\n"
        "- candidate.block should include at least: id, input (or inputs), output_text, created_at (or timestamp), pane_id, session_id.\n"
        "- If nothing matches, return candidates: [] with a short summary.\n\n"
        f"Folder: {folder_path}\nQuery: {query}"
    )

def build_claude_deep_prompt(query: str, folder_path: str, project_path: str):
    return (
        "You can read files. Search Claude Code JSONL logs under the folder below.\n"
        "Log format:\n"
        "- Each file is .jsonl (one JSON object per line).\n"
        "- Main conversation entries have: {\"type\":\"user\"|\"assistant\", \"isSidechain\":false, \"uuid\":..., \"sessionId\":..., \"timestamp\":..., \"message\":{...}}.\n"
        "- Ignore entries where isSidechain is true and ignore subagents logs.\n"
        "- For user entries: message.role == \"user\" and message.content contains the prompt text (string or array).\n"
        "- For assistant entries: message.role == \"assistant\" and message.content is an array; collect only content blocks with type==\"text\" (ignore thinking/tool_use).\n"
        "Reconstruct blocks:\n"
        "- Start a new block when you see a user entry.\n"
        "- A block includes the user prompt and the following assistant text entries until the next user entry.\n"
        "Return JSON only with schema: {\"query\": string, \"summary\": string, \"candidates\": "
        "[{\"score\": number, \"why\": string, \"block\": object}]}.\n"
        "Rules:\n"
        "- Only include blocks that exist in the files.\n"
        "- candidate.block must be directly displayable and include at least:\n"
        "  - id (use user uuid)\n"
        "  - pane_id (use the provided project_path)\n"
        "  - pane_label (use \"Claude\")\n"
        "  - session_id (use sessionId)\n"
        "  - input (user prompt text)\n"
        "  - inputs (optional, array of prompts)\n"
        "  - output_text (assistant text)\n"
        "  - created_at (timestamp; keep as ISO string if unsure)\n"
        "  - last_output_at (timestamp; keep as ISO string if unsure)\n"
        "- If nothing matches, return candidates: [] with a short summary.\n\n"
        f"Folder: {folder_path}\n"
        f"project_path: {project_path}\n"
        f"Query: {query}"
    )


def main():
    try:
        stdin_content = sys.stdin.read()
        if not stdin_content.strip():
            print(json.dumps({"error": "Empty stdin"}), flush=True)
            sys.exit(1)
        input_data = json.loads(stdin_content)
    except Exception as e:
        print(json.dumps({"error": f"Failed to read stdin: {e}"}), flush=True)
        sys.exit(1)

    mode = input_data.get("mode", "search")
    query = input_data.get("query", "")
    blocks = input_data.get("blocks", [])
    folder_path = input_data.get("folder_path", "")
    source = input_data.get("source", "")
    project_path = input_data.get("project_path", "")

    model = os.environ.get("HISTORY_SEARCH_MODEL") or "claude-opus-4-5-20251101"

    if mode == "deepsearch":
        if source == "claude":
            prompt = build_claude_deep_prompt(query, folder_path, project_path)
        else:
            prompt = build_deep_prompt(query, folder_path)
        allow_tools = True
    else:
        prompt = build_search_prompt(query, blocks)
        allow_tools = False

    messages = [
        {
            "type": "user",
            "message": {
                "role": "user",
                "content": prompt,
            },
        }
    ]

    result = run_claude(messages, allow_tools=allow_tools, model=model, folder_path=folder_path)
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
