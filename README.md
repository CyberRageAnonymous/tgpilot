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

The journal of everything tgpilot did lives in `.tgpilot/logs/`; read it with
`tgpilot logs`, filter with `-n`, `--level`, `--scope`, and `--clear` to wipe.

## Development

```bash
npm test            # unit tests + end-to-end tests against a mock cloud
node bin/tgpilot.js # run the CLI without installing
```

## License

MIT — see [LICENSE](LICENSE).
