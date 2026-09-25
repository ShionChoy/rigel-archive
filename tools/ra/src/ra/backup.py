"""Encrypted backup to Backblaze B2 (`uv run ra backup`; in the cloud the processing container runs it
every night).

What: every original in storage (blobs/) and an export of the whole database as SQL. Derived files are
left out; they can always be made again from the originals.

How: rclone with a crypt remote on top of B2. Names and contents are encrypted before they leave, with
two passwords (BACKUP_CRYPT_PASSWORD, BACKUP_CRYPT_SALT) generated once and kept by the owner, so B2
only ever holds ciphertext. Originals are named by their SHA-256 and never change, so a run uploads only
the ones B2 does not have yet, and nothing is ever deleted from the backup (content purged from the site
stays in it). Each run ends by reading a few random originals back from B2 and checking their SHA-256:
a small restore test.

Inside the encrypted remote:

  blobs/<sha256>                          originals
  db/<YYYY>/<YYYY-MM-DD>T<HHMM>Z.sql.gz   database exports; restore with `wrangler d1 execute --file`

Settings (environment, else tools/ra/backup.env): B2_KEY_ID, B2_APP_KEY, B2_BUCKET,
BACKUP_CRYPT_PASSWORD, BACKUP_CRYPT_SALT.
"""

import gzip
import hashlib
import json
import os
import random
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

from .site import INTERNAL_SITE, SiteClient, SiteError, read_env_file

SETTINGS = ("B2_KEY_ID", "B2_APP_KEY", "B2_BUCKET", "BACKUP_CRYPT_PASSWORD", "BACKUP_CRYPT_SALT")
REMOTE = "vault:"  # the crypt remote configured by rclone_env()
FOLDER = "rigel-archive"  # inside the bucket
VERIFY_SAMPLES = 3
SKIP_TABLES = ("sqlite_", "_cf_")
# Processing results: all made again from the originals by the processing program after a restore (and a
# fingerprint row can exceed D1's 100 KB statement limit, which a restorable file must respect).
PROCESSING_TABLES = {"media_tasks", "derived", "fingerprints", "acoustic_matches"}
MAX_STATEMENT = 100_000  # bytes, D1's limit per SQL statement


class BackupError(Exception):
    pass


def settings(env_file: Path | None) -> dict[str, str]:
    """The backup settings; raises BackupError naming what is missing."""
    values = read_env_file(env_file) if env_file else {}
    found = {key: os.environ.get(key) or values.get(key) or "" for key in SETTINGS}
    missing = [key for key, value in found.items() if not value]
    if missing:
        raise BackupError(f"备份还没有设置：缺少 {', '.join(missing)}（见 tools/ra/backup.env）")
    return found


def _obscure(secret: str) -> str:
    """rclone keeps crypt passwords in its own reversible form."""
    result = subprocess.run(["rclone", "obscure", "-"], input=secret, capture_output=True, text=True, check=True)
    return result.stdout.strip()


def rclone_env(conf: dict[str, str]) -> dict[str, str]:
    """rclone configured entirely through the environment: b2 (the bucket) and vault (crypt on top)."""
    return {
        **os.environ,
        "RCLONE_CONFIG_B2_TYPE": "b2",
        "RCLONE_CONFIG_B2_ACCOUNT": conf["B2_KEY_ID"],
        "RCLONE_CONFIG_B2_KEY": conf["B2_APP_KEY"],
        "RCLONE_CONFIG_VAULT_TYPE": "crypt",
        "RCLONE_CONFIG_VAULT_REMOTE": f"b2:{conf['B2_BUCKET']}/{FOLDER}",
        "RCLONE_CONFIG_VAULT_FILENAME_ENCRYPTION": "standard",
        "RCLONE_CONFIG_VAULT_DIRECTORY_NAME_ENCRYPTION": "true",
        "RCLONE_CONFIG_VAULT_PASSWORD": _obscure(conf["BACKUP_CRYPT_PASSWORD"]),
        "RCLONE_CONFIG_VAULT_PASSWORD2": _obscure(conf["BACKUP_CRYPT_SALT"]),
    }


class Rclone:
    def __init__(self, env: dict[str, str], log):
        self.env = env
        self.log = log
        self.config = tempfile.NamedTemporaryFile(prefix="rclone-", suffix=".conf", delete=False)  # empty: all in env
        self.config.close()

    def close(self) -> None:
        Path(self.config.name).unlink(missing_ok=True)

    def run(self, *args: str, stdin=None, timeout: float | None = None) -> subprocess.CompletedProcess:
        result = subprocess.run(["rclone", "--config", self.config.name, *args], env=self.env, stdin=stdin,
                                capture_output=True, timeout=timeout)
        if result.returncode != 0:
            tail = result.stderr.decode("utf-8", "replace").strip().splitlines()[-3:]
            raise BackupError(f"rclone {args[0]} 失败：{' / '.join(tail)[:400]}")
        return result

    def listing(self, folder: str) -> dict[str, int]:
        """name -> size of the files in a folder of the backup (decrypted names)."""
        try:
            out = self.run("lsjson", f"{REMOTE}{folder}", "--files-only", "--no-modtime", "--no-mimetype",
                           "--fast-list", timeout=3600).stdout
        except BackupError as exc:
            if "directory not found" in str(exc):
                return {}
            raise
        return {item["Name"]: item["Size"] for item in json.loads(out or b"[]")}


# ------------------------------------------------------------------ database export


def _sql_value(value) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return repr(value)
    return "'" + str(value).replace("'", "''") + "'"


def export_database(client: SiteClient, out: Path, log) -> dict:
    """All tables as one gzip'd SQL file that recreates the database (schema, rows, indexes)."""
    schema = client.dump_schema()
    tables = [t for t in schema["tables"] if not t["name"].startswith(SKIP_TABLES)]
    skipped = [t for t in tables if t["name"] in PROCESSING_TABLES]
    counts = {}
    with gzip.open(out, "wt", encoding="utf-8") as sql:
        stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
        sql.write(f"-- Rigel archive database export, {stamp}\n-- restore: wrangler d1 execute <DB> --file <this file>\n")
        sql.write("-- processing results (" + ", ".join(sorted(PROCESSING_TABLES)) + ") are left out: the processing\n"
                  "-- program makes them again from the originals once the site runs on the restored database\n")
        sql.write("PRAGMA defer_foreign_keys = true;\n")
        for table in tables:
            sql.write(f"{table['sql']};\n")
        for table in tables:
            if table in skipped:
                continue
            name, after, n = table["name"], 0, 0
            while True:
                page = client.dump_rows(name, after)
                columns = ", ".join(f'"{c}"' for c in page["columns"])
                for row in page["rows"]:
                    statement = f'INSERT INTO "{name}" ({columns}) VALUES ({", ".join(_sql_value(v) for v in row)});\n'
                    if len(statement.encode()) > MAX_STATEMENT:
                        raise BackupError(f"表 {name} 有一行超过 D1 的语句长度上限，导出无法恢复")
                    sql.write(statement)
                n += len(page["rows"])
                if page["last"] is None:
                    break
                after = page["last"]
            counts[name] = n
        for index in schema["indexes"]:
            sql.write(f"{index['sql']};\n")
    log(f"database export: {sum(counts.values())} rows in {len(counts)} tables, {out.stat().st_size / 1e6:.1f} MB")
    return counts


# ------------------------------------------------------------------ originals


def stored_blobs(client: SiteClient) -> dict[str, int]:
    blobs, cursor = {}, None
    while True:
        objects, cursor = client.objects("blobs/", cursor)
        for o in objects:
            blobs[o["key"].removeprefix("blobs/")] = o["size"]
        if not cursor:
            return blobs


def _http_source(client: SiteClient) -> tuple[list[str], dict[str, str]]:
    """rclone arguments and environment that read originals from the site's worker API."""
    env = {"RCLONE_HTTP_URL": f"{client.base}/admin/api/worker/blob/"}
    if client.base != INTERNAL_SITE:  # on a computer: the same headers as every other call
        wanted = ("authorization", "cf-access-client-id", "cf-access-client-secret")
        pairs = [f"{k},{v}" for k, v in client.http.headers.items() if k.lower() in wanted and v]
        env["RCLONE_HTTP_HEADERS"] = ",".join(pairs)
    return [":http:"], env


def copy_blobs(client: SiteClient, rclone: Rclone, missing: list[str], work: Path, log) -> None:
    listing = work / "missing.txt"
    listing.write_text("".join(f"{sha}\n" for sha in missing))
    source, env = _http_source(client)
    rclone.env = {**rclone.env, **env}
    rclone.run("copy", *source, f"{REMOTE}blobs", "--files-from", str(listing), "--no-traverse", "--size-only",
               "--transfers", "8", "--checkers", "16", "--retries", "5", "--low-level-retries", "20",
               "--stats", "5m", "--stats-one-line", "--stats-log-level", "NOTICE", timeout=24 * 3600)


def verify_samples(rclone: Rclone, backed: dict[str, int], log) -> tuple[int, list[str]]:
    """Read a few originals (up to 200 MB each) back from B2 and check their SHA-256.
    Returns (how many were read, the ones that failed)."""
    small = [sha for sha, size in backed.items() if size <= 200 * 1024 * 1024]
    sample = random.sample(small, min(VERIFY_SAMPLES, len(small)))
    bad = []
    for sha in sample:
        digest = hashlib.sha256()
        with subprocess.Popen(["rclone", "--config", rclone.config.name, "cat", f"{REMOTE}blobs/{sha}"],
                              env=rclone.env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL) as proc:
            assert proc.stdout is not None
            while chunk := proc.stdout.read(4 * 1024 * 1024):
                digest.update(chunk)
        if proc.returncode != 0 or digest.hexdigest() != sha:
            bad.append(sha)
    log(f"restore test: {len(sample) - len(bad)} of {len(sample)} originals read back intact")
    return len(sample), bad


# ------------------------------------------------------------------ run


def run(client: SiteClient, env_file: Path | None, tmp_root: Path | None = None,
        log=lambda m: print(m, file=sys.stderr)) -> dict:
    """One backup run; the report is also saved on the site (storage page). Raises BackupError."""
    conf = settings(env_file)  # before anything else: an unconfigured backup is not a failed run
    started = time.monotonic()
    run_id = client.backup_run(action="start")["id"]
    report: dict = {}
    rclone = Rclone(rclone_env(conf), log)
    try:
        with tempfile.TemporaryDirectory(prefix="ra-backup-", dir=tmp_root) as tmp:
            work = Path(tmp)
            now = datetime.now(timezone.utc)
            dump = work / "db.sql.gz"
            report["tables"] = export_database(client, dump, log)
            target = f"db/{now:%Y}/{now:%Y-%m-%dT%H%M}Z.sql.gz"
            rclone.run("copyto", str(dump), f"{REMOTE}{target}", timeout=3600)
            report["db"] = {"key": target, "size": dump.stat().st_size}

            stored = stored_blobs(client)
            backed = rclone.listing("blobs")
            missing = sorted(s for s, size in stored.items() if backed.get(s) != size)
            log(f"originals: {len(stored)} stored, {len(backed)} in the backup, {len(missing)} to copy")
            if missing:
                copy_blobs(client, rclone, missing, work, log)
                backed = rclone.listing("blobs")
            still = [s for s in missing if backed.get(s) != stored[s]]
            report["blobs"] = {
                "stored": len(stored), "backed_up": sum(1 for s in stored if backed.get(s) == stored[s]),
                "copied": len(missing) - len(still), "copied_bytes": sum(stored[s] for s in missing if s not in still),
                "bytes": sum(stored.values()), "failed": still[:20],
            }
            checked, bad = verify_samples(rclone, {s: n for s, n in stored.items() if backed.get(s) == n}, log)
            report["verified"] = checked - len(bad)
            if bad or still:
                raise BackupError(f"{len(still)} 个原件没有备份上，{len(bad)} 个读回校验失败")
        report["seconds"] = round(time.monotonic() - started)
        client.backup_run(action="finish", id=run_id, ok=True, report=report)
        log(f"backup done in {report['seconds']} s")
        return report
    except (BackupError, SiteError, OSError, subprocess.SubprocessError) as exc:
        report["error"] = str(exc)[:1000]
        report["seconds"] = round(time.monotonic() - started)
        try:
            client.backup_run(action="finish", id=run_id, ok=False, report=report)
        except SiteError:
            pass
        raise BackupError(str(exc)) from exc
    finally:
        rclone.close()
