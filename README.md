# pietin

Run `/rc` in a [Pi](https://pi.dev) session, get a URL, and watch or drive that
exact terminal from a browser anywhere — your theme, extensions and
customizations intact.

This repository is the Pi extension: the client that taps Pi's output and talks
to the relay at [pietin.sh](https://pietin.sh). It is the whole of what runs on
your machine, so you can read all of it before you install it.

## Install

```bash
pi install git:github.com/teampietin/pietin
```

Then start a Pi session and log in once:

```
/rc login
```

Pi shows a URL. Open it in a browser, sign in, and click Approve. The machine
token is written to `~/.pi/pietin.json` with mode 0600. You do this once per
machine.

## Use

| Command | What it does |
| --- | --- |
| `/rc` | Share this session. Pi prints the browser URL. |
| `/rc stop` | Stop sharing. The browser tab goes dead. |
| `/rc login` | Log this machine in (or log it in again). |

The browser shows the live terminal. You can send a prompt, abort a running
turn, and type into the session. Only your own account can open your sessions.

## What it does to your session

- It taps Pi's stdout and streams the bytes to the relay. It does not change
  what Pi prints.
- While a browser is attached, the browser can claim the render size. Pi shows
  a banner when this happens. `/rc stop` gives the size back.
- It sends nothing until you run `/rc`, and nothing after `/rc stop`.

## Configuration

All of these are optional.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PIETIN_RELAY_URL` | `wss://pietin.sh/ws/extension` | The relay to dial. Point it at your own relay to self-host. |
| `PIETIN_PUBLIC_URL` | derived from the relay URL | The base of the URL that `/rc` prints. |
| `PIETIN_TOKEN` | — | A machine token, instead of `/rc login`. |
| `PIETIN_TOKEN_FILE` | `~/.pi/pietin.json` | Where the token is stored. |

## Layout

```
src/            The extension. index.ts registers /rc.
src/protocol/   The wire protocol (zod schemas), shared with the relay.
src/testdata/   Golden frames the protocol must round-trip.
```

`src/` is generated from the pietin development repository, where the extension,
the relay and the protocol are tested together. Report issues here — that is
what this repository is for.

## Develop

```bash
npm install
npm test          # protocol round-trip + size-override unit tests
npm run typecheck
```

To try a local checkout without installing it:

```bash
pi -e ./src/index.ts
```

## Security

Pi packages run with full system access. Read the source before you install
this one, or any other. There are six files in `src/`.

## License

MIT. See [LICENSE](LICENSE).
