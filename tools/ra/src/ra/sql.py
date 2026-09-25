"""SQL generation for seeding the local D1 database (`wrangler d1 execute --file`)."""

import json
from collections.abc import Iterable, Sequence

from .catalog import Release
from .model import kind_for
from .rules import Suggestion
from .survey import SurveyFile

ROWS_PER_INSERT = 50  # keeps each statement far below D1's 100 KB statement limit


def q(value) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, (dict, list)):
        # Compact separators match JSON.stringify in the site, so unchanged values compare equal.
        value = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    text = str(value)
    if "\x00" in text:
        raise ValueError("NUL byte in SQL value")
    return "'" + text.replace("'", "''") + "'"


def insert(table: str, columns: Sequence[str], rows: Iterable[Sequence], or_ignore: bool = True,
           refresh: Sequence[str] = ()) -> list[str]:
    """INSERT statements, 50 rows each.

    Existing rows are left alone, except that the ``refresh`` columns are overwritten (an upsert on
    ``id``): machine-derived values can be re-imported without touching what admins edited.
    """
    head = f"INSERT {'OR IGNORE ' if or_ignore and not refresh else ''}INTO {table} ({', '.join(columns)}) VALUES\n"
    tail = ""
    if refresh:
        tail = "\nON CONFLICT (id) DO UPDATE SET " + ", ".join(f"{c} = excluded.{c}" for c in refresh)
    statements, batch = [], []
    for row in rows:
        batch.append("(" + ", ".join(q(v) for v in row) + ")")
        if len(batch) == ROWS_PER_INSERT:
            statements.append(head + ",\n".join(batch) + tail + ";")
            batch = []
    if batch:
        statements.append(head + ",\n".join(batch) + tail + ";")
    return statements


def release_statements(releases: list[Release]) -> list[str]:
    release_rows = [
        (
            r.id, r.catalog_no, r.era, r.kind, r.series, r.title, r.release_date, r.event,
            r.track_count, r.aliases, r.links, r.note,
        )
        for r in releases
    ]
    slot_rows = [
        (r.id, slot, state.status, state.planned_date, state.note)
        for r in releases
        for slot, state in r.slots.items()
    ]
    return insert(
        "releases",
        ("id", "catalog_no", "era_id", "kind", "series", "title", "release_date", "event",
         "track_count", "aliases", "links", "note"),
        release_rows,
    ) + insert("release_slots", ("release_id", "slot", "status", "planned_date", "note"), slot_rows)


# Columns the import owns: re-running it refreshes these and never touches admin decisions
# (rights, state, release, slot, role, note, ...).
FILE_REFRESH = ("size", "mtime", "sha256", "kind", "format", "pcm_md5", "suggest", "source_seen")


def file_statements(files: list[SurveyFile], suggestions: dict[str, Suggestion | None], seen: str) -> list[str]:
    """Rows for files and archive members; parents must come before their members.

    Every row gets source_seen = seen, and meta.nas_seen is set to it last: rows left with an older
    source_seen were not in this import, i.e. their original is gone from source/.
    """
    rows = []
    for f in files:
        suggestion = suggestions.get(f.file_id)
        rows.append(
            (
                f.file_id, "nas", f.source_path, f.dir, f.member_of, f.member_path, f.name, f.ext, f.size, f.mtime,
                f.sha256, kind_for(f.ext), f.format, f.pcm_md5, f.note, suggestion.to_json() if suggestion else None,
                seen,
            )
        )
    return insert(
        "files",
        ("id", "origin", "source_path", "dir", "member_of", "member_path", "name", "ext", "size", "mtime",
         "sha256", "kind", "format", "pcm_md5", "note", "suggest", "source_seen"),
        rows,
        refresh=FILE_REFRESH,
    ) + [f"INSERT INTO meta (key, value) VALUES ('nas_seen', {q(seen)}) ON CONFLICT (key) DO UPDATE SET value = excluded.value;"]
