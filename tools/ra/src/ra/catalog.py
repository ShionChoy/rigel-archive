"""Load and validate the release catalog YAML (same shape as the daily export)."""

import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from .model import ERAS, RELEASE_KINDS, SLOT_STATUSES, SLOTS

_DATE = re.compile(r"^\d{4}(-\d{2}(-\d{2})?)?$")
_SLUG = re.compile(r"^[a-z0-9][a-z0-9-]*$")


class CatalogError(ValueError):
    pass


@dataclass(frozen=True)
class SlotState:
    status: str
    note: str | None = None
    planned_date: str | None = None


@dataclass
class Release:
    id: str
    era: str
    kind: str
    title: str
    catalog_no: str | None = None
    series: str | None = None
    release_date: str | None = None
    event: str | None = None
    track_count: int | None = None
    aliases: list[str] = field(default_factory=list)
    links: dict[str, str] = field(default_factory=dict)
    note: str | None = None
    slots: dict[str, SlotState] = field(default_factory=dict)

    @property
    def names(self) -> list[str]:
        return [self.title, *self.aliases]


def _slot_state(release_id: str, slot: str, raw) -> SlotState:
    if isinstance(raw, str):
        raw = {"status": raw}
    if not isinstance(raw, dict):
        raise CatalogError(f"{release_id}.{slot}: expected a status string or a mapping")
    status = raw.get("status")
    if status not in SLOT_STATUSES:
        raise CatalogError(f"{release_id}.{slot}: unknown status {status!r}")
    planned = raw.get("planned_date")
    if planned is not None:
        planned = str(planned)
        if not _DATE.match(planned):
            raise CatalogError(f"{release_id}.{slot}: bad planned_date {planned!r}")
    return SlotState(status=status, note=raw.get("note"), planned_date=planned)


def parse_catalog(data: dict) -> list[Release]:
    default_status = (data.get("defaults") or {}).get("slot_status")
    if default_status is not None and default_status not in SLOT_STATUSES:
        raise CatalogError(f"defaults.slot_status: unknown status {default_status!r}")

    releases: list[Release] = []
    seen_ids: set[str] = set()
    seen_catalog: set[str] = set()
    for raw in data.get("releases") or []:
        rid = raw.get("id")
        if not rid or not _SLUG.match(rid):
            raise CatalogError(f"bad release id {rid!r}")
        if rid in seen_ids:
            raise CatalogError(f"duplicate release id {rid}")
        seen_ids.add(rid)

        if raw.get("era") not in ERAS:
            raise CatalogError(f"{rid}: unknown era {raw.get('era')!r}")
        if raw.get("kind") not in RELEASE_KINDS:
            raise CatalogError(f"{rid}: unknown kind {raw.get('kind')!r}")
        if not raw.get("title"):
            raise CatalogError(f"{rid}: title is required")

        catalog_no = raw.get("catalog_no")
        if catalog_no:
            if catalog_no.upper() in seen_catalog:
                raise CatalogError(f"{rid}: duplicate catalog_no {catalog_no}")
            seen_catalog.add(catalog_no.upper())

        release_date = raw.get("release_date")
        if release_date is not None:
            release_date = str(release_date)
            if not _DATE.match(release_date):
                raise CatalogError(f"{rid}: bad release_date {release_date!r}")

        raw_slots = raw.get("slots") or {}
        unknown_slots = set(raw_slots) - set(SLOTS)
        if unknown_slots:
            raise CatalogError(f"{rid}: unknown slots {sorted(unknown_slots)}")
        slots = {}
        for slot in SLOTS:
            if slot in raw_slots:
                slots[slot] = _slot_state(rid, slot, raw_slots[slot])
            elif default_status is not None:
                slots[slot] = SlotState(status=default_status)
            else:
                # Every edition slot must carry a status so the page can show a placeholder.
                raise CatalogError(f"{rid}: slot {slot} has no status")

        releases.append(
            Release(
                id=rid,
                era=raw["era"],
                kind=raw["kind"],
                title=raw["title"],
                catalog_no=catalog_no,
                series=raw.get("series"),
                release_date=release_date,
                event=raw.get("event"),
                track_count=raw.get("track_count"),
                aliases=list(raw.get("aliases") or []),
                links=dict(raw.get("links") or {}),
                note=raw.get("note"),
                slots=slots,
            )
        )
    return releases


def load_catalog(path: Path) -> list[Release]:
    with path.open(encoding="utf-8") as fh:
        return parse_catalog(yaml.safe_load(fh) or {})
