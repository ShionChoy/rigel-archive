"""Turn `ra extract` records into file rows for archive members, and spot 「原始包」.

An archive whose every member also exists as a loose file (same SHA-256) is an original package:
it is kept for download, but its contents are already in the 合辑 unpacked.
"""

import os
from collections.abc import Iterator
from dataclasses import replace
from pathlib import PurePosixPath

from .extract import MAX_DEPTH, ArchiveRecord
from .rules import RuleSet, Suggestion
from .survey import SurveyFile

PACKAGE_ROLE = "package"


def archive_format(record: ArchiveRecord) -> dict:
    info = {"archive": record.type, "files": len(record.members), "status": record.status}
    if record.encoding:
        info["encoding"] = record.encoding
    if record.error:
        info["error"] = record.error
    return info


def expand(files: list[SurveyFile], records: dict[str, ArchiveRecord]) -> list[SurveyFile]:
    """The given files with archive formats filled in, followed by all archive members.

    Members come after the archive that contains them, so foreign keys hold when inserted in order.
    """
    out = [replace(f, format=archive_format(records[f.sha256])) if f.sha256 in records else f for f in files]
    for f in list(out):
        if f.sha256 in records:
            out.extend(_members(f, records[f.sha256], records, f.path, "", 1))
    return out


def _members(parent: SurveyFile, record: ArchiveRecord, records: dict[str, ArchiveRecord],
             top: str, prefix: str, depth: int) -> Iterator[SurveyFile]:
    for m in record.members:
        inner = records.get(m.sha256) if m.sha256 and depth < MAX_DEPTH else None
        member = SurveyFile(
            path=f"{parent.path}/{m.path}",
            size=m.size,
            mtime=m.mtime,
            sha256=m.sha256,
            archive=top,
            member_path=prefix + m.path,
            member_of=parent.file_id,
            note=m.note,
            format=archive_format(inner) if inner else None,
        )
        yield member
        if inner:
            yield from _members(member, inner, records, top, f"{prefix}{m.path}!/", depth + 1)


def package_note(archive: SurveyFile, record: ArchiveRecord, loose: dict[str, list[str]]) -> str | None:
    """「原始包」 note when every member of the archive also exists as a loose file."""
    if not record.members or any(not m.sha256 or m.sha256 not in loose for m in record.members):
        return None
    dirs = [PurePosixPath(loose[m.sha256][0]).parent.as_posix() for m in record.members]
    where = os.path.commonpath(dirs) if dirs else ""
    return f"原始包：包内 {len(record.members)} 个文件都已有解压好的副本（{where or '多个目录'}）"


def suggest_all(files: list[SurveyFile], records: dict[str, ArchiveRecord], rules: RuleSet
                ) -> dict[str, Suggestion | None]:
    """Rule suggestions by file id, with archives that are original packages marked as such."""
    loose: dict[str, list[str]] = {}
    for f in files:
        if f.archive is None and f.sha256:
            loose.setdefault(f.sha256, []).append(f.path)
    out = {}
    for f in files:
        suggestion = rules.suggest(f)
        record = records.get(f.sha256) if f.sha256 else None
        note = package_note(f, record, loose) if record else None
        if note:
            # Kept whole: its contents are organized as the loose copies next to it.
            base = suggestion or Suggestion(rule="原始包", confidence=0.6)
            suggestion = replace(base, role=PACKAGE_ROLE, seal=True, note=note if not base.note else f"{base.note}；{note}")
        out[f.file_id] = suggestion
    return out
