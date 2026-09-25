"""Path-based classification suggestions (rules/mapping.yaml).

Rules are tried in order and the first match wins. A rule that names a release but cannot find it
(e.g. a title that matches no catalog entry) does not match, so a later, broader rule can apply.
Suggestions are only proposals: the admin confirms them in the 整理台.
"""

import re
import unicodedata
from dataclasses import asdict, dataclass
from pathlib import Path, PurePosixPath

import yaml

from .catalog import Release
from .model import ERAS, FILE_STATES, RIGHTS, SLOTS
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


@dataclass(frozen=True)
class Suggestion:
    rule: str
    confidence: float
    release_id: str | None = None
    slot: str | None = None
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
        if raw.get("slot") and release is None:
            raise ValueError(f"rule {name!r}: a slot needs a release")
        rules.append(
            Rule(
                name=name,
                confidence=float(raw.get("confidence", 0.5)),
                pattern=pattern,
                exts=exts,
                release=release,
                slot=raw.get("slot"),
                rights=raw.get("rights"),
                role=raw.get("role"),
                state=raw.get("state"),
                note=raw.get("note"),
            )
        )
    return rules


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
            return Suggestion(
                rule=rule.name,
                confidence=rule.confidence,
                release_id=release_id,
                slot=rule.slot,
                rights=rule.rights,
                role=rule.role,
                state=rule.state,
                note=rule.note,
            )
        return None
