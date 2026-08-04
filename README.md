# spinup

A start screen for every new [herdr](https://herdr.dev) tab. Pick a tool and it runs in that
tab. Press `esc` and you get a normal shell.

```
                    ███████╗██████╗ ██╗███╗   ██╗██╗   ██╗██████╗
                    ██╔════╝██╔══██╗██║████╗  ██║██║   ██║██╔══██╗
                    ███████╗██████╔╝██║██╔██╗ ██║██║   ██║██████╔╝
                    ╚════██║██╔═══╝ ██║██║╚██╗██║██║   ██║██╔═══╝
                    ███████║██║     ██║██║ ╚████║╚██████╔╝██║
                    ╚══════╝╚═╝     ╚═╝╚═╝  ╚═══╝ ╚═════╝ ╚═╝

                    ~/code/my-project

                     ❯ 1  fresh                        editor
                       2  tuicr                        review
                       3  cc                           claude
                       4  cdx                          codex

                       click · ↑↓ · 1234 · esc
```

## Install

```bash
herdr plugin install Royal-lobster/herdr-spinup
```

Needs `node` on the machine running the herdr **server**. No dependencies, no build step.

Optionally, to skip herdr's "name this tab" dialog on the way in:

```toml
[ui]
prompt_new_tab_name = false
```

## Your tools

The four above are only defaults. Edit the copy seeded in your config directory:

```bash
$EDITOR "$(herdr plugin config-dir royal-lobster.spinup)/tools.toml"
```

```toml
[[tools]]
id = "cc"                                   # required, unique
command = "claude --permission-mode auto"   # required, a shell command line
desc = "claude"                             # optional, dim text on the right
label = "cc"                                # optional, defaults to id
key = "c"                                   # optional shortcut, defaults to the row number
```

Shell **aliases don't exist here** — name the real binary. A malformed entry is skipped, and
if the whole file fails to parse the bundled defaults are used, so a bad edit can't leave you
with an empty menu.

## How it works

One event hook, and that's the whole plugin:

```
tab.created ──▶ pane run  sh -c 'CMD=$(node picker.js); [ -n "$CMD" ] && exec $CMD'
                          │                              │
                          │ menu draws to /dev/tty        │ chosen command on stdout
                          └── esc → prints nothing ───────┴─▶ shell prompt
```

The menu runs in the new tab's own pane and prints only the chosen command to stdout, so the
shell `exec`s it and the tool *replaces* the menu in that same pane. Nothing else is created
and no existing tab is touched. Because it's a real `exec`, herdr's process-name agent
detection sees `claude` or `codex` directly and they land in the agent panel with full
lifecycle status.

Colours are ANSI 0–15, reverse video and dim only, so the menu follows your herdr theme.

## Notes for plugin authors

Things that cost real time to work out:

- **Events work from a remote client; keybindings do not.** Keys are read by the *client*, and
  a client driving a remote server has no local plugin registry and no local server, so it can
  neither resolve nor run a plugin action — the chord is dropped before it reaches the server,
  silently, with nothing in the plugin log. Installing the plugin on the client doesn't help:
  the registry entry exists but there's no server to execute it. Events are raised and handled
  entirely on the server.
- **Read the event payload, don't guess it.** `tab.created` carries `data.tab.tab_id`;
  `tab.focused` carries only `data.tab_id` and `data.workspace_id`, no label. Neither is
  documented field-by-field.
- **`herdr` reports API failures in the payload**, as `{error:{code,message}}` — a response
  that parses fine can still be a failure.
- **Failures are silent by default.** Event hooks report only an exit code, pane commands have
  no plugin log at all, and `type = "shell"` keybindings run detached. Log to a file while
  developing.
- **Pane commands need `$HERDR_PLUGIN_ROOT`.** The plugin directory is the working directory
  for *actions* only.
- **`herdr config check` validates syntax, not existence.** It catches unknown config keys and
  collisions with built-in keybindings (`prefix+e/r/c/d` are taken), but happily accepts a
  plugin action id that doesn't exist.
- If you do need a transient pane, prefer **`overlay` over `popup`**: a popup is a singleton
  that herdr's own dialogs occupy, is absent from `pane list`, and never receives
  `HERDR_PANE_ID`.

## Optional: name tabs after your first prompt

`tab-title.js` is a `UserPromptSubmit` hook for Claude Code and Codex. On the first prompt of a
session it renames the tab to a short version of it, so `cc` becomes `fix the flaky auth
test…`. Add to `~/.claude/settings.json` and/or `~/.codex/hooks.json`:

```json
{ "type": "command", "command": "node \"/path/to/herdr-spinup/tab-title.js\"" }
```

It only overwrites a bare tab number or a tool name, which keeps hand-named tabs safe and
limits it to the first message. It writes nothing to stdout — for `UserPromptSubmit`, stdout is
injected into the model's context.

## Development

```bash
herdr plugin link /path/to/herdr-spinup
herdr plugin log list --plugin royal-lobster.spinup
```

| File | |
| --- | --- |
| `herdr-plugin.toml` | the manifest: one event |
| `tab-event.js` | the hook — runs the menu in the new tab |
| `picker.js` | the menu |
| `lib.js` | reads `tools.toml`, calls the herdr CLI |
| `tools.toml` | default tools, seeded into your config dir |
| `tab-title.js` | optional agent hook, independent of the rest |

## License

MIT
