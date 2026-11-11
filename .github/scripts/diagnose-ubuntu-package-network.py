"""Disposable runner diagnosis; never changes resolver/proxy/source settings.

Only isolated Ubuntu APT lists and normal official package installation change
the runner. Private command output is discarded; artifacts contain fixed kinds,
known public hostnames, numeric results and proxy-presence booleans only.
"""
import ipaddress
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HOSTS = ("azure.archive.ubuntu.com", "archive.ubuntu.com", "security.ubuntu.com",
         "ports.ubuntu.com", "packages.microsoft.com", "github.com")
PROXY_NAMES = ("http_proxy", "https_proxy", "all_proxy", "no_proxy",
               "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "APT_CONFIG")
ROLES = ("runner", "root", "apt")


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


def main(report):
    release = dict(line.split("=", 1) for line in Path("/etc/os-release").read_text().splitlines() if "=" in line)
    if release.get("ID", "").strip('"') != "ubuntu" or release.get("VERSION_CODENAME", "").strip('"') != "jammy":
        raise ValueError()
    report["stage"] = "runner-admission"
    status, arch = command(["dpkg", "--print-architecture"])
    arch = arch.strip()
    if status["exitCode"] != 0 or arch not in ("amd64", "arm64") or arch != os.environ.get("DIAGNOSTIC_ARCH"):
        raise ValueError()
    report["architecture"] = arch
    resolver = Path("/etc/resolv.conf").read_text()
    hosts = next((line.split("#", 1)[0].split(":", 1)[1].split() for line in Path("/etc/nsswitch.conf").read_text().splitlines()
                  if line.startswith("hosts:")), [])
    report["resolver"] = {"nameserverCount": len(re.findall(r"(?m)^\s*nameserver\s", resolver)),
                          "searchConfigured": bool(re.search(r"(?m)^\s*(?:search|domain)\s", resolver)),
                          "resolvConfSymlink": Path("/etc/resolv.conf").is_symlink(),
                          "hostsModules": [value for value in hosts if value in ("files", "dns", "resolve", "myhostname", "mdns4_minimal", "mdns")],
                          "otherHostsModules": any(value not in ("files", "dns", "resolve", "myhostname", "mdns4_minimal", "mdns", "[NOTFOUND=return]") for value in hosts)}
    report["stage"] = "proxy-presence"
    report["proxyPresence"] = []
    code = "import json,os;print(json.dumps({name:bool(os.environ.get(name)) for name in " + repr(PROXY_NAMES) + "}))"
    for role in ROLES:
        status, output = command(["python3", "-c", code], role=role)
        presence = json.loads(output) if status["exitCode"] == 0 else {}
        report["proxyPresence"].append({"role": role, **status,
                                       "environment": {name: presence.get(name) is True for name in PROXY_NAMES}})
    status, config = command(["apt-config", "dump"])
    report["aptProxyConfigured"] = {**status, "http": bool(re.search(r"(?mi)^Acquire::http::Proxy", config)),
                                    "https": bool(re.search(r"(?mi)^Acquire::https::Proxy", config))}
    report["stage"] = "dns"
    report["dns"] = []
    for role in ROLES:
        for host in HOSTS:
            status, output = command(["getent", "ahosts", host], role=role)
            addresses = set()
            for line in output.splitlines():
                try:
                    addresses.add(ipaddress.ip_address(line.split()[0]))
                except (ValueError, IndexError):
                    pass
            report["dns"].append({"role": role, "host": host, **status,
                                  "ipv4Answers": sum(value.version == 4 for value in addresses),
                                  "ipv6Answers": sum(value.version == 6 for value in addresses)})
    report["stage"] = "http"
    endpoints = [("azure-http", "http://azure.archive.ubuntu.com/ubuntu/dists/jammy/InRelease"),
                 ("azure-https", "https://azure.archive.ubuntu.com/ubuntu/dists/jammy/InRelease"),
                 ("archive-https", "https://archive.ubuntu.com/ubuntu/dists/jammy/InRelease"),
                 ("security-https", "https://security.ubuntu.com/ubuntu/dists/jammy-security/InRelease"),
                 ("ports-https", "https://ports.ubuntu.com/ubuntu-ports/dists/jammy/InRelease"),
                 ("microsoft-control", "https://packages.microsoft.com/ubuntu/22.04/prod/dists/jammy/InRelease"),
                 ("github-control", "https://github.com/robots.txt")]
    report["http"] = []
    for role in ("runner", "root"):
        for name, url in endpoints:
            if role == "root" and name not in ("archive-https", "ports-https", "microsoft-control"):
                continue
            status, output = command(["curl", "--silent", "--show-error", "--stderr", "/dev/null", "--head",
                                      "--connect-timeout", "5", "--max-time", "10", "--output", "/dev/null",
                                      "--write-out", "%{http_code} %{time_namelookup} %{time_connect} %{time_appconnect} %{time_total}", url], 12, role)
            values = output.split()
            observation = {"role": role, "endpoint": name, **status,
                           "kind": {0: "completed", 5: "proxy-name-resolution-failed", 6: "name-resolution-failed", 7: "connection-failed",
                                    28: "timeout", 35: "tls-handshake-failed", 60: "tls-verification-failed"}.get(status["exitCode"], "unclassified-failure")}
            if len(values) == 5 and re.fullmatch(r"[0-9]{3}", values[0]):
                observation["httpStatus"] = int(values[0])
                times = [float(value) for value in values[1:]]
                if all(math.isfinite(value) and value >= 0 for value in times):
                    observation["timings"] = dict(zip(("dns", "connect", "tls", "total"), times))
            report["http"].append(observation)
    report["stage"] = "signed-ubuntu-apt"
    keyring = "/usr/share/keyrings/ubuntu-archive-keyring.gpg"
    if not Path(keyring).is_file():
        raise ValueError()
    uri = "https://archive.ubuntu.com/ubuntu" if arch == "amd64" else "https://ports.ubuntu.com/ubuntu-ports"
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
        for phase, args, bound in (("signed-index", ["--error-on=any", "update"], 60),
                                    ("official-install", ["install", "--yes", "--no-install-recommends", "bubblewrap", "util-linux"], 90)):
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
    report["stage"] = "real-sandbox"
    probes = [("containment-namespaces", ["bwrap", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "--unshare-net", "/bin/true"]),
              ("daemon-namespaces", ["bwrap", "--die-with-parent", "--new-session", "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
                                     "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "--", "/bin/true"]),
              ("pty", ["script", "--quiet", "--return", "--command", "test -t 0 && test -t 1", "/dev/null"])]
    report["sandbox"] = []
    for name, args in probes:
        status, _ = command(args, 10)
        report["sandbox"].append({"probe": name, **status})
    report["sandboxAvailable"] = all(item["exitCode"] == 0 for item in report["sandbox"])
    report["stage"] = "complete"


if __name__ == "__main__":
    report = {"schema": 1, "diagnosticOnly": True, "qualifiesRelease": False, "stage": "initial"}
    try:
        if len(sys.argv) != 2:
            raise ValueError()
        main(report)
    except Exception as error:
        report["error"] = type(error).__name__ if type(error).__name__ in ("ValueError", "RuntimeError", "OSError", "FileNotFoundError", "PermissionError") else "Error"
    finally:
        if len(sys.argv) == 2:
            with open(sys.argv[1], "x", encoding="utf-8") as destination:
                os.chmod(sys.argv[1], 0o600)
                json.dump(report, destination, indent=2)
                destination.write("\n")
        print(json.dumps(report))
    sys.exit(0 if report.get("aptVerified") is True and report.get("sandboxAvailable") is True and "error" not in report else 1)
