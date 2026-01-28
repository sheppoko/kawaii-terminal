param()

function Sanitize([string]$value, [int]$limit = 200) {
  if ([string]::IsNullOrEmpty($value)) { return "" }
  $text = ($value -replace '\s+', ' ').Trim()
  $text = $text -replace '[^A-Za-z0-9._:@/+=-]', ''
  if ($limit -gt 0 -and $text.Length -gt $limit) {
    $text = $text.Substring(0, $limit)
  }
  return $text
}

function CleanPath([string]$value, [int]$limit = 2000) {
  if ([string]::IsNullOrEmpty($value)) { return "" }
  $text = $value.Trim()
  if ($limit -gt 0 -and $text.Length -gt $limit) {
    $text = $text.Substring(0, $limit)
  }
  return $text
}

$Source = "unknown"
$Event = "completed"
$Hook = ""
for ($i = 0; $i -lt $args.Length; $i += 1) {
  switch ($args[$i]) {
    "--source" {
      if ($i + 1 -lt $args.Length) {
        $Source = $args[$i + 1]
        $i += 1
      }
    }
    "--event" {
      if ($i + 1 -lt $args.Length) {
        $Event = $args[$i + 1]
        $i += 1
      }
    }
    "--hook" {
      if ($i + 1 -lt $args.Length) {
        $Hook = $args[$i + 1]
        $i += 1
      }
    }
  }
}

$paneId = Sanitize $env:KAWAII_PANE_ID 200
$notifyPath = CleanPath $env:KAWAII_NOTIFY_PATH 2000
$instanceId = Sanitize $env:KAWAII_TERMINAL_INSTANCE_ID 200
$Source = Sanitize $Source 40
$Event = Sanitize $Event 40
$Hook = Sanitize $Hook 40

if (-not $paneId -or -not $notifyPath) { exit 0 }

$raw = [Console]::In.ReadToEnd()
$payload = $null
if ($raw) {
  try { $payload = $raw | ConvertFrom-Json -ErrorAction Stop } catch { $payload = $null }
}

$timestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$debugPath = CleanPath $env:KAWAII_NOTIFY_DEBUG_PATH 2000
if ($debugPath) {
  $rawLine = ""
  if ($raw) {
    $rawLine = ($raw -replace "`r?`n", "\n")
    if ($rawLine.Length -gt 4000) { $rawLine = $rawLine.Substring(0, 4000) }
  }
  $debugEntry = @{
    source = $Source
    event = $Event
    hook = $Hook
    pane_id = $paneId
    raw = $rawLine
    timestamp = $timestamp
  } | ConvertTo-Json -Compress
  $debugDir = Split-Path -Parent $debugPath
  if ($debugDir -and -not (Test-Path $debugDir)) {
    New-Item -ItemType Directory -Force -Path $debugDir | Out-Null
  }
  Add-Content -Path $debugPath -Value $debugEntry -Encoding Ascii
}

$sessionId = ""
if ($payload) {
  $keys = @(
    "session_id", "sessionId", "session",
    "thread-id", "thread_id", "threadId",
    "conversation_id", "conversationId"
  )
  foreach ($key in $keys) {
    $prop = $payload.PSObject.Properties[$key]
    if ($prop) {
      $value = Sanitize ($prop.Value) 200
      if ($value) { $sessionId = $value; break }
    }
  }
}

if (-not $sessionId) { exit 0 }

if ($Event -eq "auto" -or $Event -eq "notification") {
  $notifType = ""
  if ($payload) {
    $prop = $payload.PSObject.Properties["notification_type"]
    if ($prop) { $notifType = Sanitize ($prop.Value) 80 }
    if (-not $notifType) {
      $prop = $payload.PSObject.Properties["notificationType"]
      if ($prop) { $notifType = Sanitize ($prop.Value) 80 }
    }
  }
  if ($notifType -eq "permission_prompt") {
    $Event = "waiting_user"
  } elseif ($notifType -eq "elicitation_dialog") {
    $Event = "waiting_user"
  } else {
    $Event = "completed"
  }
}

$entry = @{
  source = $Source
  event = $Event
  session_id = $sessionId
  pane_id = $paneId
  timestamp = $timestamp
}
if ($instanceId) { $entry.instance_id = $instanceId }
if ($Hook) { $entry.hook = $Hook }

$json = $entry | ConvertTo-Json -Compress
$dir = Split-Path -Parent $notifyPath
if ($dir -and -not (Test-Path $dir)) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
}
Add-Content -Path $notifyPath -Value $json -Encoding Ascii
