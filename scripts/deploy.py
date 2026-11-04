"""Deploy the committed CRM source through Docker and the existing host Nginx.

SSH and administrative Supabase secrets are local inputs and are never uploaded.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import stat
import subprocess
import sys
import tarfile
import time
from datetime import datetime, timezone

try:
    import paramiko
except ImportError:
    print("Missing deployment dependency: python -m pip install paramiko", file=sys.stderr)
    raise SystemExit(1)


REPO = Path(__file__).resolve().parents[1]
CACHE = REPO / ".deploy"
BASE = "/opt/mini-crm"
SECRET_VALUES: list[str] = []


class DeployError(Exception):
    pass


def scrub(value: str) -> str:
    for secret in SECRET_VALUES:
        if secret:
            value = value.replace(secret, "[REDACTED]")
    return value


def q(value: str) -> str:
    return shlex.quote(value)


def note(message: str) -> None:
    print(message, flush=True)


def read_env() -> dict[str, str]:
    path = REPO / ".env"
    if not path.is_file():
        raise DeployError("Missing local .env file.")
    values = {}
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        match = re.match(r"\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$", line)
        if not match:
            continue
        name, value = match.groups()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        else:
            value = value.split(" #", 1)[0].strip()
        values[name] = value
    for name, value in values.items():
        if re.search(r"SECRET|SERVICE_ROLE|PASSWORD|TOKEN", name, re.I):
            SECRET_VALUES.append(value)
    for _ in range(5):
        for name, value in values.items():
            values[name] = re.sub(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}", lambda m: values.get(m[1], m[0]), value)
    return values


def public_env(values: dict[str, str], sha: str) -> str:
    url = values.get("VITE_SUPABASE_URL") or values.get("SUPABASE_URL", "")
    key = values.get("VITE_SUPABASE_PUBLISHABLE_KEY") or values.get("SUPABASE_PUBLISHABLE_KEY", "")
    if not re.fullmatch(r"https://[a-z0-9-]+\.supabase\.(?:co|in)/?", url):
        raise DeployError("Invalid hosted Supabase URL.")
    if not re.fullmatch(r"sb_publishable_[A-Za-z0-9_-]+", key):
        raise DeployError("A Supabase publishable key is required for the frontend build.")
    return f"VITE_SUPABASE_URL={url.rstrip('/')}\nVITE_SUPABASE_PUBLISHABLE_KEY={key}\nRELEASE_TAG={sha}\n"


def ssh_config(path: Path) -> dict:
    lines = path.read_text(encoding="utf-8-sig").splitlines()
    if not lines:
        raise DeployError("SSH credentials file is empty.")
    args = shlex.split(lines[0].strip())
    if not args or Path(args[0]).name.lower() not in ("ssh", "ssh.exe"):
        raise DeployError("The first ssh.txt line must be an ssh command.")
    config = {"port": 22, "hostname": None, "username": None, "key_filename": None}
    index = 1
    while index < len(args):
        arg = args[index]
        if arg in ("-p", "-l", "-i"):
            if index + 1 >= len(args):
                raise DeployError("Incomplete SSH option.")
            value = args[index + 1]
            index += 2
        elif re.match(r"^-[pli].+", arg):
            value, arg = arg[2:], arg[:2]
            index += 1
        elif arg.startswith("-"):
            raise DeployError("Only SSH -p, -l and -i options are supported.")
        else:
            if config["hostname"] is not None:
                raise DeployError("Remote commands are not allowed in ssh.txt.")
            if "@" in arg:
                config["username"], arg = arg.rsplit("@", 1)
            config["hostname"] = arg.strip("[]")
            index += 1
            continue
        if arg == "-p":
            config["port"] = int(value)
        elif arg == "-l":
            config["username"] = value
        else:
            identity = Path(os.path.expanduser(value))
            config["key_filename"] = str(identity if identity.is_absolute() else REPO / identity)
    if not config["hostname"] or not config["username"] or not 1 <= config["port"] <= 65535:
        raise DeployError("SSH hostname, username and valid port are required.")
    password = lines[1].strip() if len(lines) > 1 else None
    if password:
        password = re.sub(r"^(?:password|pass|пароль)\s*[:=]\s*", "", password, flags=re.I)
        SECRET_VALUES.append(password)
    config["password"] = password or None
    return config


class PinFirstHostKey(paramiko.MissingHostKeyPolicy):
    def __init__(self, known_hosts: Path, expected: str | None):
        self.known_hosts = known_hosts
        self.expected = expected

    def missing_host_key(self, client, hostname, key):
        fingerprint = "SHA256:" + base64.b64encode(hashlib.sha256(key.asbytes()).digest()).decode().rstrip("=")
        if self.expected and fingerprint != self.expected:
            raise DeployError("SSH server fingerprint does not match --fingerprint.")
        client.get_host_keys().add(hostname, key.get_name(), key)
        client.save_host_keys(str(self.known_hosts))
        note(f"Pinned first SSH host key: {fingerprint}")


class Server:
    def __init__(self, credentials: Path, fingerprint: str | None):
        config = ssh_config(credentials)
        CACHE.mkdir(exist_ok=True)
        known_hosts = CACHE / "ssh-known-hosts"
        self.client = paramiko.SSHClient()
        self.client.load_system_host_keys()
        if known_hosts.exists():
            self.client.load_host_keys(str(known_hosts))
        self.client.set_missing_host_key_policy(PinFirstHostKey(known_hosts, fingerprint))
        self.client.connect(**config, timeout=20, auth_timeout=20, banner_timeout=20,
                            look_for_keys=not bool(config["password"]), allow_agent=not bool(config["password"]))
        if fingerprint:
            actual = "SHA256:" + base64.b64encode(hashlib.sha256(self.client.get_transport().get_remote_server_key().asbytes()).digest()).decode().rstrip("=")
            if actual != fingerprint:
                self.client.close()
                raise DeployError("SSH server fingerprint does not match --fingerprint.")
        self.sftp = self.client.open_sftp()

    def close(self):
        self.sftp.close()
        self.client.close()

    def run(self, command: str, label: str, timeout: int = 120, optional: bool = False, show_error: bool = True) -> str:
        channel = self.client.get_transport().open_session(timeout=20)
        channel.exec_command(command)
        output = bytearray()
        started = time.monotonic()
        last_note = started
        while True:
            if channel.recv_ready():
                output.extend(channel.recv(65536))
            if channel.recv_stderr_ready():
                output.extend(channel.recv_stderr(65536))
            if len(output) > 24000:
                del output[:-24000]
            if channel.exit_status_ready() and not channel.recv_ready() and not channel.recv_stderr_ready():
                break
            now = time.monotonic()
            if now - started > timeout:
                channel.close()
                raise DeployError(f"{label} timed out.")
            if now - last_note > 25:
                note(f"{label} is still running...")
                last_note = now
            time.sleep(0.05)
        code = channel.recv_exit_status()
        text = output.decode("utf-8", errors="replace").strip()
        channel.close()
        if code and not optional:
            details = f"\n{scrub(text[-2400:])}" if text and show_error else ""
            raise DeployError(f"{label} failed (exit {code}).{details}")
        return text

    def read(self, path: str) -> bytes | None:
        try:
            with self.sftp.open(path, "rb") as remote:
                return remote.read()
        except FileNotFoundError:
            return None

    def write(self, path: str, data: bytes, mode: int = 0o644):
        temporary = path + f".tmp-{os.getpid()}"
        with self.sftp.open(temporary, "wb") as remote:
            remote.write(data)
        self.sftp.chmod(temporary, mode)
        self.sftp.posix_rename(temporary, path)

    def exists(self, path: str) -> bool:
        try:
            self.sftp.stat(path)
            return True
        except FileNotFoundError:
            return False

    def current(self) -> str | None:
        try:
            path = self.sftp.readlink(BASE + "/current")
        except FileNotFoundError:
            return None
        if not re.fullmatch(re.escape(BASE) + r"/releases/[a-f0-9]{40}", path):
            raise DeployError("The CRM current symlink has an unexpected target.")
        return path


def compose(release: str) -> str:
    return f"docker compose --project-directory {q(release)} --env-file {q(release + '/.env')} -f {q(release + '/compose.yaml')} -p mini-crm"


def health(server: Server):
    for _ in range(15):
        response = server.run("curl -fsS --max-time 5 http://127.0.0.1:18084/healthz", "CRM health check", optional=True)
        if response == "ok":
            return
        time.sleep(2)
    raise DeployError("The CRM container did not pass its health check.")


def switch_current(server: Server, release: str):
    temporary = BASE + "/current.next"
    server.run(f"ln -sfn {q(release)} {q(temporary)} && mv -Tf {q(temporary)} {q(BASE + '/current')}", "Switch current release")


def proxy_location() -> str:
    return """    location / {
        proxy_pass http://127.0.0.1:18084;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
"""


def nginx_config(domain: str, tls: bool) -> bytes:
    content = f"""# Managed by mini-CRM scripts/deploy.py.
server {{
    listen 80;
    listen [::]:80;
    server_name {domain};
    location ^~ /.well-known/acme-challenge/ {{
        root /var/www/letsencrypt;
        try_files $uri =404;
    }}
"""
    content += "    location / { return 301 https://$host$request_uri; }\n" if tls else proxy_location()
    content += "}\n"
    if tls:
        content += f"""server {{
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name {domain};
    ssl_certificate /etc/letsencrypt/live/{domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/{domain}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
""" + proxy_location() + "}\n"
    return content.encode()


def nginx_paths(domain: str) -> tuple[str, str]:
    name = f"mini-crm-{domain}.conf"
    return "/etc/nginx/sites-available/" + name, "/etc/nginx/sites-enabled/" + name


def nginx_snapshot(server: Server, domain: str) -> dict:
    available, enabled = nginx_paths(domain)
    content = server.read(available)
    try:
        entry = server.sftp.lstat(enabled)
        if not stat.S_ISLNK(entry.st_mode) or server.sftp.readlink(enabled) != available:
            raise DeployError("The CRM enabled Nginx configuration is not the expected symlink.")
        linked = True
    except FileNotFoundError:
        linked = False
    return {"content": content, "linked": linked}


def restore_nginx(server: Server, domain: str, previous: dict):
    available, enabled = nginx_paths(domain)
    if previous["content"] is None:
        if server.exists(available):
            server.sftp.remove(available)
    else:
        server.write(available, previous["content"])
    if not previous["linked"]:
        try:
            server.sftp.remove(enabled)
        except FileNotFoundError:
            pass
    server.run("nginx -t", "Validate restored Nginx configuration")
    server.run("systemctl reload nginx", "Reload restored Nginx configuration")


def install_nginx(server: Server, domain: str, tls: bool) -> dict:
    available, enabled = nginx_paths(domain)
    previous = nginx_snapshot(server, domain)
    # Read the loaded configuration only in memory; do not print other sites.
    loaded = server.run("nginx -T", "Inspect loaded Nginx configuration", show_error=False)
    current_file = None
    for line in loaded.splitlines():
        marker = re.match(r"# configuration file (.+):$", line)
        if marker:
            current_file = marker[1]
        names = re.match(r"\s*server_name\s+([^;]+);", line)
        if names and domain in names[1].split() and current_file not in (available, enabled):
            raise DeployError("This domain already has a different Nginx virtual host; inspect it before deploying.")
    if previous["content"] is not None:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        server.write(available + ".backup-" + stamp, previous["content"])
    server.run("mkdir -p /var/www/letsencrypt", "Prepare ACME webroot")
    try:
        server.write(available, nginx_config(domain, tls))
        if not previous["linked"]:
            server.sftp.symlink(available, enabled)
        server.run("nginx -t", "Validate Nginx configuration")
        server.run("systemctl reload nginx", "Reload Nginx configuration")
    except Exception:
        restore_nginx(server, domain, previous)
        raise
    return previous


def tls_exists(server: Server, domain: str) -> bool:
    root = f"/etc/letsencrypt/live/{domain}/"
    return server.exists(root + "fullchain.pem") and server.exists(root + "privkey.pem")


def install_renewal_hook(server: Server, domain: str):
    directory = "/etc/letsencrypt/renewal-hooks/deploy"
    path = directory + "/mini-crm-reload-nginx"
    marker = b"# Managed by mini-CRM scripts/deploy.py."
    content = f"""#!/bin/sh
# Managed by mini-CRM scripts/deploy.py.
case " ${{RENEWED_DOMAINS:-}} " in
    *" {domain} "*)
        /usr/sbin/nginx -t && /usr/bin/systemctl reload nginx
        ;;
    *) exit 0 ;;
esac
""".encode()
    server.run(f"mkdir -p {q(directory)}", "Prepare CRM certificate renewal hook")
    previous = server.read(path)
    if previous is not None and marker not in previous:
        raise DeployError("The CRM renewal hook path contains an unmanaged file; inspect it before replacing.")
    if previous is not None and previous != content:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        # Non-executable backups are not picked up as Certbot hooks.
        server.write(path + ".backup-" + stamp, previous, mode=0o600)
    server.write(path, content, mode=0o755)
    server.run(f"sh -n {q(path)}", "Validate CRM certificate renewal hook")


def source_archive(values: dict[str, str]) -> tuple[str, Path]:
    status = subprocess.run(["git", "status", "--porcelain", "--untracked-files=all"], cwd=REPO, capture_output=True, text=True, check=True).stdout
    if status.strip():
        raise DeployError("Commit the source changes before publishing; deployment uses exactly git HEAD.")
    sha = subprocess.run(["git", "rev-parse", "HEAD"], cwd=REPO, capture_output=True, text=True, check=True).stdout.strip()
    if not re.fullmatch(r"[a-f0-9]{40}", sha):
        raise DeployError("Cannot identify the committed source revision.")
    CACHE.mkdir(exist_ok=True)
    archive = CACHE / f"source-{sha}.tar.gz"
    subprocess.run(["git", "archive", "--format=tar.gz", "--output", str(archive), "HEAD"], cwd=REPO, check=True, capture_output=True)
    secrets = [value.encode() for name, value in values.items() if value and re.search(r"SECRET|SERVICE_ROLE|PASSWORD|TOKEN", name, re.I)]
    with tarfile.open(archive, "r:gz") as source:
        for member in source.getmembers():
            path = PurePosixPath(member.name)
            if path.is_absolute() or ".." in path.parts or member.issym() or member.islnk():
                raise DeployError("The source archive contains an unsafe path or link.")
            if any(part in (".git", "node_modules", ".deploy") for part in path.parts):
                raise DeployError("The source archive contains local runtime files.")
            if path.name in ("ssh.txt", ".demo-credentials.json") or (path.name.startswith(".env") and path.name != ".env.example"):
                raise DeployError("The source archive contains a private local file.")
            if member.isfile() and secrets:
                content = source.extractfile(member).read()
                if any(secret in content for secret in secrets):
                    raise DeployError("The source archive contains a configured secret value.")
    return sha, archive


def write_state(server: Server, current: str, previous: str | None, domain: str):
    data = {"current": current, "previous": previous, "domain": domain, "deployed_at": datetime.now(timezone.utc).isoformat()}
    server.write(BASE + "/deployment-state.json", (json.dumps(data, indent=2) + "\n").encode())


def publish(server: Server, domain: str, values: dict[str, str]):
    sha, archive = source_archive(values)
    release = BASE + "/releases/" + sha
    previous = server.current()
    remote_archive = BASE + "/archives/" + sha + ".tar.gz"
    note(f"Uploading committed release {sha[:12]}...")
    server.run(f"mkdir -p {q(BASE + '/archives')} {q(release)}", "Prepare CRM release directory")
    server.sftp.put(str(archive), remote_archive + ".uploading")
    server.sftp.posix_rename(remote_archive + ".uploading", remote_archive)
    server.run(f"tar -xzf {q(remote_archive)} -C {q(release)}", "Extract CRM release")
    server.write(release + "/.env", public_env(values, sha).encode(), mode=0o600)
    note("Building the CRM image...")
    server.run(compose(release) + " build crm", "Build CRM image", timeout=900)
    changed_container = False
    nginx_previous = None
    try:
        changed_container = True
        server.run(compose(release) + " up -d --no-build crm", "Start CRM container", timeout=180)
        health(server)
        nginx_previous = install_nginx(server, domain, tls_exists(server, domain))
        response = server.run(f"curl -fsS --max-time 10 -H {q('Host: ' + domain)} http://127.0.0.1/healthz", "Verify host routing")
        # Existing TLS deployments redirect HTTP; verify HTTPS in that case.
        if response != "ok" and tls_exists(server, domain):
            response = server.run(f"curl -fsS --max-time 10 --resolve {q(domain + ':443:127.0.0.1')} {q('https://' + domain + '/healthz')}", "Verify HTTPS routing")
        if response != "ok":
            raise DeployError("The host virtual host did not return the CRM health response.")
        switch_current(server, release)
        write_state(server, release, previous if previous != release else None, domain)
    except Exception:
        if nginx_previous is not None:
            restore_nginx(server, domain, nginx_previous)
        if changed_container:
            if previous:
                server.run(compose(previous) + " up -d --no-build crm", "Restore previous CRM container", timeout=180)
                health(server)
                switch_current(server, previous)
            else:
                server.run(compose(release) + " stop crm", "Stop failed CRM container", optional=True)
        raise
    scheme = "https" if tls_exists(server, domain) else "http"
    note(f"Published release {sha[:12]}: {scheme}://{domain}")


def enable_tls(server: Server, domain: str):
    if not server.current():
        raise DeployError("Publish the HTTP application before requesting a certificate.")
    response = server.run(f"curl -fsS --max-time 10 -H {q('Host: ' + domain)} http://127.0.0.1/healthz", "Verify HTTP challenge routing")
    if response != "ok" and not tls_exists(server, domain):
        raise DeployError("HTTP routing is not ready for the certificate challenge.")
    note("Requesting or reusing the domain certificate...")
    server.run("certbot certonly --webroot -w /var/www/letsencrypt "
               f"-d {q(domain)} --cert-name {q(domain)} --non-interactive --keep-until-expiring",
               "Provision TLS certificate", timeout=300)
    if not tls_exists(server, domain):
        raise DeployError("Certbot did not leave the expected certificate files.")
    previous = install_nginx(server, domain, True)
    try:
        response = server.run(f"curl -fsS --max-time 15 --resolve {q(domain + ':443:127.0.0.1')} {q('https://' + domain + '/healthz')}", "Verify TLS certificate and routing")
        if response != "ok":
            raise DeployError("HTTPS did not return the CRM health response.")
    except Exception:
        restore_nginx(server, domain, previous)
        raise
    install_renewal_hook(server, domain)
    note(f"HTTPS is ready: https://{domain}")


def rollback(server: Server, domain: str, release_sha: str | None):
    current = server.current()
    data = server.read(BASE + "/deployment-state.json")
    state = json.loads(data) if data else {}
    target = BASE + "/releases/" + release_sha if release_sha else state.get("previous")
    if not target or not re.fullmatch(re.escape(BASE) + r"/releases/[a-f0-9]{40}", target) or not server.exists(target + "/compose.yaml"):
        raise DeployError("No stored rollback release is available; pass --release with a retained commit SHA.")
    server.run(compose(target) + " up -d --no-build crm", "Start rollback release", timeout=180)
    health(server)
    switch_current(server, target)
    write_state(server, target, current, domain)
    note(f"Restored release {target.rsplit('/', 1)[1][:12]}. Database schema and data were not rolled back.")


def inspect(server: Server):
    commands = {
        "OS": "uname -sm",
        "Docker": "docker version --format '{{.Server.Version}}'",
        "Compose": "docker compose version --short",
        "Nginx": "nginx -t",
        "Certbot": "certbot --version",
        "CRM port 18084": "ss -ltn '( sport = :18084 )'",
        "Disk": "df -h /",
    }
    for label, command in commands.items():
        response = server.run(command, label)
        note(f"{label}: {response}")
    note("Current CRM release: " + (server.current() or "not deployed"))


def status(server: Server, domain: str):
    note("Current CRM release: " + (server.current() or "not deployed"))
    note(server.run("docker ps --filter label=com.docker.compose.project=mini-crm --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'", "Inspect CRM container") or "CRM container is not running.")
    health(server)
    note("Container health: ok")
    note("HTTPS certificate: " + ("present" if tls_exists(server, domain) else "not provisioned"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("inspect", "publish", "tls", "status", "rollback"))
    parser.add_argument("--domain", default="work-search.ru")
    parser.add_argument("--ssh-file", type=Path, default=REPO / "ssh.txt")
    parser.add_argument("--fingerprint", help="Optional expected SHA256 SSH host-key fingerprint")
    parser.add_argument("--release", help="Full retained Git commit SHA for rollback")
    args = parser.parse_args()
    if not re.fullmatch(r"(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}", args.domain) or ".." in args.domain:
        raise DeployError("Use a public DNS domain without a scheme, path or wildcard.")
    if args.release and not re.fullmatch(r"[a-f0-9]{40}", args.release):
        raise DeployError("--release must be a full 40-character commit SHA.")
    server = Server(args.ssh_file, args.fingerprint)
    try:
        if args.mode == "inspect":
            inspect(server)
        elif args.mode == "publish":
            publish(server, args.domain, read_env())
        elif args.mode == "tls":
            enable_tls(server, args.domain)
        elif args.mode == "status":
            status(server, args.domain)
        else:
            rollback(server, args.domain, args.release)
    finally:
        server.close()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("Deployment interrupted. Inspect status before retrying.", file=sys.stderr)
        raise SystemExit(130)
    except Exception as error:
        message = str(error) if isinstance(error, (DeployError, ValueError, FileNotFoundError)) else type(error).__name__
        print("Deployment failed: " + scrub(message), file=sys.stderr)
        raise SystemExit(1)
