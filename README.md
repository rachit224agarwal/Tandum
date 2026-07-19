# Agent Harness

Real-time, shareable terminal sessions for CLI agents and shells.

## What it does

- Spawns an allowed CLI command inside a real PTY on the backend
- Streams live terminal output to every connected viewer with Socket.io
- Replays bounded scrollback for late joiners
- Gives exactly one viewer control at a time
- Lets viewers request control and current controllers grant it live
- Forks a fresh session seeded with the current transcript
- Shares sessions with `?session=<id>` links

## Quick start

```bash
npm install
npm start
```

Open `http://127.0.0.1:3000`.

## Allowed commands

By default the app allows the current shell as:

```bash
shell:/bin/zsh
```

You can override that before the demo:

```bash
ALLOWED_COMMANDS='shell:/bin/zsh,claude:claude,aider:aider,cursor:cursor-agent'
npm start
```

Format:

```bash
label:command arg1 arg2,label2:command2
```

## Notes for macOS

`npm install` runs a postinstall fix that restores execute permissions on
`node-pty`'s `spawn-helper`, which avoids the common `posix_spawnp failed`
issue on some local installs.

## 1-minute demo tests

1. Create a session and confirm the terminal appears with a shareable `?session=` URL.
2. Open the same URL in a second tab and confirm the existing terminal output is visible.
3. Type in the first tab and confirm the second tab mirrors output live.
4. In the second tab, click `Request control`, grant it in the first tab, and confirm typing only works from the new controller.
5. Click `Fork session` in the second tab and confirm a fresh session opens with the prior transcript shown as seed context.
