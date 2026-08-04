# spinup

A start-screen launcher for [herdr](https://herdr.dev). Make a new tab, pick a tool, and it
opens in its own tab in the current directory.

```
                    ███████╗██████╗ ██╗███╗   ██╗██╗   ██╗██████╗
                    ██╔════╝██╔══██╗██║████╗  ██║██║   ██║██╔══██╗
                    ███████╗██████╔╝██║██╔██╗ ██║██║   ██║██████╔╝
                    ╚════██║██╔═══╝ ██║██║╚██╗██║██║   ██║██╔═══╝
                    ███████║██║     ██║██║ ╚████║╚██████╔╝██║
                    ╚══════╝╚═╝     ╚═╝╚═╝  ╚═══╝ ╚═════╝ ╚═╝

                    ~/code/my-project

                     ❯ 1    fresh                      editor
                       2    tuicr                      review
                       3  ✓ cc                         claude
                       4    cdx                         codex

                       click · ↑↓ · 1234 · esc
```

## Install

```bash
herdr plugin install Royal-lobster/herdr-spinup
```

Requires `node` on the machine running the herdr **server**. No build step.

## Your tools

Tools are yours to define — the four above are just defaults. Edit the copy seeded in your
config directory:

```bash
$EDITOR "$(herdr plugin config-dir royal-lobster.spinup)/tools.toml"
```

```toml
[[tools]]
id = "fresh"          # required, unique. Identifies the pane so a running tool is reused.
command = "fresh"     # required. A shell command line — quoting and flags work as usual.
desc = "editor"       # optional. Dim text on the right.
label = "fresh"       # optional, defaults to id. Shown in the picker and as the tab name.
key = "e"             # optional single-character shortcut. Defaults to the row number.
```

Two things to know:

- **Shell aliases don't exist here.** Name the real binary — `command = "claude --permission-mode auto"`,
  not `cc`.
- A malformed entry is skipped rather than fatal, and if the whole file fails to parse the
  bundled defaults are used, so a bad edit can't leave you with an empty menu.

## Triggering it

**Make a new tab.** That's the launcher — no keybinding involved.

To skip herdr's "name this tab" dialog on the way, set this in the config of whichever
herdr reads your UI settings:

```toml
[ui]
prompt_new_tab_name = false
```

The plugin also declares `prefix+space` (menu) and `prefix+shift+s` (start everything), plus
CLI entry points:

```bash
herdr plugin action invoke royal-lobster.spinup.picker
herdr plugin action invoke royal-lobster.spinup.all
```

### Keybindings do not work from a remote client

If you drive a remote server (`herdr --remote host`), the manifest's keybindings will never
fire, and neither will a `type = "plugin_action"` binding in your client's config. Keys are
read by the *client*, and a remote client has **no local plugin registry and no local
server** — so it can neither resolve a plugin action nor run one:

```
$ herdr plugin list                    # on the client
No plugins installed.
$ herdr plugin log list --plugin x
server_not_running: no herdr server is running at …
```

The chord is dropped client-side and never reaches the server, silently — nothing appears in
the server's plugin log. Installing the plugin on the client doesn't help either: the
registry entry exists but there's no server to execute the action.

Workarounds, in order of preference:

1. **Use the new-tab trigger.** Events are raised and handled entirely on the server, so this
   path is unaffected. This is why it's the recommended trigger.
2. **Bind a hotkey outside herdr** (Raycast, skhd, Karabiner) to
   `ssh -n host /path/to/herdr plugin action invoke royal-lobster.spinup.picker`. A multiplexed SSH
   round trip is ~0.2s, and it works whether or not herdr is focused.

## Behaviour

- Tools launch in the cwd of the pane the trigger fired from.
- A tool already running **in that same cwd** is focused instead of relaunched, so repeated
  triggers don't pile up tabs. Switching projects gets you a fresh set. Running tools show
  dimmed with a `✓`.
- Picking a tool from a new tab closes that now-redundant empty tab. Pressing `esc` leaves it
  alone.
- One tool failing doesn't block the others; the summary toast names what failed.

`tuicr` exits immediately outside a git/jj/hg repository — that's tuicr, not the plugin.

## Automatic tab titles

`tab-title.js` is a `UserPromptSubmit` hook for Claude Code and Codex. On the first prompt of
a session it renames the enclosing herdr tab to a short version of that prompt, so `cc`
becomes `fix the flaky auth test…`. Add to `~/.claude/settings.json` and/or
`~/.codex/hooks.json`:

```json
{ "type": "command", "command": "node \"/path/to/herdr-spinup/tab-title.js\"" }
```

It only overwrites labels that are still a bare tab number or a tool name, which is what
limits it to the first message and keeps hand-named tabs safe. It writes nothing to stdout —
for `UserPromptSubmit`, stdout is injected into the model's context.

## Notes for plugin authors

Things that cost real time to work out, in case they save you some:

- **`[[panes]]` beats `tab create` + `agent start`.** Panes created through the plain socket
  API aren't registered in the attached client's UI state: herdr logs `PaneDied for unknown
  pane` and SIGHUPs the agent as soon as the client reconciles focus, so agent tabs vanish
  seconds after opening. Plugin-owned panes are persistent.
- **`overlay`, not `popup`,** for transient UI. A popup is a singleton — herdr's own "new tab"
  dialog occupies the same slot and blocks yours with `popup already open` — is absent from
  `pane list`/`api snapshot`, never receives `HERDR_PANE_ID`, and is centred against the whole
  window so it sits off-centre when the sidebar is open. `width`/`height` are accepted only
  for `popup`.
- **Pane commands need `$HERDR_PLUGIN_ROOT`.** The plugin directory is the working directory
  for *actions* only. A pane opened with an explicit `--cwd` runs there, so
  `command = ["node", "picker.js"]` dies with `Cannot find module`.
- **One entrypoint, command via `--env`.** `sh -c 'exec $SPINUP_CMD'` lets user-defined tools
  work without editing the manifest — which matters because an installed plugin's manifest is
  a managed checkout. `exec` keeps herdr's process-name agent detection working.
- **Check the event payload, don't guess it.** `tab.created` carries
  `data.tab.tab_id`; `tab.focused` carries only `data.tab_id` and `data.workspace_id` — no
  label. Neither is documented field-by-field.
- **`herdr` reports API failures in the payload**, as `{error:{code,message}}`. A response that
  parses fine can still be a failure.
- **Failures are silent by default.** Event hooks report only an exit code, pane commands have
  no plugin log at all, and `type = "shell"` keybindings run detached. Log to a file while
  developing.
- **`herdr config check` validates syntax, not existence.** It flags unknown config keys and
  keybinding collisions with built-ins (`prefix+e/r/c/d` are already taken), but happily
  accepts a plugin action id that doesn't exist.

## Development

```bash
herdr plugin link /path/to/herdr-spinup
herdr plugin log list --plugin royal-lobster.spinup
```

Plain JavaScript on Node, no dependencies and no build step — the herdr CLI emits JSON for
everything, which is the whole API surface this needs.

## License

MIT
