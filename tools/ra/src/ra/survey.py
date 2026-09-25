"""Read the read-only NAS inventory taken on 2026-09-23 (listing.tsv).

Each line is ``type<TAB>size<TAB>date<TAB>windows path`` where type is ``F`` (file) or ``D`` (directory).
Paths are converted to '/'-separated paths relative to the 合辑 root.
"""

import hashlib
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

ROOT_MARKER = "Rigel Theatre合辑\\"


@dataclass(frozen=True)
class SurveyFile:
    """A file in the 合辑, or a member of an archive in it.

    For archive members ``path`` is virtual: the archive's path followed by the path inside it, so
    path rules, the folder tree and the name/dir/ext properties treat an archive like a folder.
    """

    path: str  # relative, '/' separated
    size: int
    mtime: str | None
    sha256: str | None = None
    archive: str | None = None  # members: path of the top-level archive in the 合辑
    member_path: str | None = None  # members: path inside it; nested archives are joined with "!/"
    member_of: str | None = None  # members: file id of the archive that directly contains it
    note: str | None = None
    format: dict | None = None
    pcm_md5: str | None = None

    @property
    def source_path(self) -> str:
        return self.archive if self.archive is not None else self.path

    @property
    def name(self) -> str:
        return PurePosixPath(self.path).name

    @property
    def dir(self) -> str:
        parent = str(PurePosixPath(self.path).parent)
        return "" if parent == "." else parent

    @property
    def ext(self) -> str:
        suffix = PurePosixPath(self.path).suffix
        return suffix[1:].lower() if suffix else ""

    @property
    def file_id(self) -> str:
        return nas_file_id(self.source_path, self.member_path)


def nas_file_id(path: str, member_path: str | None = None) -> str:
    key = f"nas:{path}" if member_path is None else f"nas:{path}!{member_path}"
    return "f_" + hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]


def relative_path(windows_path: str) -> str:
    idx = windows_path.find(ROOT_MARKER)
    if idx < 0:
        raise ValueError(f"path is outside the 合辑 root: {windows_path}")
    return windows_path[idx + len(ROOT_MARKER):].replace("\\", "/")


def read_listing(path: Path) -> list[SurveyFile]:
    files = []
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        parts = line.split("\t", 3)
        if len(parts) != 4:
            raise ValueError(f"{path}:{lineno}: expected 4 tab-separated fields")
        kind, size, date, win_path = parts
        if kind != "F":
            continue
        files.append(SurveyFile(relative_path(win_path), int(size), date))
    return files
