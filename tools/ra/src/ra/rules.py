"""Path-based classification suggestions (rules/mapping.yaml).

Rules are tried in order and the first match wins. A rule that names a release but cannot find it
(e.g. a title that matches no catalog entry) does not match, so a later, broader rule can apply.
Suggestions are only proposals: the admin confirms them in the 整理台, which puts the file at the
suggested place (an edition of the release, or a folder), making the edition or folders when missing.
"""

import re
import unicodedata
from dataclasses import asdict, dataclass
from pathlib import Path, PurePosixPath

import yaml

from .catalog import Release
from .model import ERAS, EXT_KIND, FILE_STATES, RIGHTS, SLOTS
from .survey import SurveyFile

_ZERO_WIDTH = re.compile("[​-‏⁠﻿]")
_NON_WORD = re.compile(r"[\W_]+")
_FOLD = str.maketrans({"ø": "o", "Ø": "o", "æ": "ae", "Æ": "ae", "œ": "oe", "Œ": "oe", "ß": "ss", "đ": "d", "ł": "l"})


def normalize(text: str) -> str:
    """Fold case, accents, full-width forms and punctuation so names compare loosely."""
    text = _ZERO_WIDTH.sub("", text).translate(_FOLD)
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch)).casefold()
    return " ".join(_NON_WORD.sub(" ", text).split())


# Folder names in the site are at most this long.
MAX_FOLDER_NAME = 200
# Files a rule may keep whole (archives and disc images).
ARCHIVE_EXTS = frozenset(ext for ext, kind in EXT_KIND.items() if kind in ("archive", "disc_image"))


@dataclass(frozen=True)
class Suggestion:
    rule: str
    confidence: float
    release_id: str | None = None
    slot: str | None = None
    edition: str | None = None  # name of the release's edition of that slot ('' = the slot's default one)
    edition_catalog: str | None = None
    folder: str | None = None  # '/'-separated, under the edition / release / era, or at the top
    era_id: str | None = None  # where the folder hangs when there is no release
    seal: bool | None = None  # keep the archive whole
    readme: bool | None = None  # the file describes its folder
    rights: str | None = None
    role: str | None = None
    state: str | None = None
    note: str | None = None

    def to_json(self) -> dict:
        return {k: v for k, v in asdict(self).items() if v is not None}


class ReleaseIndex:
    def __init__(self, releases: list[Release]):
        self.releases = releases
        self.by_id = {r.id: r for r in releases}
        self.by_catalog = {r.catalog_no.upper(): r for r in releases if r.catalog_no}
        self._names = [(r, [n for n in (normalize(x) for x in r.names) if n]) for r in releases]

    def by_title(self, text: str, era: str | None = None) -> Release | None:
        """Release whose title or alias appears (as whole words) in text; the longest name wins."""
        haystack = f" {normalize(text)} "
        best, best_len, tie = None, 0, False
        for release, names in self._names:
            if era and release.era != era:
                continue
            for name in names:
                if f" {name} " not in haystack:
                    continue
                if len(name) > best_len:
                    best, best_len, tie = release, len(name), False
                elif len(name) == best_len and release is not best:
                    tie = True
        return None if tie else best


@dataclass(frozen=True)
class Rule:
    name: str
    confidence: float
    pattern: re.Pattern | None = None
    exts: frozenset[str] | None = None
    release: dict | None = None
    slot: str | None = None
    edition: dict | None = None  # {"name": str, "catalog": group name}
    folder: str | None = None
    keep: bool = False  # add the folders below the end of the match to the place
    era: str | None = None
    seal: bool = False
    readme: bool = False
    rights: str | None = None
    role: str | None = None
    state: str | None = None
    note: str | None = None


def _check(value, allowed, what, rule_name):
    if value is not None and value not in allowed:
        raise ValueError(f"rule {rule_name!r}: unknown {what} {value!r}")


def parse_rules(raw_rules: list[dict], index: ReleaseIndex) -> list[Rule]:
    rules = []
    for raw in raw_rules:
        name = raw.get("name") or raw.get("match") or "?"
        pattern = re.compile(raw["match"]) if raw.get("match") else None
        exts = frozenset(e.lower() for e in raw["ext"]) if raw.get("ext") else None
        if pattern is None and exts is None:
            raise ValueError(f"rule {name!r}: needs 'match' or 'ext'")
        release = raw.get("release")
        if isinstance(release, str):
            release = {"id": release}
        if release is not None:
            if "id" in release and release["id"] not in index.by_id:
                raise ValueError(f"rule {name!r}: unknown release {release['id']!r}")
            for key in ("catalog", "title"):
                group = release.get(key)
                if group and group != "$name" and (pattern is None or group not in pattern.groupindex):
                    raise ValueError(f"rule {name!r}: pattern has no group {group!r}")
            _check(release.get("era"), ERAS, "era", name)
        _check(raw.get("slot"), SLOTS, "slot", name)
        _check(raw.get("rights"), RIGHTS, "rights", name)
        _check(raw.get("state"), FILE_STATES, "state", name)
        _check(raw.get("era"), ERAS, "era", name)
        if raw.get("slot") and release is None:
            raise ValueError(f"rule {name!r}: a slot needs a release")
        edition = raw.get("edition")
        if isinstance(edition, str):
            edition = {"name": edition}
        if edition is not None:
            if not raw.get("slot"):
                raise ValueError(f"rule {name!r}: an edition needs a slot")
            group = edition.get("catalog")
            if group and (pattern is None or group not in pattern.groupindex):
                raise ValueError(f"rule {name!r}: pattern has no group {group!r}")
        folder = raw.get("folder")
        if folder is not None and (not isinstance(folder, str) or any(not part.strip() for part in folder.split("/"))):
            raise ValueError(f"rule {name!r}: bad folder {folder!r}")
        if raw.get("keep") and pattern is None:
            raise ValueError(f"rule {name!r}: keep needs a match pattern")
        if raw.get("era") and release is not None:
            raise ValueError(f"rule {name!r}: era is for folders outside a release")
        rules.append(
            Rule(
                name=name,
                confidence=float(raw.get("confidence", 0.5)),
                pattern=pattern,
                exts=exts,
                release=release,
                slot=raw.get("slot"),
                edition=edition,
                folder=folder,
                keep=bool(raw.get("keep")),
                era=raw.get("era"),
                seal=bool(raw.get("seal")),
                readme=bool(raw.get("readme")),
                rights=raw.get("rights"),
                role=raw.get("role"),
                state=raw.get("state"),
                note=raw.get("note"),
            )
        )
    return rules


def kept_folders(path: str, match: re.Match) -> list[str]:
    """The folders of `path` below the end of the match: '…/<match>a/b/file' → ['a', 'b']."""
    rest = path[match.end():].strip("/")
    parts = rest.split("/")[:-1] if rest else []
    return [p[:MAX_FOLDER_NAME] for p in parts if p]


class RuleSet:
    def __init__(self, rules: list[Rule], index: ReleaseIndex):
        self.rules = rules
        self.index = index

    @classmethod
    def load(cls, path: Path, releases: list[Release]) -> "RuleSet":
        index = ReleaseIndex(releases)
        with path.open(encoding="utf-8") as fh:
            return cls(parse_rules(yaml.safe_load(fh) or [], index), index)

    def _release(self, spec: dict, match: re.Match | None, f: SurveyFile) -> Release | None:
        if "id" in spec:
            return self.index.by_id[spec["id"]]
        if "catalog" in spec:
            return self.index.by_catalog.get(match.group(spec["catalog"]).upper())
        if "title" in spec:
            source = spec["title"]
            text = PurePosixPath(f.name).stem if source == "$name" else match.group(source)
            return self.index.by_title(text, spec.get("era"))
        raise ValueError(f"release spec needs id, catalog or title: {spec}")

    def suggest(self, f: SurveyFile) -> Suggestion | None:
        for rule in self.rules:
            if rule.exts is not None and f.ext not in rule.exts:
                continue
            match = None
            if rule.pattern is not None:
                match = rule.pattern.search(f.path)
                if match is None:
                    continue
            release_id = None
            if rule.release is not None:
                release = self._release(rule.release, match, f)
                if release is None:
                    continue
                release_id = release.id
            folders = rule.folder.split("/") if rule.folder else []
            if rule.keep and match is not None:
                folders += kept_folders(f.path, match)
            edition = rule.edition or {}
            catalog = edition.get("catalog")
            return Suggestion(
                rule=rule.name,
                confidence=rule.confidence,
                release_id=release_id,
                slot=rule.slot,
                edition=edition.get("name", "") if rule.slot else None,
                edition_catalog=match.group(catalog).upper() if catalog and match and match.group(catalog) else None,
                folder="/".join(folders) or None,
                era_id=rule.era,
                seal=True if rule.seal and f.ext in ARCHIVE_EXTS else None,
                readme=True if rule.readme else None,
                rights=rule.rights,
                role=rule.role,
                state=rule.state,
                note=rule.note,
            )
        return None
