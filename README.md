# kawaii-terminal

[![Featured on Orynth](https://orynth.dev/api/badge/kawaii-terminal-3850?theme=light&style=default)](https://orynth.dev/projects/kawaii-terminal-3850)

The terminal for Claude Code and Codex.
Session memory for AI coding: search, rewind, branch from any moment.

[日本語](README.ja.md)

## What it is
kawaii-terminal is a terminal app that treats AI sessions as first-class work.
It keeps context, makes history searchable, and lets you jump back to any past
moment to branch a new session with the same agent and context.

It is not an IDE. It is a terminal that adds memory and navigation for AI runs.

## Quick start (from source)
```bash
npm install
npm start
```

## Who it is for
- You run Claude Code or Codex daily and want to keep every session reusable.
- You live in CLI/TUI tools and do not want to move your workflow into an IDE.
- You want to keep up with fast-moving TUI tools without waiting on IDE plugins.

## Why a terminal
- Your real workflow lives in CLI/TUI tools that update constantly
  (version control, multiplexers, fuzzy finders, system monitors, REPLs).
- SSH and full-screen TUIs are still the fastest way to build and debug.
- No IDE lock-in: keep the terminal as the source of truth and let the app add context.

## Core workflow
1) Run Claude Code or Codex normally.
2) kawaii-terminal reads agent JSONL logs and makes sessions searchable.
3) Jump back, branch mid-session, or resume without losing context.

<p align="center">
  <img src="docs/assets/screenshots/v1.0.3-alpha/readme-main.png" width="860" alt="Session history">
</p>

## What "fork" means here
Forking is point-in-time. You can branch from any step inside a session,
not only from the latest state. Pick a message, keep its exact context, and continue.

<p align="center">
  <img src="docs/assets/screenshots/v1.0.3-alpha/readme-forkfromany.png" width="860" alt="Fork from any moment">
</p>

## Core features (the point)
- Fork any moment: branch from any step inside a session (mid-session, not just the latest).
- Searchable session history across Claude Code and Codex runs.
- Active agents panel for in-flight sessions.
- Visual session resume and management across agents.
- Session summaries (optional; Claude or Gemini providers).
- Windows + WSL-aware paths and sessions.
- Notifications and tab previews when agents finish.
- Inline image preview and file path opening.

<p align="center">
  <img src="docs/assets/screenshots/v1.0.3-alpha/readme-summary.png" width="860" alt="Active agents and session summaries">
</p>

## Also includes
- Optional kawaii avatar for encouragement.
- Multi-tab, split panes, and rich keyboard shortcuts.

If you want a terminal-first workspace that keeps your daily CLI/TUI tools intact
while adding AI session memory, that is kawaii-terminal.

## Downloads
For the latest downloads, please visit:
https://kawaii-terminal.dev/

GitHub Releases are also available as a mirror:
https://github.com/sheppoko/kawaii-terminal/releases

## Build
```bash
npm run build
npm run build:mac
npm run build:win
```

## Development
```bash
npm test
npm run lint
```

## License
MIT (see package.json).
