# tgpilot

Write, run and deploy Telegram Serverless bots — from a terminal, or from a
local web studio that stays on your machine.

Telegram Serverless runs your bot's backend code right on Telegram's
infrastructure: JavaScript modules, a built-in database schema, Mini App
hosting, no servers of your own. tgpilot talks to the platform's cloud API for
you: it scaffolds the project, compares your folder against what is deployed,
pushes changes, runs handlers in the cloud before deploying, applies database
migrations and keeps a full local journal of everything it did.

```text
 tgpilot init        scaffold a project
 tgpilot login       link the folder to your bot
 tgpilot status      what differs from the last sync?   (offline)
 tgpilot diff        the same, line by line             (offline)
 tgpilot push        deploy changed modules + Mini App
 tgpilot run message '{ text: "hi" }'                   run before deploying
 tgpilot migrate     apply pending schema changes to the database
 tgpilot bot         read or edit the bot's own profile
 tgpilot web         open the studio at 127.0.0.1:5177
```

## Install

Node.js 18 or newer.

```bash
npm install -g tgpilot          # from the registry
# or, from a checkout of this repo:
npm install -g .
```

## Getting started

```bash
mkdir mybot && cd mybot
tgpilot init                    # scaffold tgcloud/ + config
tgpilot login                   # paste the access token (stays hidden)
tgpilot push                    # deploy
```

Telegram handles the hosting side from @BotFather: **/mybots → your bot →
Serverless → CLI Access**, copy the token, then `tgpilot login` (or export
`TGPILOT_TOKEN` for scripts and CI).

## The project layout

```
mybot/
  tgcloud/
    schema.js                 database tables (empty exports until you add some)
    handlers/                 message.js etc. — one file per update type
    endpoints/                HTTP-ish endpoints the Mini App can call
    lib/                      shared code, importable by the others
  tgcloud.jsonc               project config (Mini App hosting, optional)
  package.json                npm scripts to your taste
  .tgpilot/                   tgpilot's own state (token, snapshot, journal)
```

Module paths are algebraic: `tgcloud/handlers/message.js` deploys as
`handlers/message`. Only `.js` files inside `tgcloud/` deploy; everything else
in the folder is yours (docs, configs, a frontend build).

> The Serverless runtime speaks JavaScript. The studio happily opens any text
> file in the project; the deployable set stays the module files.

## Everyday flow

1. Edit modules (CLI editor or `tgpilot web`).
2. `tgpilot run message '{ text: "hi" }'` — run a handler in the cloud with
   live logs, without deploying anything.
3. `tgpilot push` — sends changed files, prunes deleted ones; anything
   deployed in the cloud that is missing locally is listed before it goes.
4. Changed `schema.js`? `tgpilot migrate` walks you through the database
   changes: safe ones in one batch, risky ones one by one, manual ones with a
   note. (`--safe`, `--yes` and `--dry-run` exist for CI.)

### Targeted pushes

```bash
tgpilot push handlers/message         # only that module
tgpilot push handlers/                # everything under handlers/
tgpilot push dist/                    # only the Mini App build
```

## Mini App

BotFather can host your Mini App from the same project. Point the `static`
block at a build output folder:

```jsonc
{
  "static": { "source": "dist", "spa": true }
}
```

`tgpilot push` then uploads the build (only the files that actually changed),
keeps a hash-based snapshot in `.tgpilot/static.json` and prints the public
URL of the Mini App. `"static": false` takes the build back down.

## The bot's own profile

A bot is more than its code. `tgpilot bot` shows what Telegram holds — the
name, the two descriptions and the button beside the message field — and the
same command changes them:

```bash
tgpilot bot                          # the profile as it is right now
tgpilot bot name "Weather Fox"
tgpilot bot description "Hourly weather, in one short message."
tgpilot bot short "Weather, hourly."
tgpilot bot menu https://example.com/app Open   # the button opens a Mini App
tgpilot bot menu commands                      # or the command list
tgpilot bot menu off                           # or Telegram's own button
```

The studio has the same thing in **Bot profile** on the home page.

These calls run inside the platform, which already holds the bot's
credentials: the access token stays where it is, and nothing new is saved on
this machine.

## Backups

A copy of the project, safe to roll back to. Take one before a big change;
if the bot breaks, put it back with one command.

```bash
tgpilot backup --label "working version"   # save
tgpilot backups                            # list
tgpilot restore 20240102-153000-working-version   # put it back
```

A restore first saves the state that is there now, so nothing is ever lost.
The studio has the same thing in the **Backups** card on the home page.

## The studio's language and theme

The studio speaks English, Persian, Chinese and Russian, and it can follow
the system's light or dark theme, or take the **Luxury** one — warm obsidian
and champagne gold, with a background that breathes, light that travels
across the title and buttons a band of light crosses on hover (it holds still
when the system asks for reduced motion). Both are settings of the person
using it (the **Settings** button in the top bar), so they live in the
browser, not in the project. The first visit picks the language the browser
asks for.

## Sync: what the bot knows comes back

While the *Deploy & status* view is open, the studio keeps an eye on the bot
and says so when it moved on — a banner offers to bring the changes in.

A bot can be changed from a phone or from another machine. **Sync from the
bot** in the studio asks the cloud what it holds and brings it into the
folder — new files included. Files the cloud never knew (your own helpers and
notes) are never touched, and a backup is taken before anything is written.

```bash
tgpilot pull       # the same thing in the terminal
```

Without a linked bot the studio shows nothing and writes nothing: the folder
belongs to a bot, not to the tool. The folder you see belongs to the bot that is active: switching
brings that bot's files in and puts the others away, and unlinking a bot takes
its files out of the folder with it. Linking a second bot does not touch the
folder — it only joins.

## The web studio

```bash
tgpilot web          # → http://127.0.0.1:5177
```

File tree, editor, Deploy (with a review dialog before anything is sent),
Run, Migrations, Webhook state and the full journal — all local. The server
binds to `127.0.0.1` and keeps the access token on disk; the browser never
sees it. `--port` or `TGPILOT_WEB_PORT` changes the port.

## How sync works

- `tgpilot fetch` refreshes the snapshot in `.tgpilot/snapshot` — the baseline
  `status`/`diff`/`reset` compare against — without touching your files.
- `tgpilot pull` writes the cloud state into the folder, asking per file
  (untouched starter files are replaced without asking).
- `tgpilot reset` returns changed or deleted files to the snapshot (offline).
- `push` refuses when the cloud has content a folder has never seen; either
  `fetch`/`push --force` resolves the conflict.

## Environment

| variable | meaning |
| --- | --- |
| `TGPILOT_TOKEN` | access token override (`app<id>:<secret>`) — handy in CI |
| `TGCLOUD_TOKEN` | respected as a fallback for the same purpose |
| `TGPILOT_API_URL` / `TGCLOUD_API_URL` | point the client at another server |
| `TGPILOT_BETA=1` | use the `/beta` route on the server |
| `TGPILOT_DEBUG=1` | log every HTTP request/response to stderr |
| `TGPILOT_ASSUME_TTY=1` | treat piped stdio as interactive (CI + prompts) |
| `TGPILOT_WEB_PORT`, `TGPILOT_WEB_HOST` | port/host of `tgpilot web` |
| `TGPILOT_PROXY` | send every cloud request through a proxy: `http://host:port` or `socks5://host:port` (credentials allowed: `socks5://user:pass@host:port`) |
| `HTTPS_PROXY` / `ALL_PROXY` | used as a fallback when `TGPILOT_PROXY` is not set |
| `TGPILOT_TIMEOUT` | how long a cloud request may take, in milliseconds (default 20000) |
| `TGPILOT_IP_FAMILY` | force the IP family for cloud requests: `4` or `6` — useful when a filtered DNS hijacks IPv4 but IPv6 still works |
| `TGPILOT_DOH=1` | resolve the cloud over DNS-over-HTTPS and connect to the genuine address |
| `TGPILOT_DOH_URL` | use a specific DNS-over-HTTPS resolver (e.g. a local `cloudflared`) |

### Behind a filter or a VPN

If `cloud.telegram.org` does not answer — a filtered DNS, a blocked route, a
network that drops TLS — the CLI and the studio say so in plain words and
`tgpilot ping` shows where the chain breaks:

```bash
tgpilot ping                       # URL, proxy, DNS, reachability
export TGPILOT_PROXY=http://127.0.0.1:10809   # your proxy app's HTTP port
tgpilot ping                       # ✓ Reach: the cloud answered in 210 ms
```

Both HTTP CONNECT proxies and SOCKS5 proxies work; the kind is detected on
its own, so the address of your local proxy port is enough.

You do not have to remember the port: `tgpilot ping` looks for a proxy that
is already running on this machine (1080, 10808, 10809, 7890, 8080, …),
names it and tells you what to set:

```
✓ Local proxy found: socks5://127.0.0.1:10808
  Hint: use it with TGPILOT_PROXY=socks5://127.0.0.1:10808
```

The studio offers the same proxy with one click ("use socks5://…") in the
Network card.

The studio can do the same without touching the environment: the **Network**
card on the home page stores a proxy (or another server address) in the
project and tests the chain with one click.

On a remote machine there is usually no proxy running on it. Either start one
there, or tunnel your own machine's proxy through SSH:

```bash
ssh -R 10809:127.0.0.1:10809 user@server   # then use socks5://127.0.0.1:10809
```

### Hijacked DNS

Some networks answer with a private address (`10.x`, `192.168.x`) where a
public one belongs — the DNS was hijacked, and that route can never work.
`tgpilot ping` says so.

Three ways out, in order of how little you have to change:

1. **DNS over HTTPS** — turn it on in the studio (**Network → DNS over
   HTTPS**) or with `TGPILOT_DOH=1`. The real address is then asked from a
   resolver over HTTPS, where the filter has no say, and tgpilot connects to
   that address directly.
2. **Force the other family** — `TGPILOT_IP_FAMILY=6` (or the **IP family**
   dropdown) when only the IPv6 answer is genuine.
3. **A proxy** — `TGPILOT_PROXY=…`; the proxy resolves the name for you.

`TGPILOT_DOH_URL` points the resolver somewhere else (a local
`cloudflared`/`dnscrypt-proxy`, for example).

`tgpilot ping --probe` additionally opens direct connections to the cloud
addresses and to a DNS-over-HTTPS resolver to show which route works. Those
extra connections are **not** made by default — a VPN client can react to
them — and the studio's deep route check is a checkbox you have to tick.

The journal of everything tgpilot did lives in `.tgpilot/logs/`; read it with
`tgpilot logs`, filter with `-n`, `--level`, `--scope`, and `--clear` to wipe.

## Development

```bash
npm test            # unit tests + end-to-end tests against a mock cloud
node bin/tgpilot.js # run the CLI without installing
```

## License

MIT — see [LICENSE](LICENSE).
