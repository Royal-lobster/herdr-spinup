# herdr-spinup

Herdr plugin that spins up a working set of tools — one tab each — in the current directory:

| Tool    | Tab     | Command                          |
| ------- | ------- | -------------------------------- |
| `fresh` | `fresh` | TUI editor                       |
| `tuicr` | `tuicr` | code review                      |
| `cc`    | `cc`    | `claude --permission-mode auto`  |
| `cdx`   | `cdx`   | `codex --yolo`                   |

## Keys

Prefix is `ctrl+a`.

| Key          | Action                    |
| ------------ | ------------------------- |
| `prefix + S` | all four                  |
| `prefix + E` | `fresh`                   |
| `prefix + V` | `tuicr`                   |
| `prefix + C` | `cc`                      |
| `prefix + D` | `cdx`                     |

Or from the CLI:

```bash
herdr plugin action invoke srujan.spinup.all
herdr plugin action invoke srujan.spinup.cc
```

## Behaviour

- Tools launch in the cwd of the pane the action fired from.
- A tool already running **in that same cwd** is focused instead of relaunched, so
  repeated presses don't pile up tabs. Switching projects gets you a fresh set.
- The action lands you on the first tool requested (`fresh` for `all`).
- One tool failing doesn't block the others; the summary toast names what failed.

`tuicr` exits immediately outside a git/jj/hg repository — that's tuicr, not the plugin.

## Automatic tab titles

`tab-title.js` is a `UserPromptSubmit` hook for both Claude Code and Codex. On the
first prompt of a session it renames the enclosing Herdr tab to a short version of
that prompt, so `cc` becomes `fix the flaky auth test…`.

It only overwrites labels that are still a bare tab number or a tool name, which is
what limits it to the first message and keeps hand-named tabs safe. It writes nothing
to stdout — for `UserPromptSubmit`, stdout is injected into the model's context.

Wired into `~/.claude/settings.json` and `~/.codex/hooks.json`, alongside any hooks
already there.

## Install

```bash
herdr plugin link ~/Developer/Personal/herdr-spinup
```

## Implementation note

Tabs are created via `[[panes]]` entrypoints and `herdr plugin pane open --placement tab`,
**not** `tab create` + `pane run` / `agent start`. The latter looks equivalent but panes
made that way aren't registered in the attached client's UI state: herdr logs
`PaneDied for unknown pane` and SIGHUPs the agent the moment the client reconciles
focus, so `cc`/`cdx` tabs vanish a few seconds after opening. Plugin-owned panes are
persistent and survive focus. Agent detection is by process name, so `cc`/`cdx` still
show up in the agent panel with full lifecycle status without `agent start`.

The `cc`/`cdx` shell aliases don't exist in a plugin subprocess, so the manifest calls
the real binaries with their flags.
