"""`uv run ra <command>` entry point."""

import argparse
import json
import os
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from .catalog import CatalogError, load_catalog
from .extract import extract_all, load_records, local_copies
from .members import expand, suggest_all
from .probe import apply_probes, load_probes, probe_all
from .rules import RuleSet
from .scan import as_source_files, load_scan, scan, write_scan
from .push import PushState, push
from .serve import BlobIndex, serve
from .site import SiteError, client_from_env
from .sql import file_statements, release_statements
from .survey import read_listing
from .worker import run as run_worker
from . import backup as backup_mod
from .processing import TASKS, Inputs, run_derive, run_fingerprint, run_matching

_HERE = Path(__file__).resolve()
# The repository (tools/ra/src/ra/cli.py → four levels up); inside the container image there is none.
REPO = _HERE.parents[4] if len(_HERE.parents) > 4 else _HERE.parents[-1]
WORKSPACE = Path(os.environ.get("RA_WORKSPACE", "/mnt/d/documents/projects/rigel-archive"))

DEFAULT_CATALOG = REPO / "data" / "seed" / "catalog.yaml"
DEFAULT_RULES = REPO / "tools" / "ra" / "rules" / "mapping.yaml"
DEFAULT_SURVEY = WORKSPACE / "manifest" / "nas-survey-2026-09-23" / "listing.tsv"
DEFAULT_SOURCE = WORKSPACE / "source" / "Rigel Theatre合辑"
DEFAULT_SCAN = WORKSPACE / "manifest" / "scan.jsonl"
DEFAULT_EXTRACTED = WORKSPACE / "extracted"
DEFAULT_ARCHIVES = WORKSPACE / "manifest" / "archives"
DEFAULT_PROBES = WORKSPACE / "manifest" / "probe.jsonl"
DEFAULT_TMP = WORKSPACE / "tmp"
DEFAULT_PUSH_STATE = WORKSPACE / "manifest" / "push-state.json"
CLOUD_ENV = REPO / "tools" / "ra" / "cloud.env"
BACKUP_ENV = REPO / "tools" / "ra" / "backup.env"
DEV_VARS = REPO / "site" / ".dev.vars"
DEFAULT_SEED_OUT = REPO / "site" / ".seed" / "seed.sql"


def _load(args):
    releases = load_catalog(args.catalog)
    rules = RuleSet.load(args.rules, releases)
    # The local copy's scan is the source of truth; the 2026-09-23 NAS listing is only a fallback.
    if args.survey is None and args.scan.exists():
        files = as_source_files(load_scan(args.scan))
    else:
        files = read_listing(args.survey or DEFAULT_SURVEY)
    records = load_records(args.archives)
    files = apply_probes(expand(files, records), load_probes(args.probes))
    return releases, rules, files, suggest_all(files, records, rules)


def cmd_scan(args) -> int:
    previous = load_scan(args.out)
    entries = scan(args.source, previous, want_hash=not args.no_hash, workers=args.workers)
    write_scan(args.out, entries)
    unhashed = sum(1 for e in entries if not e.sha256)
    print(f"{len(entries)} files, {sum(e.size for e in entries) / 1e9:.2f} GB, {unhashed} without hash -> {args.out}")
    return 0


def cmd_extract(args) -> int:
    entries = load_scan(args.scan)
    if not entries:
        raise ValueError(f"{args.scan} is empty; run `ra scan` first")
    records = extract_all(entries, args.source, args.out, args.manifest, only=args.only, retry=args.retry,
                          workers=args.workers)
    by_status = Counter(r.status for r in records.values())
    members = sum(len(r.members) for r in records.values())
    print(f"{len(records)} archives {dict(by_status)}, {members} members -> {args.manifest}")
    return 0


def cmd_probe(args) -> int:
    entries = load_scan(args.scan)
    files = local_copies(args.source, entries, load_records(args.archives), args.extracted)
    probes = probe_all(files, args.out, workers=args.workers)
    failed = sum(1 for p in probes.values() if "error" in p)
    with_md5 = sum(1 for p in probes.values() if "pcm_md5" in p)
    print(f"{len(probes)} media files probed, {failed} unreadable, {with_md5} with PCM MD5 -> {args.out}")
    return 0


def _local_copy(args):
    """Finds originals in the local copy of the 合辑 (when it is still there) instead of downloading."""
    if not args.source.exists() or not args.scan.exists():
        return None
    return BlobIndex(args.source, args.scan, args.extracted, args.archives).find


def cmd_worker(args) -> int:
    client = client_from_env(args.site, DEV_VARS, CLOUD_ENV)
    tasks = tuple(t.strip() for t in args.tasks.split(",") if t.strip())
    unknown = set(tasks) - set(TASKS)
    if unknown:
        raise ValueError(f"unknown task: {', '.join(sorted(unknown))} (choose from {', '.join(TASKS)})")
    kept = f"copies of uploads kept in {args.keep}" if args.keep else "no copies kept"
    print(f"working for {client.base}: {', '.join(tasks)} ({kept}){'' if args.once else '; Ctrl+C to stop'}")
    try:
        done = run_worker(client, args.keep, args.tmp, once=args.once, interval=args.interval, tasks=tasks,
                          workers=args.workers, find=_local_copy(args))
    except KeyboardInterrupt:
        return 0
    print(f"{done} contents processed")
    return 0


def cmd_derive(args) -> int:
    client = client_from_env(args.site, DEV_VARS, CLOUD_ENV)
    print(f"making files for playing and previewing for {client.base}")
    try:
        counts = run_derive(client, Inputs(client, args.tmp, _local_copy(args)), workers=args.workers, limit=args.limit)
    except KeyboardInterrupt:
        return 130
    print(f"{counts.done} done, {counts.failed} failed, {counts.skipped} taken by another worker")
    return 1 if counts.failed else 0


def cmd_fingerprint(args) -> int:
    client = client_from_env(args.site, DEV_VARS, CLOUD_ENV)
    new: list[str] = []
    if not args.match_only:
        print(f"fingerprinting audio for {client.base}")
        try:
            counts, new = run_fingerprint(client, Inputs(client, args.tmp, _local_copy(args)), workers=args.workers,
                                          limit=args.limit)
        except KeyboardInterrupt:
            return 130
        print(f"{counts.done} fingerprinted, {counts.failed} failed")
    if args.rematch or args.match_only:
        pairs = run_matching(client, None)
    else:
        pairs = run_matching(client, new) if new else 0
    print(f"{pairs} matching pairs saved")
    return 0


def cmd_backup(args) -> int:
    client = client_from_env(args.site, DEV_VARS, CLOUD_ENV)
    try:
        report = backup_mod.run(client, args.env, args.tmp)
    except backup_mod.BackupError as exc:
        print(f"backup failed: {exc}", file=sys.stderr)
        return 1
    blobs = report.get("blobs", {})
    print(f"backup ok: {blobs.get('backed_up')}/{blobs.get('stored')} originals in B2 "
          f"({blobs.get('copied')} copied now), database export {report['db']['key']}")
    return 0


def cmd_processor(args) -> int:
    client = client_from_env(args.site, DEV_VARS, CLOUD_ENV)
    data = client.processor(None if args.action == "status" else args.action)
    print(json.dumps(data, ensure_ascii=False, indent=1))
    return 0


def cmd_container(args) -> int:
    from .container import main as container_main

    return container_main(args.port, args.tmp, workers=args.workers)


def cmd_push(args) -> int:
    client = client_from_env(args.site, DEV_VARS, CLOUD_ENV)
    index = BlobIndex(args.source, args.scan, args.extracted, args.archives)
    print(f"uploading the local copy to {client.base}")
    try:
        progress = push(client, index.find, PushState(args.state), workers=args.workers, dry_run=args.dry_run,
                        limit=args.limit)
    except KeyboardInterrupt:
        print("stopped; run `ra push` again to continue")
        return 130
    if progress.failed:
        print(f"{len(progress.failed)} files failed; run `ra push` again to retry them")
        return 1
    return 0


def cmd_serve(args) -> int:
    serve(args.source, args.port, BlobIndex(args.source, args.scan, args.extracted, args.archives))
    return 0


def cmd_seed(args) -> int:
    releases, _, files, suggestions = _load(args)
    seen = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    statements = release_statements(releases) + file_statements(files, suggestions, seen)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        "-- Generated by `uv run ra seed`; do not edit.\n" + "\n".join(statements) + "\n", encoding="utf-8"
    )
    members = sum(1 for f in files if f.member_path)
    print(f"{len(releases)} releases, {len(files) - members} files + {members} archive members -> {args.out}")
    return 0


def cmd_report(args) -> int:
    _, _, files, suggestions = _load(args)
    by_rule: Counter[str] = Counter()
    by_top: dict[str, list[int]] = {}
    unmatched = []
    for f in files:
        if args.dir and not f.path.startswith(args.dir):
            continue
        s = suggestions[f.file_id]
        top = "/".join(f.path.split("/")[: args.depth])
        counts = by_top.setdefault(top, [0, 0])
        counts[1] += 1
        if s:
            counts[0] += 1
            by_rule[s.rule] += 1
        else:
            unmatched.append(f.path)

    total = sum(c[1] for c in by_top.values())
    matched = sum(c[0] for c in by_top.values())
    print(f"matched {matched}/{total} files ({matched / max(total, 1):.0%})\n")
    for top, (m, t) in sorted(by_top.items()):
        print(f"{m:5d}/{t:<5d} {top}")
    print("\nrule hits:")
    for rule, n in by_rule.most_common():
        print(f"{n:5d}  {rule}")
    if args.unmatched:
        print(f"\nunmatched (first {args.unmatched}):")
        for path in unmatched[: args.unmatched]:
            print("  " + path)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ra", description="Rigel archive import tool")
    sub = parser.add_subparsers(dest="command", required=True)

    def common(p):
        p.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
        p.add_argument("--rules", type=Path, default=DEFAULT_RULES)
        p.add_argument("--scan", type=Path, default=DEFAULT_SCAN, help="scan.jsonl from `ra scan`")
        p.add_argument("--survey", type=Path, default=None, help="use a NAS listing.tsv instead of the scan")
        p.add_argument("--archives", type=Path, default=DEFAULT_ARCHIVES, help="archive records from `ra extract`")
        p.add_argument("--probes", type=Path, default=DEFAULT_PROBES, help="media specs from `ra probe`")

    p_scan = sub.add_parser("scan", help="record size, mtime and SHA-256 of every file in source/")
    p_scan.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    p_scan.add_argument("-o", "--out", type=Path, default=DEFAULT_SCAN)
    p_scan.add_argument("--no-hash", action="store_true", help="only list files")
    p_scan.add_argument("--workers", type=int, default=4)
    p_scan.set_defaults(func=cmd_scan)

    p_extract = sub.add_parser("extract", help="unpack archives and disc images into extracted/ and hash their members")
    p_extract.add_argument("--scan", type=Path, default=DEFAULT_SCAN)
    p_extract.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    p_extract.add_argument("-o", "--out", type=Path, default=DEFAULT_EXTRACTED)
    p_extract.add_argument("--manifest", type=Path, default=DEFAULT_ARCHIVES, help="where archive records go")
    p_extract.add_argument("--only", default="", help="only archives whose path contains this text")
    p_extract.add_argument("--retry", action="store_true", help="unpack again archives that failed before")
    p_extract.add_argument("--workers", type=int, default=3)
    p_extract.set_defaults(func=cmd_extract)

    p_probe = sub.add_parser("probe", help="read audio/video/image specs with ffprobe and PCM MD5s")
    p_probe.add_argument("--scan", type=Path, default=DEFAULT_SCAN)
    p_probe.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    p_probe.add_argument("--extracted", type=Path, default=DEFAULT_EXTRACTED)
    p_probe.add_argument("--archives", type=Path, default=DEFAULT_ARCHIVES)
    p_probe.add_argument("-o", "--out", type=Path, default=DEFAULT_PROBES)
    p_probe.add_argument("--workers", type=int, default=8)
    p_probe.set_defaults(func=cmd_probe)

    site_help = "site URL (default: RA_SITE from the environment or cloud.env, else the local dev site)"

    def local_copy_args(p):
        p.add_argument("--source", type=Path, default=DEFAULT_SOURCE, help="local copy of the 合辑, if still there")
        p.add_argument("--scan", type=Path, default=DEFAULT_SCAN)
        p.add_argument("--extracted", type=Path, default=DEFAULT_EXTRACTED)
        p.add_argument("--archives", type=Path, default=DEFAULT_ARCHIVES)
        p.add_argument("--tmp", type=Path, default=DEFAULT_TMP, help="scratch space for downloads")

    p_worker = sub.add_parser("worker", help="work through the site's queue: uploads, derived files, fingerprints")
    p_worker.add_argument("--site", default=None, help=site_help)
    p_worker.add_argument("--tasks", default=",".join(TASKS), help=f"which work to do (default: {','.join(TASKS)})")
    p_worker.add_argument("--keep", type=Path, default=None, metavar="DIR", help="keep a copy of every upload here")
    p_worker.add_argument("--once", action="store_true", help="process what is queued, then exit")
    p_worker.add_argument("--interval", type=float, default=10, help="seconds between polls when idle")
    p_worker.add_argument("--workers", type=int, default=3, help="contents worked on at the same time")
    local_copy_args(p_worker)
    p_worker.set_defaults(func=cmd_worker)

    p_derive = sub.add_parser("derive", help="make stream FLAC/AAC, waveforms, WebP previews and MP4s")
    p_derive.add_argument("--site", default=None, help=site_help)
    p_derive.add_argument("--workers", type=int, default=4)
    p_derive.add_argument("--limit", type=int, default=None, metavar="N", help="at most N contents this run")
    local_copy_args(p_derive)
    p_derive.set_defaults(func=cmd_derive)

    p_fp = sub.add_parser("fingerprint", help="acoustic fingerprints and matching recordings")
    p_fp.add_argument("--site", default=None, help=site_help)
    p_fp.add_argument("--workers", type=int, default=6)
    p_fp.add_argument("--limit", type=int, default=None, metavar="N", help="fingerprint at most N contents")
    p_fp.add_argument("--rematch", action="store_true", help="compare all fingerprints again, not only new ones")
    p_fp.add_argument("--match-only", action="store_true", help="only compare (all) fingerprints")
    local_copy_args(p_fp)
    p_fp.set_defaults(func=cmd_fingerprint)

    p_backup = sub.add_parser("backup", help="encrypted backup of originals and the database to Backblaze B2")
    p_backup.add_argument("--site", default=None, help=site_help)
    p_backup.add_argument("--env", type=Path, default=BACKUP_ENV, help="B2 key and encryption passwords")
    p_backup.add_argument("--tmp", type=Path, default=DEFAULT_TMP)
    p_backup.set_defaults(func=cmd_backup)

    p_proc = sub.add_parser("processor", help="the cloud processing container: status, wake, restart, backup")
    p_proc.add_argument("action", nargs="?", default="status", choices=("status", "wake", "restart", "backup"))
    p_proc.add_argument("--site", default=None, help=site_help)
    p_proc.set_defaults(func=cmd_processor)

    p_container = sub.add_parser("container", help="the processing container's program (Cloudflare Containers)")
    p_container.add_argument("--port", type=int, default=8080)
    p_container.add_argument("--tmp", type=Path, default=Path("/tmp/ra"))
    p_container.add_argument("--workers", type=int, default=3)
    p_container.set_defaults(func=cmd_container)

    p_push = sub.add_parser("push", help="upload the local copy's contents to the site's storage")
    p_push.add_argument("--site", default=None, help=site_help)
    p_push.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    p_push.add_argument("--scan", type=Path, default=DEFAULT_SCAN)
    p_push.add_argument("--extracted", type=Path, default=DEFAULT_EXTRACTED)
    p_push.add_argument("--archives", type=Path, default=DEFAULT_ARCHIVES)
    p_push.add_argument("--state", type=Path, default=DEFAULT_PUSH_STATE, help="progress of large files")
    p_push.add_argument("--workers", type=int, default=4, help="files uploaded at the same time")
    p_push.add_argument("--dry-run", action="store_true", help="only show what would be uploaded")
    p_push.add_argument("--limit", type=int, default=None, metavar="N", help="upload at most N files this run")
    p_push.set_defaults(func=cmd_push)

    p_serve = sub.add_parser("serve", help="read-only file server for admin previews (dev only)")
    p_serve.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    p_serve.add_argument("--port", type=int, default=4322)
    p_serve.add_argument("--scan", type=Path, default=DEFAULT_SCAN)
    p_serve.add_argument("--extracted", type=Path, default=DEFAULT_EXTRACTED)
    p_serve.add_argument("--archives", type=Path, default=DEFAULT_ARCHIVES)
    p_serve.set_defaults(func=cmd_serve)

    p_seed = sub.add_parser("seed", help="write SQL that seeds the local D1 database")
    common(p_seed)
    p_seed.add_argument("-o", "--out", type=Path, default=DEFAULT_SEED_OUT)
    p_seed.set_defaults(func=cmd_seed)

    p_report = sub.add_parser("report", help="show how many files the mapping rules classify")
    common(p_report)
    p_report.add_argument("--dir", default="", help="only files under this path prefix")
    p_report.add_argument("--depth", type=int, default=2, help="group counts by this many path levels")
    p_report.add_argument("--unmatched", type=int, default=0, metavar="N", help="list N unmatched paths")
    p_report.set_defaults(func=cmd_report)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (CatalogError, ValueError, OSError, SiteError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
