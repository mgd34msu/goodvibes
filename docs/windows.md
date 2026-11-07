# Windows installation

Use GoodVibes inside a WSL2 Linux distribution. Native Windows binaries are not
currently provided by this installer; Git Bash, MSYS and Cygwin do not replace
the required Linux environment.

Open the Linux distribution's terminal and run:

```sh
curl -fsSL https://goodvibes.sh/install.sh | sh
```

The installer selects the Linux release for that environment and installs the
TUI, Agent, daemon and WebUI from this monorepo. Run the terminal applications
inside WSL2. Services require a working user service manager; use `--no-service`
when you intend to start the daemon yourself.

See [installation and updates](installation.md) for version selection,
configuration, update behavior and uninstall options.
