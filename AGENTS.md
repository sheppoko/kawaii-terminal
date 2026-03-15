Codexで`npm run build:mac`する時はsandbox内だと`codesign --timestamp`で落ちることがあるので、sandbox外か`require_escalated`で実行。
