# GoodVibes web UI

The GoodVibes web UI is the browser app for GoodVibes. The daemon serves it, so
there is nothing separate to run. In it you chat with the agent, see what is
running and what is waiting for you, browse what GoodVibes remembers, and use
your mail and calendar. It works at phone size and can be installed on a phone's
home screen as an app.

## Open it

The [suite installer](../../docs/installation.md) installs the built web UI and
has the daemon serve it, by default at `http://127.0.0.1:3421`; the installer
prints the address. `goodvibes-daemon webui status` shows where it is served
and who can reach it. It needs no separate WebUI service.

To use it from a phone or another computer, run
`goodvibes-daemon webui enable --lan` so other devices on your network can
reach it, then run `goodvibes pair` and open the QR code's link on the device
or scan it with the sign-in page's camera scanner. In a browser on the
daemon's own machine, `goodvibes pair` before `--lan` prints a link and a
sign-in code for that browser (no QR code, since a phone could not open it).
Pairing, sign-in and every
part of the app are described in the [operator guide](docs/operator-guide.md).
Updates come with the rest of the suite.

## How it fits with the rest of GoodVibes

How the web UI, the daemon that serves it and the terminal programs fit
together, what runs where and why: [How GoodVibes works](../../docs/how-goodvibes-works.md).

See [known limitations](docs/known-limitations.md) for the remaining
integration work, and the [release notes](../../docs/releases/) for what
changed in each release.
