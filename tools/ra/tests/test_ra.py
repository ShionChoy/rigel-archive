import json
import pytest

from ra.catalog import CatalogError, parse_catalog
from ra.cli import DEFAULT_CATALOG, DEFAULT_RULES
from ra.catalog import load_catalog
from ra.model import SLOTS, kind_for
from ra.rules import ReleaseIndex, RuleSet, normalize, parse_rules
from ra.sql import insert, q
from ra.survey import SurveyFile, nas_file_id, relative_path


def release(rid, title, **extra):
    return {"id": rid, "era": "rigel-theatre", "kind": "album", "title": title, **extra}


# ---------------------------------------------------------------- catalog


def test_every_slot_needs_a_status_without_defaults():
    with pytest.raises(CatalogError, match="slot cd has no status"):
        parse_catalog({"releases": [release("rtcd-001", "SOLROS")]})


def test_default_status_fills_missing_slots():
    (r,) = parse_catalog({"defaults": {"slot_status": "unknown"},
                          "releases": [release("rtcd-001", "SOLROS", slots={"cd": "collected"})]})
    assert list(r.slots) == list(SLOTS)
    assert r.slots["cd"].status == "collected"
    assert r.slots["pv"].status == "unknown"


@pytest.mark.parametrize(
    "bad, message",
    [
        ({"slots": {"cd": "released"}}, "unknown status"),
        ({"slots": {"vinyl": "collected"}}, "unknown slots"),
        ({"release_date": "2014/04/27"}, "bad release_date"),
        ({"kind": "cassette"}, "unknown kind"),
    ],
)
def test_catalog_validation(bad, message):
    data = {"defaults": {"slot_status": "unknown"}, "releases": [release("rtcd-001", "SOLROS", **bad)]}
    with pytest.raises(CatalogError, match=message):
        parse_catalog(data)


def test_duplicate_catalog_numbers_are_rejected():
    data = {"defaults": {"slot_status": "unknown"},
            "releases": [release("a", "A", catalog_no="RTCD-001"), release("b", "B", catalog_no="rtcd-001")]}
    with pytest.raises(CatalogError, match="duplicate catalog_no"):
        parse_catalog(data)


def test_seed_catalog_is_valid():
    releases = load_catalog(DEFAULT_CATALOG)
    assert len(releases) > 40
    assert all(len(r.slots) == len(SLOTS) for r in releases)


# ---------------------------------------------------------------- survey


def test_relative_path_strips_the_nas_root():
    win = "Z:\\share\\Rigel Theatre合辑\\04 Rigel Theatre\\08 PV\\Wendy Port Street.mkv"
    assert relative_path(win) == "04 Rigel Theatre/08 PV/Wendy Port Street.mkv"


def test_file_ids_are_stable_and_distinguish_archive_members():
    assert nas_file_id("a/b.zip") == nas_file_id("a/b.zip")
    assert nas_file_id("a/b.zip") != nas_file_id("a/b.zip", "c.wav")


def test_kind_for_extension():
    assert kind_for("FLAC") == "audio"
    assert kind_for("download") == "fragment"
    assert kind_for("xyz") == "other"


# ---------------------------------------------------------------- rules


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("Äventyr Till N\u200bø\u200brrland", "aventyr till norrland"),
        ("Regulus and Mira： The Great Adventure", "regulus and mira the great adventure"),
        ("Lyla and the Starry  Fairy [XFD ver.]", "lyla and the starry fairy xfd ver"),
        ("ᚣᚢᛚᛖ -YULE-", "ᚣᚢᛚᛖ yule"),
    ],
)
def test_normalize(raw, expected):
    assert normalize(raw) == expected


def _index():
    releases = parse_catalog({
        "defaults": {"slot_status": "unknown"},
        "releases": [
            release("rtcd-006", "Rinn Ding Dong -L'avenir de la Flesvelka-", catalog_no="RTCD-006"),
            release("garnet", "Rinn Ding Dong -Garnet Star-", kind="single"),
            release("rtcd-004", "Lengsel -Ghosts of Memories-", catalog_no="RTCD-004", aliases=["Lengsel"]),
            {**release("gt-solros", "SOLROS"), "era": "grand-thaw"},
        ],
    })
    return releases, ReleaseIndex(releases)


def test_title_match_prefers_the_longest_name():
    _, index = _index()
    assert index.by_title("Rigel Theatre - Miwele - Rinn Ding Dong - Garnet Star").id == "garnet"
    assert index.by_title("Rigel Theatre - Lengsel（缺）").id == "rtcd-004"


def test_title_match_needs_whole_words_and_respects_era():
    _, index = _index()
    assert index.by_title("Lengselx") is None
    assert index.by_title("SOLROS Special Content", era="rigel-theatre") is None
    assert index.by_title("SOLROS Special Content", era="grand-thaw").id == "gt-solros"


def test_rules_first_match_wins_and_unresolved_release_falls_through():
    releases, index = _index()
    rules = RuleSet(parse_rules([
        {"name": "junk", "ext": ["download"], "state": "ignored"},
        {"name": "rip", "match": r"^rips/\[(?P<cat>RTCD-\d{3})A?\]", "release": {"catalog": "cat"},
         "slot": "cd_rip", "rights": "own", "confidence": 0.9},
        {"name": "fallback", "match": "^rips/", "rights": "own", "confidence": 0.3},
    ], index), index)

    s = rules.suggest(SurveyFile("rips/[RTCD-004A] Lengsel/01.flac", 1, "2020-01-01"))
    assert (s.rule, s.release_id, s.slot) == ("rip", "rtcd-004", "cd_rip")

    s = rules.suggest(SurveyFile("rips/[RTCD-999] Unknown/01.flac", 1, "2020-01-01"))
    assert (s.rule, s.release_id) == ("fallback", None)

    s = rules.suggest(SurveyFile("rips/x.download", 1, "2020-01-01"))
    assert s.state == "ignored"


def test_rule_validation():
    _, index = _index()
    with pytest.raises(ValueError, match="unknown slot"):
        parse_rules([{"match": "x", "release": "garnet", "slot": "vinyl"}], index)
    with pytest.raises(ValueError, match="no group"):
        parse_rules([{"match": "x", "release": {"title": "t"}}], index)
    with pytest.raises(ValueError, match="needs a release"):
        parse_rules([{"match": "x", "slot": "pv"}], index)


def test_rules_suggest_editions_folders_and_kept_structure():
    releases, index = _index()
    rules = RuleSet(parse_rules([
        {"name": "rip A", "match": r"^rips/\[(?P<cn>(?P<cat>RTCD-\d{3})A)\][^/]*/", "release": {"catalog": "cat"},
         "slot": "cd_rip", "edition": {"name": "第 2 版", "catalog": "cn"}, "keep": True, "rights": "own"},
        {"name": "rip", "match": r"^rips/\[(?P<cat>RTCD-\d{3})\][^/]*/", "release": {"catalog": "cat"}, "slot": "cd_rip"},
        {"name": "web", "match": "^web/", "era": "rigel-theatre", "folder": "官网存档", "keep": True},
        {"name": "bms", "match": "^bms/", "era": "grand-thaw", "folder": "BMS", "seal": True},
        {"name": "readme", "match": r"^notes/说明\.txt$", "folder": "关于/说明", "readme": True},
    ], index), index)

    s = rules.suggest(SurveyFile("rips/[RTCD-004A] Lengsel/Scans/1.jpg", 1, None))
    assert (s.release_id, s.slot, s.edition, s.edition_catalog, s.folder) == ("rtcd-004", "cd_rip", "第 2 版", "RTCD-004A", "Scans")
    s = rules.suggest(SurveyFile("rips/[RTCD-004] Lengsel/01.flac", 1, None))
    assert (s.edition, s.edition_catalog, s.folder) == ("", None, None)
    s = rules.suggest(SurveyFile("web/20200616/rigeltheatre/index.html", 1, None))
    assert (s.era_id, s.folder, s.release_id) == ("rigel-theatre", "官网存档/20200616/rigeltheatre", None)
    assert rules.suggest(SurveyFile("bms/x.rar", 1, None)).seal is True
    assert rules.suggest(SurveyFile("bms/x.ogg", 1, None)).seal is None  # only archives are kept whole
    s = rules.suggest(SurveyFile("notes/说明.txt", 1, None))
    assert (s.folder, s.readme) == ("关于/说明", True)
    assert "seal" not in s.to_json() and s.to_json()["readme"] is True


def test_new_rule_keys_are_validated():
    _, index = _index()
    with pytest.raises(ValueError, match="edition needs a slot"):
        parse_rules([{"match": "x", "release": "garnet", "edition": "初版"}], index)
    with pytest.raises(ValueError, match="bad folder"):
        parse_rules([{"match": "x", "folder": "a//b"}], index)
    with pytest.raises(ValueError, match="unknown era"):
        parse_rules([{"match": "x", "era": "nope", "folder": "a"}], index)
    with pytest.raises(ValueError, match="era is for folders"):
        parse_rules([{"match": "x", "release": "garnet", "era": "grand-thaw"}], index)


def test_project_rules_load():
    RuleSet.load(DEFAULT_RULES, load_catalog(DEFAULT_CATALOG))


# ---------------------------------------------------------------- sql


def test_quote():
    assert q(None) == "NULL"
    assert q(3) == "3"
    assert q("Prière à L'Ange") == "'Prière à L''Ange'"
    assert q({"b": 1, "a": "é"}) == """'{"a":"é","b":1}'"""
    with pytest.raises(ValueError):
        q("a\x00b")


def test_seed_skips_releases_deleted_in_the_admin_and_gives_new_ones_folders(tmp_path):
    """The seed SQL runs against the real schema: a release deleted in the admin stays deleted, a new
    one gets its folder under its era's folder, slots only go to releases that exist."""
    import sqlite3

    from ra.catalog import load_catalog
    from ra.cli import REPO
    from ra.sql import release_statements

    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys = ON")
    for path in sorted((REPO / "site" / "migrations").glob("*.sql")):
        db.executescript("BEGIN;\n" + path.read_text(encoding="utf-8") + "\nCOMMIT;")
    releases = load_catalog(REPO / "data" / "seed" / "catalog.yaml")
    gone = releases[0].id
    db.execute(
        "INSERT INTO revisions (actor, batch_id, summary, entity, entity_id, action) VALUES ('x', 'b', 's', 'release', ?, 'delete')",
        (gone,),
    )
    for statement in release_statements(releases):
        db.execute(statement)
    ids = {r[0] for r in db.execute("SELECT id FROM releases")}
    assert gone not in ids and len(ids) == len(releases) - 1
    assert db.execute("SELECT count(*) FROM release_slots WHERE release_id = ?", (gone,)).fetchone()[0] == 0
    orphans = db.execute(
        """SELECT count(*) FROM releases r WHERE NOT EXISTS (
             SELECT 1 FROM folders f JOIN folders p ON p.id = f.parent_id WHERE f.release_id = r.id AND p.era_id = r.era_id)"""
    ).fetchone()[0]
    assert orphans == 0
    # Running it again changes nothing.
    before = db.execute("SELECT count(*) FROM folders").fetchone()[0]
    for statement in release_statements(releases):
        db.execute(statement)
    assert db.execute("SELECT count(*) FROM folders").fetchone()[0] == before


def test_insert_batches_rows():
    statements = insert("t", ("a",), [(i,) for i in range(120)])
    assert len(statements) == 3
    assert statements[0].startswith("INSERT OR IGNORE INTO t (a) VALUES")


# ---------------------------------------------------------------- scan / serve


def test_windows_name_round_trip():
    from ra.scan import linux_name, windows_name

    raw = "a\x14b:c.jpg".encode()
    assert windows_name(raw) == "abc.jpg"
    assert linux_name(windows_name(raw)) == "a\x14b:c.jpg"
    assert windows_name("画像/1.jpg".encode()) == "画像/1.jpg"


@pytest.mark.parametrize(
    "header, expected",
    [(None, None), ("bytes=0-99", (0, 99)), ("bytes=900-", (900, 999)), ("bytes=-100", (900, 999)),
     ("bytes=990-2000", (990, 999)), ("items=0-1", None)],
)
def test_parse_range(header, expected):
    from ra.serve import parse_range

    assert parse_range(header, 1000) == expected


def test_parse_range_unsatisfiable():
    from ra.serve import parse_range

    with pytest.raises(ValueError):
        parse_range("bytes=1000-", 1000)


def test_serve_refuses_paths_outside_root(tmp_path):
    import threading
    import urllib.error
    import urllib.request
    from http.server import ThreadingHTTPServer

    from ra.serve import make_handler

    root = tmp_path / "source"
    (root / "a").mkdir(parents=True)
    (root / "a" / "x.txt").write_bytes(b"0123456789")
    (tmp_path / "secret.txt").write_text("no")
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(root))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        req = urllib.request.Request(f"{base}/source/a/x.txt", headers={"Range": "bytes=2-4"})
        with urllib.request.urlopen(req) as res:
            assert res.status == 206
            assert res.read() == b"234"
            assert res.headers["Access-Control-Allow-Origin"] == "*"
        for bad in ("/source/../secret.txt", "/source/%2e%2e/secret.txt", "/secret.txt"):
            with pytest.raises(urllib.error.HTTPError) as err:
                urllib.request.urlopen(base + bad)
            assert err.value.code == 404
    finally:
        server.shutdown()
        server.server_close()


# ---------------------------------------------------------------- extract / archive members


def test_choose_encoding():
    from ra.extract import choose_encoding

    assert choose_encoding([b"readme.txt"]) is None
    assert choose_encoding(["画像/ジャケット3.jpg".encode("cp932")]) == "cp932"
    assert choose_encoding(["物思いの街角/readme.txt".encode("cp932"), b"x.mid"]) == "cp932"
    assert choose_encoding(["冬之回响/说明文件.txt".encode("gbk")]) == "gbk"
    assert choose_encoding(["Älvorna/ジャケット.flac".encode("utf-8")]) == "utf-8"


def _legacy_zip(path, entries: dict[str, bytes]) -> None:
    """A zip whose names are stored in Shift-JIS without the UTF-8 flag, like old Windows tools wrote."""
    import zipfile

    class LegacyInfo(zipfile.ZipInfo):
        __slots__ = ()

        def _encodeFilenameFlags(self):
            return self.filename.encode("cp932"), self.flag_bits

    with zipfile.ZipFile(path, "w") as zf:
        for name, data in entries.items():
            zf.writestr(LegacyInfo(name), data)


@pytest.mark.skipif(__import__("shutil").which("7z") is None, reason="needs 7-Zip")
def test_extract_decodes_legacy_names_and_unpacks_nested_archives(tmp_path):
    import hashlib
    import io
    import zipfile

    from ra.extract import Extractor, load_records

    inner = io.BytesIO()
    with zipfile.ZipFile(inner, "w") as zf:
        zf.writestr("readme.txt", b"inner")
    outer = tmp_path / "outer.zip"
    _legacy_zip(outer, {"画像/ジャケット3.jpg": b"jpeg", "inner.zip": inner.getvalue()})
    sha = hashlib.sha256(outer.read_bytes()).hexdigest()

    extractor = Extractor(tmp_path / "extracted", tmp_path / "manifest", log=lambda msg: None)
    record = extractor.extract(outer, sha, "outer.zip")

    assert record.status == "ok" and record.encoding == "cp932"
    members = {m.path: m for m in record.members}
    assert set(members) == {"画像/ジャケット3.jpg", "inner.zip"}
    assert members["画像/ジャケット3.jpg"].sha256 == hashlib.sha256(b"jpeg").hexdigest()
    assert (tmp_path / "extracted" / sha[:16] / "画像" / "ジャケット3.jpg").read_bytes() == b"jpeg"
    records = load_records(tmp_path / "manifest")
    assert [m.path for m in records[members["inner.zip"].sha256].members] == ["readme.txt"]

    # A second run finds everything done and unpacks nothing.
    again = Extractor(tmp_path / "extracted", tmp_path / "manifest", log=lambda msg: pytest.fail(msg))
    assert again.extract(outer, sha, "outer.zip").members == record.members


def test_expand_lists_members_under_their_archive():
    from ra.extract import ArchiveRecord, Member
    from ra.members import expand

    records = {
        "a" * 64: ArchiveRecord("a" * 64, 10, "x.zip", "zip", members=[
            Member("d/1.wav", 4, sha256="1" * 64), Member("in.lzh", 3, sha256="b" * 64)]),
        "b" * 64: ArchiveRecord("b" * 64, 3, "in.lzh", "lzh", encoding="cp932", members=[Member("2.mid", 2, sha256="2" * 64)]),
    }
    files = expand([SurveyFile("top/x.zip", 10, "2020-01-01T00:00:00Z", "a" * 64)], records)
    by_path = {f.path: f for f in files}
    assert list(by_path) == ["top/x.zip", "top/x.zip/d/1.wav", "top/x.zip/in.lzh", "top/x.zip/in.lzh/2.mid"]
    archive, wav, lzh, mid = files
    assert archive.format == {"archive": "zip", "files": 2, "status": "ok"}
    assert wav.dir == "top/x.zip/d" and wav.source_path == "top/x.zip" and wav.member_path == "d/1.wav"
    assert wav.file_id == nas_file_id("top/x.zip", "d/1.wav") and wav.member_of == archive.file_id
    assert lzh.format["encoding"] == "cp932"
    assert mid.member_path == "in.lzh!/2.mid" and mid.member_of == lzh.file_id


def test_archive_with_all_members_loose_is_an_original_package():
    from ra.extract import ArchiveRecord, Member
    from ra.members import PACKAGE_ROLE, expand, suggest_all

    records = {"a" * 64: ArchiveRecord("a" * 64, 10, "RJ1.zip", "zip", members=[
        Member("RJ1/1.mp3", 4, sha256="1" * 64), Member("RJ1/画像/2.jpg", 4, sha256="2" * 64)])}
    loose = [
        SurveyFile("dl/RJ1.zip", 10, None, "a" * 64),
        SurveyFile("dl/RJ1/1.mp3", 4, None, "1" * 64),
        SurveyFile("dl/RJ1/画像/2.jpg", 4, None, "2" * 64),
    ]
    rules = RuleSet([], ReleaseIndex([]))
    suggestions = suggest_all(expand(loose, records), records, rules)
    s = suggestions[loose[0].file_id]
    assert s.role == PACKAGE_ROLE and s.seal is True and "dl/RJ1" in s.note

    partial = expand(loose[:2], records)  # the jpg exists only inside the archive
    assert suggest_all(partial, records, rules)[loose[0].file_id] is None


def test_insert_refresh_upserts_only_the_named_columns():
    (statement,) = insert("files", ("id", "suggest", "state"), [("f_1", "{}", "inbox")], refresh=("suggest",))
    assert statement.startswith("INSERT INTO files")
    assert statement.endswith("ON CONFLICT (id) DO UPDATE SET suggest = excluded.suggest;")


def test_blob_index_prefers_loose_files(tmp_path):
    import json

    from ra.extract import ArchiveRecord, Member, write_record
    from ra.serve import BlobIndex

    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "a.flac").write_bytes(b"a")
    (tmp_path / "ext" / "0123456789abcdef" / "d").mkdir(parents=True)
    (tmp_path / "ext" / "0123456789abcdef" / "d" / "a.flac").write_bytes(b"a")
    (tmp_path / "ext" / "0123456789abcdef" / "d" / "b.png").write_bytes(b"b")
    (tmp_path / "scan.jsonl").write_text(json.dumps({"path": "a.flac", "size": 1, "mtime": "x", "sha256": "1" * 64}) + "\n")
    write_record(tmp_path / "manifest", ArchiveRecord("0123456789abcdef" + "0" * 48, 2, "x.zip", "zip", members=[
        Member("d/a.flac", 1, sha256="1" * 64), Member("d/b.png", 1, sha256="2" * 64)]))

    index = BlobIndex(tmp_path / "src", tmp_path / "scan.jsonl", tmp_path / "ext", tmp_path / "manifest")
    assert index.find("1" * 64) == tmp_path / "src" / "a.flac"
    assert index.find("2" * 64) == tmp_path / "ext" / "0123456789abcdef" / "d" / "b.png"
    assert index.find("3" * 64) is None


# ---------------------------------------------------------------- probe


@pytest.mark.skipif(__import__("shutil").which("ffmpeg") is None, reason="needs ffmpeg")
@pytest.mark.parametrize("bits", [16, 24])
def test_wav_and_its_flac_share_a_pcm_md5(tmp_path, bits):
    import subprocess
    import wave

    from ra.probe import flac_md5, probe_one, wav_pcm_md5

    wav = tmp_path / "a.wav"
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(bits // 8)
        w.setframerate(44100)
        w.writeframes(bytes(range(256)) * 60 * (bits // 8))
    flac = tmp_path / "a.flac"
    subprocess.run(["ffmpeg", "-v", "error", "-i", str(wav), "-metadata", "title=Aventyr", str(flac)], check=True)

    assert wav_pcm_md5(wav) == flac_md5(flac) is not None
    item = probe_one("f" * 64, flac)
    assert item["pcm_md5"] == flac_md5(flac)
    assert item["format"]["codec"] == "flac" and item["format"]["bits"] == bits and item["format"]["lossless"]
    assert item["format"]["rate"] == 44100 and item["format"]["tags"] == {"title": "Aventyr"}


def test_summarize_video_and_image():
    from ra.probe import summarize

    video = {
        "format": {"format_name": "matroska,webm", "duration": "225.5", "bit_rate": "8000000"},
        "streams": [
            {"codec_type": "video", "codec_name": "h264", "width": 1920, "height": 1080, "avg_frame_rate": "30000/1001"},
            {"codec_type": "audio", "codec_name": "aac", "sample_rate": "48000", "channels": 2},
        ],
    }
    assert summarize("video", video) == {
        "container": "matroska", "vcodec": "h264", "width": 1920, "height": 1080, "fps": 29.97,
        "acodec": "aac", "rate": 48000, "channels": 2, "duration": 225.5, "kbps": 8000,
    }
    image = {"format": {}, "streams": [{"codec_type": "video", "codec_name": "png", "width": 1400, "height": 1400}]}
    assert summarize("image", image) == {"codec": "png", "width": 1400, "height": 1400}


def test_site_kind_map_matches_model():
    import re

    from ra.cli import REPO
    from ra.model import _EXT_KINDS

    ts = (REPO / "site" / "src" / "lib" / "constants.ts").read_text(encoding="utf-8")
    block = ts.split("// ext-kinds:start", 1)[1].split("// ext-kinds:end", 1)[0]
    site = dict(re.findall(r"^\s*(\w+): '([^']*)',$", block, re.M))
    assert site == _EXT_KINDS


def test_site_file_columns_match_migrations():
    import re

    from ra.cli import REPO

    sql = "\n".join(p.read_text(encoding="utf-8") for p in sorted((REPO / "site" / "migrations").glob("*.sql")))
    body = sql.split("CREATE TABLE files (", 1)[1].split("\n);", 1)[0]
    columns = [m for m in re.findall(r"^\s{2}(\w+)\s+[A-Z]", body, re.M) if m not in ("CHECK", "UNIQUE")]
    columns += re.findall(r"ALTER TABLE files ADD COLUMN (\w+)", sql)
    ts = (REPO / "site" / "src" / "lib" / "changes.ts").read_text(encoding="utf-8")
    listed = re.findall(r"'(\w+)'", ts.split("export const FILE_COLUMNS = [", 1)[1].split("]", 1)[0])
    assert listed == columns


# ---------------------------------------------------------------- worker


class _StubSite:
    def __init__(self, content: bytes):
        self.content = content
        self.reports = []

    def download(self, sha256, dest):
        import hashlib

        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(self.content)
        return hashlib.sha256(self.content).hexdigest()

    def report(self, sha256, **result):
        self.reports.append((sha256, result))
        return 1


def test_worker_verifies_and_probes_uploads(tmp_path):
    import hashlib
    import io
    import wave

    from ra.worker import process

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(44100)
        w.writeframes(bytes(4000))
    content = buf.getvalue()
    sha = hashlib.sha256(content).hexdigest()

    site = _StubSite(content)
    result = process(site, {"sha256": sha, "name": "a.wav", "ext": "wav"}, tmp_path, tmp_path / "tmp")
    assert result["pcm_md5"] == hashlib.md5(bytes(4000)).hexdigest()
    assert result["format"]["codec"] == "pcm_s16le" and result["format"]["rate"] == 44100
    assert site.reports == [(sha, result)]
    assert (tmp_path / f"{sha}.wav").read_bytes() == content

    corrupt = _StubSite(b"not what was hashed")
    result = process(corrupt, {"sha256": "0" * 64, "name": "b.flac", "ext": "flac"}, tmp_path, tmp_path / "tmp")
    assert "error" in result and not (tmp_path / f"{'0' * 64}.flac").exists()


def test_site_settings_come_from_cloud_env_or_dev_vars(tmp_path, monkeypatch):
    from ra.site import client_from_env, read_env_file

    for key in ("RA_SITE", "RA_WORKER_TOKEN", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET"):
        monkeypatch.delenv(key, raising=False)
    dev = tmp_path / ".dev.vars"
    dev.write_text('MEDIA_DEV_BASE=http://x\nWORKER_TOKEN="abc123"\n')
    cloud = tmp_path / "cloud.env"
    cloud.write_bytes("# comment\r\nCF_ACCESS_CLIENT_ID=id.access\r\nCF_ACCESS_CLIENT_SECRET=\r\n".encode())
    assert read_env_file(cloud) == {"CF_ACCESS_CLIENT_ID": "id.access", "CF_ACCESS_CLIENT_SECRET": ""}

    local = client_from_env(None, dev, cloud)  # no RA_SITE: the local dev site with the .dev.vars token
    assert local.base == "http://localhost:4321" and local.http.headers["authorization"] == "Bearer abc123"
    try:
        client_from_env(None, dev, cloud.with_name("none"))  # nothing configured for a deployed site
    except ValueError:
        pass
    cloud.write_text("RA_SITE=https://a.example.workers.dev\nRA_WORKER_TOKEN=t\nCF_ACCESS_CLIENT_ID=i\n")
    try:
        client_from_env(None, dev, cloud)
        raise AssertionError("missing secret accepted")
    except ValueError as exc:
        assert "CF_ACCESS_CLIENT_SECRET" in str(exc)
    # pasted the way the dashboard shows them, as request headers
    cloud.write_text("RA_SITE=https://a.example.workers.dev\nRA_WORKER_TOKEN=t\n"
                     "CF_ACCESS_CLIENT_ID=CF-Access-Client-Id: i.access\nCF_ACCESS_CLIENT_SECRET=CF-Access-Client-Secret: s\n")
    remote = client_from_env(None, dev, cloud)
    assert remote.http.headers["cf-access-client-id"] == "i.access" and remote.http.headers["cf-access-client-secret"] == "s"
    assert remote.http.headers["authorization"] == "Bearer t"


class FakeSite:
    """The site's /admin/api/worker/* endpoints, over httpx.MockTransport."""

    def __init__(self, files=()):
        import hashlib

        self.blobs: dict[str, bytes] = {}
        self.uploads: dict[str, dict[int, bytes]] = {}
        self.files = [dict(f) for f in files]  # rows: sha256, size, name, blob_key, origin, ext
        self.results: dict[str, dict] = {}
        self.members: dict[str, list] = {}
        self.fail_parts = 0
        self.hashlib = hashlib

    def client(self):
        import httpx

        from ra.site import SiteClient

        return SiteClient("https://site.test", "t", "i", "s", transport=httpx.MockTransport(self.handle), retries=1)

    def handle(self, request):
        import httpx

        path, method = request.url.path, request.method
        assert request.headers["authorization"] == "Bearer t"
        body = json.loads(request.content) if request.headers.get("content-type") == "application/json" else None
        if path == "/admin/api/worker/wanted":
            after = request.url.params.get("after", "")
            limit = int(request.url.params["limit"])
            want = sorted({f["sha256"]: f for f in self.files if f["blob_key"] is None and f["sha256"] > after}.values(),
                          key=lambda f: f["sha256"])[:limit]
            items = [{"sha256": f["sha256"], "size": f["size"], "name": f["name"], "ext": f["ext"]} for f in want]
            return httpx.Response(200, json={"items": items, "next": items[-1]["sha256"] if len(items) == limit else None})
        if path == "/admin/api/worker/have":
            return httpx.Response(200, json={"have": {s: len(self.blobs[s]) for s in body["shas"] if s in self.blobs}})
        if path == "/admin/api/worker/stored":
            n = 0
            for f in self.files:
                if f["sha256"] in body["shas"] and f["sha256"] in self.blobs and f["blob_key"] is None:
                    f["blob_key"] = "blobs/" + f["sha256"]
                    n += 1
            return httpx.Response(200, json={"updated": n})
        if path.startswith("/admin/api/worker/blob/"):
            sha = path.rsplit("/", 1)[1]
            if method == "PUT":
                if self.hashlib.sha256(request.content).hexdigest() != sha:
                    return httpx.Response(400, json={"error": "sha256 mismatch"})
                self.blobs[sha] = request.content
                return httpx.Response(200, json={"size": len(request.content)})
            return httpx.Response(200, content=self.blobs[sha])
        if path.startswith("/admin/api/worker/multipart/"):
            sha = path.rsplit("/", 1)[1]
            if method == "PUT":
                if self.fail_parts:
                    self.fail_parts -= 1
                    return httpx.Response(503, json={"error": "try again"})
                n = int(request.url.params["part"])
                self.uploads[request.url.params["uploadId"]][n] = request.content
                return httpx.Response(200, json={"partNumber": n, "etag": f"e{n}"})
            if body["action"] == "create":
                self.uploads[sha] = {}
                return httpx.Response(200, json={"uploadId": sha})
            if body["action"] == "complete":
                parts = self.uploads.pop(body["uploadId"])
                self.blobs[sha] = b"".join(parts[p["partNumber"]] for p in body["parts"])
                return httpx.Response(200, json={"size": len(self.blobs[sha])})
            self.uploads.pop(body["uploadId"], None)
            return httpx.Response(200, json={"ok": True})
        if path == "/admin/api/worker/jobs":
            jobs = [{"sha256": f["sha256"], "name": f["name"], "ext": f["ext"], "size": f["size"], "files": 1}
                    for f in self.files if f.get("origin") == "upload" and f["sha256"] not in self.results]
            return httpx.Response(200, json={"jobs": jobs})
        if path == "/admin/api/worker/result":
            self.results[body.pop("sha256")] = body
            return httpx.Response(200, json={"updated": 1})
        if path == "/admin/api/worker/members":
            self.members[body["sha256"]] = body["members"]
            return httpx.Response(200, json={"archives": 1})
        return httpx.Response(404, json={"error": path})


def test_push_uploads_what_the_site_wants_and_resumes(tmp_path, monkeypatch):
    import hashlib

    from ra import push as push_mod

    monkeypatch.setattr(push_mod, "PART_SIZE", 1000)  # makes the big file multipart
    small, big, gone, bad = b"small file", bytes(range(256)) * 10, b"not here", b"changed on disk"
    sha = lambda b: hashlib.sha256(b).hexdigest()  # noqa: E731
    disk = {sha(small): tmp_path / "a.txt", sha(big): tmp_path / "b.wav", sha(bad): tmp_path / "c.png"}
    disk[sha(small)].write_bytes(small)
    disk[sha(big)].write_bytes(big)
    disk[sha(bad)].write_bytes(b"something else")
    rows = [
        {"sha256": sha(small), "size": len(small), "name": "a.txt", "ext": "txt", "blob_key": None},
        {"sha256": sha(small), "size": len(small), "name": "copy.txt", "ext": "txt", "blob_key": None},
        {"sha256": sha(big), "size": len(big), "name": "b.wav", "ext": "wav", "blob_key": None},
        {"sha256": sha(gone), "size": len(gone), "name": "gone.flac", "ext": "flac", "blob_key": None},
        {"sha256": sha(bad), "size": len(bad), "name": "c.png", "ext": "png", "blob_key": None},
    ]
    site = FakeSite(rows)
    client = site.client()
    state = push_mod.PushState(tmp_path / "state.json")

    # An earlier run sent the first two parts of the big file, then stopped.
    upload_id = client.multipart_create(sha(big), "audio/wav")
    parts = [client.multipart_part(sha(big), upload_id, n, big[(n - 1) * 1000:n * 1000]) for n in (1, 2)]
    state.save(sha(big), upload_id, parts)
    site.fail_parts = 1  # and the connection drops once: retried

    progress = push_mod.push(client, disk.get, state, workers=2, log=lambda m: None)
    assert site.blobs[sha(small)] == small and site.blobs[sha(big)] == big
    assert sha(bad) not in site.blobs and progress.failed == [sha(bad)]
    assert [f["blob_key"] is not None for f in site.files] == [True, True, True, False, False]
    assert not (tmp_path / "state.json").exists() or json.loads((tmp_path / "state.json").read_text()) == {}

    # A second run finds nothing new to send; stored-but-unmarked content is only marked.
    site.files.append({"sha256": sha(small), "size": len(small), "name": "third.txt", "ext": "txt", "blob_key": None})
    progress = push_mod.push(client, disk.get, state, log=lambda m: None)
    assert progress.files == 1 and site.files[-1]["blob_key"]  # only the changed file is left to upload


def test_worker_unpacks_uploaded_archives(tmp_path):
    import hashlib
    import io
    import wave
    import zipfile

    from ra.worker import process

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(8000)
        w.writeframes(bytes(1600))
    inner = io.BytesIO()
    with zipfile.ZipFile(inner, "w") as z:
        z.writestr("deep/readme.txt", "inner")
    outer = io.BytesIO()
    with zipfile.ZipFile(outer, "w") as z:
        z.writestr("disc/01 track.wav", buf.getvalue())
        z.writestr("extras.zip", inner.getvalue())
        z.writestr("__MACOSX/._01 track.wav", b"junk")
    content = outer.getvalue()
    sha = hashlib.sha256(content).hexdigest()
    site = FakeSite([{"sha256": sha, "size": len(content), "name": "album.zip", "ext": "zip", "blob_key": "x",
                      "origin": "upload"}])
    site.blobs[sha] = content

    result = process(site.client(), {"sha256": sha, "name": "album.zip", "ext": "zip"}, None, tmp_path / "tmp",
                     log=lambda m: None)
    assert result["format"] == {"archive": "zip", "files": 3, "status": "ok"}
    members = {m["path"]: m for m in site.members[sha]}
    assert set(members) == {"disc/01 track.wav", "extras.zip", "extras.zip!/deep/readme.txt", "__MACOSX/._01 track.wav"}
    assert members["extras.zip!/deep/readme.txt"]["parent"] == "extras.zip"
    assert members["extras.zip"]["format"]["archive"] == "zip"
    wav = members["disc/01 track.wav"]
    assert wav["format"]["rate"] == 8000 and wav["pcm_md5"] == hashlib.md5(bytes(1600)).hexdigest()
    assert all(site.blobs[m["sha256"]] for m in members.values())  # every member's content was stored
    assert site.results[sha] == result
    assert not any((tmp_path / "tmp").iterdir())  # scratch space cleaned up


def test_probe_rejects_garbage_with_a_media_extension(tmp_path):
    import os

    from ra.probe import probe_one

    junk = tmp_path / "broken.flac"
    junk.write_bytes(os.urandom(4096))
    item = probe_one("a" * 64, junk)
    assert "error" in item and "format" not in item
