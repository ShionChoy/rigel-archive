"""Enumerations shared with the site schema (site/migrations/0001_init.sql)."""

SLOTS = ("cd", "cd_rip", "digital", "streaming", "bonus", "scans", "pv")

SLOT_STATUSES = (
    "collected",       # 已收录
    "partial",         # 部分缺档
    "missing",         # 缺档
    "unreleased",      # 未发行
    "planned",         # 预定
    "not_applicable",  # 不适用
    "unknown",         # 待确认
)

RELEASE_KINDS = ("album", "single", "dl_card", "web", "game_bgm", "other")
ERAS = ("rigel-theatre", "grand-thaw", "delta-records", "dezaemon")
RIGHTS = ("own", "third_party", "licensed", "unknown")
FILE_STATES = ("inbox", "classified", "published", "ignored")

_EXT_KINDS = {
    "audio": "flac wav mp3 m4a ogg opus aac wma vqf aif aiff",
    "image": "jpg jpeg png gif bmp webp ico tif tiff",
    "video": "mkv mp4 webm wmv avi mov flv",
    "archive": "zip rar 7z lzh lha gz tar",
    "disc_image": "iso bin img mdf",
    "text": "txt md log cue nfo ini",
    "playlist": "m3u m3u8",
    "web": "html htm css js jsp php xml json",
    "score": "pdf mscz musicxml ove",
    "midi": "mid midi",
    "chart": "bms bme bml pms vos vow ojn ojm",
    "program": "exe dll",
    "save": "psv vmp mcr",
    "fragment": "download",
}
EXT_KIND = {ext: kind for kind, exts in _EXT_KINDS.items() for ext in exts.split()}


def kind_for(ext: str) -> str:
    return EXT_KIND.get(ext.lower(), "other")
