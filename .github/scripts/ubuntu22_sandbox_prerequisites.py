"""Official signed Ubuntu22/jammy sandbox prerequisites; no DNS/proxy changes.
Independent transport was measured on both original runner architectures.
No alternate signing key, unsigned package path or generic package installation.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

CANONICAL_HOSTS = ("azure.archive.ubuntu.com", "archive.ubuntu.com", "security.ubuntu.com",
                   "ports.ubuntu.com", "packages.microsoft.com", "github.com")
HOSTS = CANONICAL_HOSTS + ("mirrors.edge.kernel.org", "mirrors.mit.edu")
SOURCES = {"canonical": {"amd64": "https://archive.ubuntu.com/ubuntu", "arm64": "https://ports.ubuntu.com/ubuntu-ports"},
           "independent": {"amd64": "https://mirrors.edge.kernel.org/ubuntu", "arm64": "https://mirrors.mit.edu/ubuntu-ports"}}


def archive_source(arch, mode):
    if mode not in SOURCES or arch not in SOURCES[mode]:
        raise ValueError()
    return SOURCES[mode][arch]


def command(args, seconds=6, role="runner"):
    prefix = [] if role == "runner" else ["sudo", "-n"] + (["-u", "_apt"] if role == "apt" else [])
    # Run the timeout as the same user as its child, including privileged APT.
    # It owns and kills its complete command group, not just the sudo parent.
    argv = prefix + ["timeout", "--signal=KILL", str(seconds) + "s"] + args
    started = time.monotonic()
    with tempfile.TemporaryFile() as output:
        result = subprocess.run(argv, stdout=output, stderr=subprocess.STDOUT, check=False)
        size = output.tell()
        output.seek(0)
        text = output.read(65_536).decode("utf-8", errors="replace")
    return {"exitCode": result.returncode, "seconds": round(time.monotonic() - started, 3),
            "outputTruncated": size > 65_536}, text


def apt_kind(code, output):
    if code == 0:
        return "success"
    if code in (124, 137, -9):
        return "timeout"
    if "Temporary failure resolving" in output or "Could not resolve" in output:
        return "name-resolution-failed"
    if any(value in output for value in ("NO_PUBKEY", "not signed", "couldn't be verified", "GPG error")):
        return "signature-refused"
    if "Hash Sum mismatch" in output or "File has unexpected size" in output:
        return "integrity-refused"
    if "Certificate verification failed" in output:
        return "tls-verification-failed"
    if "404  Not Found" in output or "404 Not Found" in output:
        return "archive-path-not-found"
    if "Unable to locate package" in output:
        return "package-unavailable"
    if any(value in output for value in ("Could not connect", "Connection timed out", "Connection failed")):
        return "connection-failed"
    return "unclassified-failure"


def ubuntu22_architecture():
    release = dict(line.split("=", 1) for line in Path("/etc/os-release").read_text().splitlines() if "=" in line)
    if release.get("ID", "").strip('"') != "ubuntu" or release.get("VERSION_CODENAME", "").strip('"') != "jammy":
        raise ValueError()
    status, arch = command(["dpkg", "--print-architecture"])
    arch = arch.strip()
    if status["exitCode"] != 0 or arch not in ("amd64", "arm64"):
        raise ValueError()
    return arch


def install_signed_packages(arch, mode="independent", packages=("bubblewrap", "util-linux")):
    if tuple(packages) not in (("bubblewrap",), ("bubblewrap", "util-linux")):
        raise ValueError()
    uri = archive_source(arch, mode)
    report = {}
    keyring = "/usr/share/keyrings/ubuntu-archive-keyring.gpg"
    if not Path(keyring).is_file():
        raise ValueError()
    report["apt"] = {"source": uri, "suites": ["jammy", "jammy-updates", "jammy-security"],
                     "component": "main", "signedBy": "installed-ubuntu-archive-keyring", "observations": []}
    with tempfile.TemporaryDirectory(prefix="goodvibes-apt-diagnostic-", dir=os.environ["RUNNER_TEMP"]) as root:
        # _apt must be able to traverse this isolated, nonsecret source/list root.
        os.chmod(root, 0o755)
        source = Path(root) / "ubuntu.list"
        source.write_text("".join("deb [signed-by=" + keyring + "] " + uri + " " + suite + " main\n" for suite in report["apt"]["suites"]))
        lists = Path(root) / "lists"
        lists.mkdir(mode=0o755)
        options = ["-o", "Dir::Etc::sourcelist=" + str(source), "-o", "Dir::Etc::sourceparts=-",
                   "-o", "Dir::State::lists=" + str(lists), "-o", "APT::Get::List-Cleanup=0",
                   "-o", "Acquire::Retries=0", "-o", "Acquire::http::Timeout=8", "-o", "Acquire::https::Timeout=8",
                   "-o", "Acquire::AllowInsecureRepositories=false", "-o", "Acquire::AllowDowngradeToInsecureRepositories=false",
                   "-o", "APT::Get::AllowUnauthenticated=false"]
        for phase, args, bound in (("signed-index", ["--error-on=any", "update"], 90),
                                    ("official-install", ["install", "--yes", "--no-install-recommends"] + list(packages), 90)):
            status, output = command(["apt-get"] + options + args, bound, "root")
            report["apt"]["observations"].append({"phase": phase, **status, "kind": apt_kind(status["exitCode"], output),
                                                   "mentionedHosts": [host for host in HOSTS if host in output]})
            if status["exitCode"] != 0:
                break
        # APT creates root-owned list children; clean only this exact private root.
        status, _ = command(["rm", "-rf", "--", str(lists)], role="root")
        if status["exitCode"] != 0:
            raise RuntimeError()
    report["aptVerified"] = len(report["apt"]["observations"]) == 2 and all(item["exitCode"] == 0 for item in report["apt"]["observations"])
    return report


if __name__ == "__main__":
    report = {"schema": 1, "scope": "Ubuntu22-sandbox-prerequisites-only"}
    try:
        arch = ubuntu22_architecture()
        report["architecture"] = arch
        report.update(install_signed_packages(arch, packages=tuple(sys.argv[1:])))
    except Exception as error:
        report["error"] = type(error).__name__ if type(error).__name__ in ("ValueError", "RuntimeError", "OSError", "FileNotFoundError", "PermissionError") else "Error"
    print(json.dumps(report))
    sys.exit(0 if report.get("aptVerified") is True and "error" not in report else 1)
