# spinup

Every new [herdr](https://herdr.dev) tab opens a launcher. Pick a tool and it runs in that
tab; press `esc` for a normal shell.

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

Needs `node` on the machine running the herdr server. No dependencies, no build step.

## Configure

```bash
cd "$(herdr plugin config-dir royal-lobster.spinup)"
```

`tools.json` is the menu. `id` and `command` are required; `label`, `desc` and `key` are
optional. Name real binaries — shell aliases don't exist here.

```json
[{ "id": "cc", "command": "claude --permission-mode auto", "desc": "claude", "key": "c" }]
```

`logo.txt` is the banner. Any ASCII art; empty the file to hide it.

## How it works

A `tab.created` hook runs the menu in the new tab's own pane. The menu draws to `/dev/tty` and
prints only the chosen command to stdout, so the shell `exec`s it and the tool replaces the
menu in that same pane — which is what keeps herdr's agent detection working.

There is no keybinding, deliberately: keys are read by the herdr *client*, and a client
driving a remote server cannot resolve a plugin action. Events run on the server, so opening a
tab works everywhere.

## License

MIT
