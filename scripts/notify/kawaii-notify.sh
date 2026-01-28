#!/bin/sh
set -eu

export LC_ALL=C

sanitize_field() {
  value=${1:-}
  limit=${2:-200}
  printf '%s' "$value" \
    | tr -cd 'A-Za-z0-9._:@/+=-' \
    | cut -c1-"$limit"
}

read_stdin() {
  cat 2>/dev/null || true
}

extract_json_string() {
  key=$1
  printf '%s' "$RAW_ONE_LINE" \
    | sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" \
    | head -n 1
}

extract_json_number() {
  key=$1
  printf '%s' "$RAW_ONE_LINE" \
    | sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p" \
    | head -n 1
}

SOURCE="unknown"
EVENT="completed"
HOOK=""
while [ $# -gt 0 ]; do
  case "$1" in
    --source)
      shift
      SOURCE=${1:-}
      ;;
    --event)
      shift
      EVENT=${1:-}
      ;;
    --hook)
      shift
      HOOK=${1:-}
      ;;
  esac
  shift || break
done

PANE_ID=$(sanitize_field "${KAWAII_PANE_ID:-}" 200)
NOTIFY_PATH=${KAWAII_NOTIFY_PATH:-}
INSTANCE_ID=$(sanitize_field "${KAWAII_TERMINAL_INSTANCE_ID:-}" 200)
SOURCE=$(sanitize_field "$SOURCE" 40)
EVENT=$(sanitize_field "$EVENT" 40)
HOOK=$(sanitize_field "$HOOK" 40)

if [ -z "$PANE_ID" ] || [ -z "$NOTIFY_PATH" ]; then
  exit 0
fi

RAW=$(read_stdin)
RAW_ONE_LINE=$(printf '%s' "$RAW" | tr '\n' ' ')

DEBUG_PATH=${KAWAII_NOTIFY_DEBUG_PATH:-}
if [ -n "$DEBUG_PATH" ]; then
  TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  RAW_CLEAN=$(printf '%s' "$RAW" | tr '\n' '\\' | tr -d '\000' | cut -c1-4000)
  DEBUG_LINE="{\"source\":\"$SOURCE\",\"event\":\"$EVENT\",\"hook\":\"$HOOK\",\"pane_id\":\"$PANE_ID\",\"raw\":\"$RAW_CLEAN\",\"timestamp\":\"$TIMESTAMP\"}"
  printf '%s\n' "$DEBUG_LINE" >> "$DEBUG_PATH" 2>/dev/null || true
fi

SESSION_ID=""
for KEY in session_id sessionId session thread-id thread_id threadId conversation_id conversationId; do
  VALUE=$(extract_json_string "$KEY")
  if [ -z "$VALUE" ]; then
    VALUE=$(extract_json_number "$KEY")
  fi
  if [ -n "$VALUE" ]; then
    SESSION_ID=$VALUE
    break
  fi
done

SESSION_ID=$(sanitize_field "$SESSION_ID" 200)
if [ -z "$SESSION_ID" ]; then
  exit 0
fi

if [ "$EVENT" = "auto" ] || [ "$EVENT" = "notification" ]; then
  NOTIF_TYPE=$(extract_json_string "notification_type")
  if [ -z "$NOTIF_TYPE" ]; then
    NOTIF_TYPE=$(extract_json_string "notificationType")
  fi
  NOTIF_TYPE=$(sanitize_field "$NOTIF_TYPE" 80)
  if [ "$NOTIF_TYPE" = "permission_prompt" ]; then
    EVENT="waiting_user"
  elif [ "$NOTIF_TYPE" = "elicitation_dialog" ]; then
    EVENT="waiting_user"
  else
    EVENT="completed"
  fi
fi

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
LINE="{\"source\":\"$SOURCE\",\"event\":\"$EVENT\",\"session_id\":\"$SESSION_ID\",\"pane_id\":\"$PANE_ID\",\"timestamp\":\"$TIMESTAMP\""
if [ -n "$INSTANCE_ID" ]; then
  LINE="${LINE},\"instance_id\":\"$INSTANCE_ID\""
fi
if [ -n "$HOOK" ]; then
  LINE="${LINE},\"hook\":\"$HOOK\""
fi
LINE="${LINE}}"

DIR=$(dirname -- "$NOTIFY_PATH")
if [ -n "$DIR" ]; then
  mkdir -p "$DIR" 2>/dev/null || true
fi
printf '%s\n' "$LINE" >> "$NOTIFY_PATH" 2>/dev/null || true
