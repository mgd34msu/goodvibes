# Windows support

Use GoodVibes inside a WSL2 Linux distribution. Native Windows binaries are not
currently provided; Git Bash, MSYS and Cygwin do not replace the required Linux
environment.

In the Linux distribution's terminal, install with the release installer:

```sh
curl -fsSL https://goodvibes.sh/install.sh | sh
```

The installer selects the Linux release for that environment. Run the terminal
applications inside WSL2. Services need a working user service manager; use
`--no-service` when you intend to start the daemon yourself.

See [installation and updates](../../../docs/installation.md) for version
selection, configuration, update behavior and uninstall options.
