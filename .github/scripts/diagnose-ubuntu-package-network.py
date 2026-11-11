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
import sys
from pathlib import Path

from ubuntu22_sandbox_prerequisites import CANONICAL_HOSTS, archive_source, command, install_signed_packages, ubuntu22_architecture

PROXY_NAMES = ("http_proxy", "https_proxy", "all_proxy", "no_proxy",
               "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "APT_CONFIG")
ROLES = ("runner", "root", "apt")


def main(report):
    report["stage"] = "runner-admission"
    arch = ubuntu22_architecture()
    if arch != os.environ.get("DIAGNOSTIC_ARCH"):
        raise ValueError()
    report["architecture"] = arch
    mode = os.environ.get("DIAGNOSTIC_MIRROR_MODE") or "canonical"
    uri = archive_source(arch, mode)
    report["mirrorMode"] = mode
    dns_hosts = CANONICAL_HOSTS if mode == "canonical" else (uri.split("/")[2], "packages.microsoft.com", "github.com")
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
        for host in dns_hosts:
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
    if mode == "independent":
        # The canonical-host failures are already measured separately. Probe
        # only this architecture's static mirror plus the unchanged controls.
        endpoints = [("independent-mirror-https", uri + "/dists/jammy/InRelease")] + endpoints[-2:]
    report["http"] = []
    for role in ("runner", "root"):
        for name, url in endpoints:
            if role == "root" and name not in ("archive-https", "ports-https", "independent-mirror-https", "microsoft-control"):
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
    report.update(install_signed_packages(arch, mode))
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
