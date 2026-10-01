"""HTTP client for the site's machine API (/admin/api/worker/*), used by `ra push`, `ra worker` and
the processing container.

Every call carries WORKER_TOKEN. The deployed site also sits behind Cloudflare Access, which lets the
calls through with a service token (CF-Access-Client-Id / CF-Access-Client-Secret). Inside the
processing container the site is http://site.internal: the Worker answers those requests itself and
adds the token, so the container holds neither secret.

Settings come from environment variables or from tools/ra/cloud.env (KEY=value lines):

  RA_SITE                   https://… of the deployed site (default: the local dev site)
  RA_WORKER_TOKEN           the site's WORKER_TOKEN secret
  CF_ACCESS_CLIENT_ID       Access service token, for the deployed site
  CF_ACCESS_CLIENT_SECRET
"""

import hashlib
import os
import re
import time
from pathlib import Path

import httpx

DEV_SITE = "http://localhost:4321"
INTERNAL_SITE = "http://site.internal"  # the site as the processing container reaches it
RETRY_STATUS = {429, 500, 502, 503, 504}


class SiteError(Exception):
    def __init__(self, message: str, status: int | None = None, access: bool = False):
        super().__init__(message)
        self.status = status
        self.access = access  # stopped by Cloudflare Access, not by the site


class SiteClient:
    def __init__(self, base: str, token: str, access_id: str | None = None, access_secret: str | None = None,
                 timeout: float = 300, transport: httpx.BaseTransport | None = None, retries: int = 4):
        # Origin: Astro refuses PUT/POST bodies that look like form posts (text/plain, no type) from other sites.
        headers = {"User-Agent": "ra", "Origin": base.rstrip("/")}
        if token:  # none inside the container: the Worker adds it to calls to site.internal
            headers["Authorization"] = f"Bearer {token}"
        if access_id and access_secret:
            headers |= {"CF-Access-Client-Id": access_id, "CF-Access-Client-Secret": access_secret}
        self.base = base.rstrip("/")
        self.retries = retries
        self.access_wait = 15 * 60  # seconds to wait out an Access change once calls have worked
        self._worked = False
        self.http = httpx.Client(
            base_url=self.base, headers=headers, transport=transport, follow_redirects=False,
            timeout=httpx.Timeout(timeout, connect=30),
            limits=httpx.Limits(max_connections=32, max_keepalive_connections=32),
        )

    def close(self) -> None:
        self.http.close()

    # -------------------------------------------------------------- plumbing

    def _check(self, response: httpx.Response) -> httpx.Response:
        location = response.headers.get("location", "")
        if response.is_redirect or "cloudflareaccess.com" in location:
            raise SiteError("被 Cloudflare Access 拦下：检查 cloud.env 里的服务令牌，以及 Access 应用里是否有 Service Auth 策略",
                            response.status_code, access=True)
        if response.status_code == 403 and "text/html" in response.headers.get("content-type", ""):
            raise SiteError("被 Cloudflare Access 拒绝：服务令牌无效或未加入策略", 403, access=True)
        if response.status_code >= 400:
            try:
                message = response.json().get("error") or response.text
            except ValueError:
                message = response.text
            raise SiteError(f"{response.status_code}: {message[:300]}", response.status_code)
        return response

    def request(self, method: str, path: str, **kwargs) -> httpx.Response:
        """One call, retried on network errors and 429/5xx (every call is safe to repeat).

        Once calls have gone through, a sudden Access refusal (someone editing the Access app while a
        long upload runs) is waited out for a while instead of failing every file.
        """
        waited = 0.0
        while True:
            try:
                response = self._request(method, path, **kwargs)
            except SiteError as exc:
                if not (exc.access and self._worked and waited < self.access_wait):
                    raise
                time.sleep(30)
                waited += 30
                continue
            self._worked = True
            return response

    def _request(self, method: str, path: str, **kwargs) -> httpx.Response:
        for attempt in range(self.retries + 1):
            try:
                response = self.http.request(method, path, **kwargs)
            except httpx.TransportError as exc:
                if attempt == self.retries:
                    raise SiteError(f"网络错误：{exc}") from exc
            else:
                if response.status_code not in RETRY_STATUS or attempt == self.retries:
                    return self._check(response)
            time.sleep(min(60, 2 ** attempt))
        raise AssertionError("unreachable")

    # -------------------------------------------------------------- uploads to process (ra worker)

    def jobs(self, limit: int = 20) -> list[dict]:
        return self.request("GET", "/admin/api/worker/jobs", params={"limit": limit}).json()["jobs"]

    def download(self, sha256: str, dest: Path) -> str:
        """Stream the stored content to dest; returns the SHA-256 of what arrived."""
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(dest.name + ".part")
        digest = hashlib.sha256()
        for attempt in range(self.retries + 1):
            try:
                with self.http.stream("GET", f"/admin/api/worker/blob/{sha256}") as response, tmp.open("wb") as out:
                    self._check(response)
                    for chunk in response.iter_bytes(4 * 1024 * 1024):
                        digest.update(chunk)
                        out.write(chunk)
                break
            except httpx.TransportError as exc:
                digest = hashlib.sha256()
                if attempt == self.retries:
                    raise SiteError(f"网络错误：{exc}") from exc
                time.sleep(min(60, 2 ** attempt))
        tmp.replace(dest)
        return digest.hexdigest()

    def report(self, sha256: str, **result) -> int:
        return self.request("POST", "/admin/api/worker/result", json={"sha256": sha256, **result}).json()["updated"]

    def register_members(self, sha256: str, members: list[dict]) -> int:
        return self.request("POST", "/admin/api/worker/members", json={"sha256": sha256, "members": members}).json()["archives"]

    # -------------------------------------------------------------- storage (ra push)

    def wanted(self, after: str = "", limit: int = 500) -> tuple[list[dict], str | None]:
        data = self.request("GET", "/admin/api/worker/wanted", params={"after": after, "limit": limit}).json()
        return data["items"], data["next"]

    def have(self, shas: list[str]) -> dict[str, int]:
        return self.request("POST", "/admin/api/worker/have", json={"shas": shas}).json()["have"]

    def stored(self, shas: list[str]) -> int:
        return self.request("POST", "/admin/api/worker/stored", json={"shas": shas}).json()["updated"]

    def put_blob(self, sha256: str, data: bytes, content_type: str) -> None:
        self.request("PUT", f"/admin/api/worker/blob/{sha256}", content=data, headers={"Content-Type": content_type})

    def put_object(self, key: str, data: bytes, content_type: str, sha256: str | None = None) -> None:
        """Store a derived file (key under derived/); with sha256, storage checks the bytes."""
        headers = {"Content-Type": content_type or "application/octet-stream"}
        if sha256:
            headers["X-Content-Sha256"] = sha256
        self.request("PUT", f"/admin/api/worker/object/{key}", content=data, headers=headers)

    def object_multipart(self, key: str, body: dict) -> dict:
        return self.request("POST", f"/admin/api/worker/object-multipart/{key}", json=body).json()

    def object_part(self, key: str, upload_id: str, number: int, data: bytes) -> dict:
        response = self.request("PUT", f"/admin/api/worker/object-multipart/{key}", params={"uploadId": upload_id, "part": number},
                                content=data, headers={"Content-Type": "application/octet-stream"})
        part = response.json()
        return {"partNumber": part["partNumber"], "etag": part["etag"]}

    # -------------------------------------------------------------- processing (derive, fingerprint)

    def tasks(self, task: str, limit: int = 20, kind: str | None = None) -> dict:
        """Contents waiting for a task: {"version": …, "items": [...]}; kind "video" or "other" lists only
        videos or only the rest."""
        params = {"task": task, "limit": limit} | ({"kind": kind} if kind else {})
        return self.request("GET", "/admin/api/worker/tasks", params=params).json()

    def claim(self, task: str, sha256: str, version: int, spec: str | None = None) -> bool:
        """Take a content for a task; False when someone else is on it or it is done already. ``spec`` names
        what is asked for (the parts of preview clips): other parts than last time make it a new task."""
        body = {"task": task, "sha256": sha256, "version": version} | ({"spec": spec} if spec else {})
        return bool(self.request("POST", "/admin/api/worker/claim", json=body).json()["claimed"])

    def touch(self, task: str, sha256: str) -> bool:
        """Renew a claim while still working on it."""
        body = {"task": task, "sha256": sha256, "version": 0, "touch": True}
        return bool(self.request("POST", "/admin/api/worker/claim", json=body).json()["claimed"])

    def task_result(self, task: str, sha256: str, version: int, **result) -> dict:
        body = {"task": task, "sha256": sha256, "version": version, **result}
        return self.request("POST", "/admin/api/worker/task-result", json=body).json()

    def fingerprints(self, after: str = "", limit: int = 200) -> tuple[list[dict], str | None]:
        data = self.request("GET", "/admin/api/worker/fingerprints", params={"after": after, "limit": limit}).json()
        return data["items"], data["next"]

    def matches(self, shas: list[str] | None, pairs: list[dict]) -> int:
        """Replace the matches of these contents (None: of every content) with pairs."""
        body = {"all": True, "pairs": pairs} if shas is None else {"shas": shas, "pairs": pairs}
        return self.request("POST", "/admin/api/worker/matches", json=body).json()["saved"]

    def processor(self, action: str | None = None) -> dict:
        """The processing container's status, or wake / restart / backup it."""
        if action is None:
            return self.request("GET", "/admin/api/worker/processor").json()
        return self.request("POST", "/admin/api/worker/processor", json={"action": action}).json()

    # -------------------------------------------------------------- backup

    def objects(self, prefix: str, cursor: str | None = None) -> tuple[list[dict], str | None]:
        params = {"prefix": prefix, **({"cursor": cursor} if cursor else {})}
        data = self.request("GET", "/admin/api/worker/objects", params=params).json()
        return data["objects"], data["cursor"]

    def stream_blob(self, sha256: str):
        """A streaming response with the stored content (use as a context manager)."""
        return self.http.stream("GET", f"/admin/api/worker/blob/{sha256}")

    def dump_schema(self) -> dict:
        return self.request("GET", "/admin/api/worker/dump").json()

    def dump_rows(self, table: str, after: int, limit: int = 500) -> dict:
        return self.request("GET", "/admin/api/worker/dump", params={"table": table, "after": after, "limit": limit}).json()

    def backup_run(self, **body) -> dict:
        return self.request("POST", "/admin/api/worker/backup", json=body).json()

    def multipart_create(self, sha256: str, content_type: str) -> str:
        body = {"action": "create", "contentType": content_type}
        return self.request("POST", f"/admin/api/worker/multipart/{sha256}", json=body).json()["uploadId"]

    def multipart_part(self, sha256: str, upload_id: str, number: int, data: bytes) -> dict:
        response = self.request("PUT", f"/admin/api/worker/multipart/{sha256}", params={"uploadId": upload_id, "part": number},
                                content=data, headers={"Content-Type": "application/octet-stream"})
        part = response.json()
        return {"partNumber": part["partNumber"], "etag": part["etag"]}

    def multipart_complete(self, sha256: str, upload_id: str, parts: list[dict]) -> int:
        body = {"action": "complete", "uploadId": upload_id, "parts": parts}
        return self.request("POST", f"/admin/api/worker/multipart/{sha256}", json=body).json()["size"]

    def multipart_abort(self, sha256: str, upload_id: str) -> None:
        self.request("POST", f"/admin/api/worker/multipart/{sha256}", json={"action": "abort", "uploadId": upload_id})


# ------------------------------------------------------------------ settings


def read_env_file(path: Path) -> dict[str, str]:
    """KEY=value lines; # comments, blank lines, quotes and Windows line endings are tolerated."""
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, sep, value = line.partition("=")
        if sep:
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def is_local(site: str) -> bool:
    host = httpx.URL(site).host
    return host in ("localhost", "127.0.0.1", "::1")


def client_from_env(site: str | None, dev_vars: Path, cloud_env: Path) -> SiteClient:
    """Deployed site: settings from the environment or cloud.env. Local dev site: token from .dev.vars.
    Inside the processing container (RA_SITE=http://site.internal) no secrets are needed."""
    cloud = read_env_file(cloud_env)
    setting = lambda key: os.environ.get(key) or cloud.get(key) or None  # noqa: E731
    site = site or setting("RA_SITE") or DEV_SITE
    if site.rstrip("/") == INTERNAL_SITE:
        return SiteClient(site, "")
    if is_local(site):
        token = os.environ.get("RA_WORKER_TOKEN") or read_env_file(dev_vars).get("WORKER_TOKEN")
        if not token:
            raise ValueError(f"no worker token: WORKER_TOKEN is missing from {dev_vars}")
        return SiteClient(site, token)
    token = setting("RA_WORKER_TOKEN")
    # The dashboard shows the token as request headers; accept a pasted "CF-Access-Client-Id: …" line too.
    unheader = lambda v: re.sub(r"^\s*CF-Access-Client-(?:Id|Secret)\s*:\s*", "", v, flags=re.I) if v else v  # noqa: E731
    access_id, access_secret = unheader(setting("CF_ACCESS_CLIENT_ID")), unheader(setting("CF_ACCESS_CLIENT_SECRET"))
    missing = [k for k, v in (("RA_WORKER_TOKEN", token), ("CF_ACCESS_CLIENT_ID", access_id),
                              ("CF_ACCESS_CLIENT_SECRET", access_secret)) if not v]
    if missing:
        raise ValueError(f"{cloud_env} is missing {', '.join(missing)}")
    return SiteClient(site, token, access_id, access_secret)
