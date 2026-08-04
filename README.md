# herdr-spinup

Herdr plugin that spins up a working set of tools — one tab each — in the current directory:

| Tool    | Tab     | Command                          |
| ------- | ------- | -------------------------------- |
| `fresh` | `fresh` | TUI editor                       |
| `tuicr` | `tuicr` | code review                      |
| `cc`    | `cc`    | `claude --permission-mode auto`  |
| `cdx`   | `cdx`   | `codex --yolo`                   |

## Keys

**Keybindings are client-side.** The plugin is installed on the machine running the
herdr *server* (forge), but keys are read by the *client* — so when driving forge from
another machine with `herdr --remote forge`, the `[[keys.command]]` blocks in this
manifest never fire. They have to be declared in the **client's**
`~/.config/herdr/config.toml`.

`type = "plugin_action"` does **not** work from such a client: it resolves against the
*local* plugin registry, and a remote client has none (`herdr plugin list` → "No plugins
installed", no local server). The binding is silently dropped — no error, and nothing
reaches the server's plugin log. Use `type = "shell"` and invoke the action on the server
over SSH instead; it runs detached, and a multiplexed round trip is ~0.2s:

```toml
[[keys.command]]
key = "prefix+space"
type = "shell"
command = 'ssh -n forge "~/.local/bin/herdr plugin action invoke srujan.spinup.picker"'
description = "spinup menu"
```

The absolute path matters — a non-interactive SSH shell doesn't have `herdr` on `PATH`.
The action still resolves the workspace and cwd from the *focused* pane on the server, so
tools land in whatever project you're looking at.

Bindings live in rover's config (prefix there is Hyper+J, `cmd+ctrl+alt+shift+j`):

| Key                | Action               |
| ------------------ | -------------------- |
| `prefix + space`   | open the picker menu |
| `prefix + shift+s` | all four             |
| `prefix + shift+e` | `fresh`              |
| `prefix + shift+v` | `tuicr`              |
| `prefix + shift+c` | `cc`                 |
| `prefix + shift+y` | `cdx`                |

Run `herdr config check` after editing — it reports collisions with built-in bindings
that aren't listed in the config file, and herdr silently keeps the built-in and disables
yours. `prefix+e/r/c/d` are already `edit_scrollback`, `resize_mode`, `copy_mode` and
`close_workspace`; `prefix+shift+t` is `rename_tab`.

The manifest's own keybindings are kept for the case where the client runs on the same
machine as the server.

Or from the CLI:

```bash
herdr plugin action invoke srujan.spinup.all
herdr plugin action invoke srujan.spinup.cc
```

## New tabs

A `tab.created` event hook opens the picker whenever you make a new tab, so "new tab"
becomes "new tab, running something". Pick a tool and the now-redundant empty tab closes
itself; press `esc` and it stays exactly as it was.

Herdr's own built-in "new tab" dialog can't be extended — plugins get actions, panes,
events, link handlers and keybindings, and none of them reach native UI. This hook is the
closest equivalent. Because that dialog is session-modal and blocks plugin popups, the
handler retries for ~8s and the picker appears once you dismiss it.

The tabs this plugin opens are new tabs too, so they re-fire the hook. A time-boxed
marker file (`$HERDR_PLUGIN_STATE_DIR/suppress-tab-events`) is what stops the recursion —
tab labels can't do it, because the event fires before the tab is renamed.

## The picker

`prefix + space` opens a popup menu — click an entry with the mouse, or use `↑↓`/`jk`,
`1`-`4`, `enter`. `esc` or `q` dismisses it. Tools already running in the current
directory are dimmed and marked `✓`. Launching all four is `prefix + S`, not a menu row.

This exists because **herdr has no button surface**. A plugin action can only be fired
by a keybinding, the CLI, a ctrl+clicked link, or an event hook — there is no command
palette, menu or toolbar. A popup pane is the one place a plugin can draw its own UI,
and popups receive forwarded mouse events, so it is genuinely clickable.

The picker is an **overlay** pane, not a `popup`. Popups look like the obvious fit and are
worse in every way that matters:

| | `popup` | `overlay` |
| --- | --- | --- |
| more than one at a time | no — `popup already open` | fine |
| in `pane list` / `api snapshot` | no | yes |
| gets `HERDR_PANE_ID` | no | yes |
| closable via `plugin pane close` | nothing to target | yes |
| position | centred on the whole window, so off-centre whenever the sidebar is open | fills the active pane |

`width`/`height` are only accepted for `popup`, and are rejected outright for anything
else. The singleton rule is the nastiest part: it silently blocks the picker from opening
while any other popup — including herdr's own "new tab" dialog — is up.

Placement is declared here in the manifest and deliberately *not* passed on the
`plugin pane open` calls, so there's one source of truth. The picker draws no border of its
own, since herdr already frames and titles a plugin pane.

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

Two more sharp edges worth knowing:

- The plugin directory is the working directory for **actions** only. A pane opened with
  an explicit `--cwd` runs *there*, so `command = ["node", "picker.js"]` fails with
  `Cannot find module`. Pane commands must use `$HERDR_PLUGIN_ROOT`.
- `herdr` reports API failures as an `{error:{code,message}}` payload. `lib.js` inspects
  it, because a response that parses fine can still represent a failure.
