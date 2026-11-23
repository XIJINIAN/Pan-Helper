#!/usr/bin/env python3
"""Baidu Pan: download a >50MB file past the "请使用百度网盘客户端" wall.

The wall, measured (non-SVIP account, 2026-11)
---------------------------------------------
  * POST /api/sharedownload                  -> `list[0].dlink` is a base64 blob for
                                                any file >50MB; no crypto in the web JS.
  * GET  /api/download (signed)              -> for >50MB the server backdates
                                                `dstime` by 7200s and shrinks
                                                `expires` to 1h, i.e. the link is
                                                born dead. `type=` does not matter.
  * GET  /rest/2.0/xpan/file?method=filemetas-> `FDtAER-` preview link, 31362 sign error.
  * GET  pcs.baidu.com/rest/2.0/pcs/file
         ?method=download&app_id=250528
         &path=<urlencoded drive path>          -> 302 to a real FDTAXUb CDN link.
                                                  THIS is the official client channel.

The catch on the CDN side is per request, not per file:

    Range: bytes=0-0          -> 206  (Content-Range: bytes 0-0/12345678)
    Range: bytes=0-4194303    -> 206  4 MiB in one go, fine
    Range: bytes=0-8388607    -> 403  {"error_code":31326,"hitcode:104}
    Range: bytes=0-           -> 403  {"error_code":31326,"hitcode:104}
    no Range (plain GET)      -> 403  {"error_code":31326,"hitcode:104}

So a full download is just the same file fetched as N <=4MiB ranges and stitched
together. Sign and cookies stay valid for the whole run; nothing is re-signed.

Usage
-----
    ./baidu_epub_dlink.py --path '/图书资源/foo.pdf'            # -> ~/Downloads/foo.pdf
    ./baidu_epub_dlink.py --path '/图书资源/foo.pdf' -o foo.pdf
    ./baidu_epub_dlink.py --fsid 1234567890                    # look the path up first
    ./baidu_epub_dlink.py --path '/图书资源/foo.pdf' --probe     # only print the gate table
    ./baidu_epub_dlink.py --path '/图书资源/foo.pdf' --workers 16

One of --path / --fsid is required; there is no built-in sample file any more.

Cookie
------
Needs the whole `Cookie:` header of a logged-in pan.baidu.com session, not just
BDUSS: `BDUSS`, `STOKEN`, `PANPSC` (pcs.baidu.com scoped, this one makes the CDN
accept the range), `PANWEB`, `BDCLND`, `BAIDUID`. Sources, in order:

    $BAIDU_PAN_COOKIE            one-line "k=v; k=v; ..."
    ~/.baidu_pan_cookie          same (chmod 600), written by chrome_baidu_cookie.py
    ./.baidu_cookie              same, project-local (gitignored)
    $BDUSS / ~/.baidu_bduss      BDUSS only; enough for /api/*, not for the CDN
    Chrome's cookie DB           decrypted in place if it is readable

macOS: Chrome's DB lives under ~/Library/Application Support/Google/Chrome/Default
and TCC blocks neither-Chtome processes from reading it. `chrome_baidu_cookie.py`
explains the way around that (the browser hands the file over itself).
"""
import argparse
import hashlib
import http.client
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))

CDN_UA = "netdisk;P2SP;3.0.20.128;Windows10;AMD64;Resolution:1920x1080"
API_UA = "netdisk;P2SP;3.0.20.128;Windows10;AMD64;Resolution:1920x1080"
CHROME_DIR = os.path.expanduser("~/Library/Application Support/Google/Chrome/Default")

MIB = 1 << 20
CHUNK_CANDIDATES = [4 * MIB, 8 * MIB, 2 * MIB, 1 * MIB, 512 << 10]   # first one the CDN accepts wins


# --------------------------------------------------------------- cookie
def _decrypt_chrome_db(db):
    """Decrypt baidu cookies out of a Chrome Cookies sqlite file.

    The AES/keychain dance lives in chrome_baidu_cookie.py — one copy of it only.
    """
    if HERE not in sys.path:
        sys.path.insert(0, HERE)
    try:
        import chrome_baidu_cookie as cbc
    except ImportError:
        raise RuntimeError("chrome_baidu_cookie.py not next to this file - "
                           "set BAIDU_PAN_COOKIE instead")
    return cbc.read_cookies(db)


WANT = ("BDUSS", "STOKEN", "PANPSC", "PANWEB", "BDCLND", "BAIDUID")


def cookie_header():
    raw = os.environ.get("BAIDU_PAN_COOKIE", "").strip()
    for p in (os.path.expanduser("~/.baidu_pan_cookie"), os.path.join(HERE, ".baidu_cookie")):
        if not raw and os.path.exists(p):
            raw = open(p).read().strip()
            if raw:
                print("(cookie from %s)" % p, file=sys.stderr)
    bduss = os.environ.get("BDUSS") or os.environ.get("BAIDU_BDUSS")
    if not bduss:
        for p in (os.path.join(HERE, ".bduss"), os.path.expanduser("~/.baidu_bduss")):
            if os.path.exists(p) and open(p).read().strip():
                bduss = open(p).read().strip()
                print("(BDUSS from %s - API only, the CDN will say 31326)" % p, file=sys.stderr)
                break
    if raw:
        return raw
    if bduss:
        return "BDUSS=" + bduss
    db = os.path.join(CHROME_DIR, "Cookies")
    if os.path.exists(db):
        try:
            jar = _decrypt_chrome_db(db)
        except Exception as e:                       # noqa: BLE001
            # 读不到 keychain / 没装同级脚本 / TCC 拦了，都不是致命错：
            # 后面还有环境变量和 ~/.baidu_pan_cookie
            jar = {}
            print("(can't read Chrome's cookies: %s)" % e, file=sys.stderr)
        if "BDUSS" in jar:
            print("(cookie from Chrome's own DB)", file=sys.stderr)
            return "; ".join("%s=%s" % (k, jar[k]) for k in WANT if k in jar)
    sys.exit("no cookie. Put the pan.baidu.com Cookie header in ~/.baidu_pan_cookie\n"
             "(see chrome_baidu_cookie.py), or set BAIDU_PAN_COOKIE / BDUSS.")


# --------------------------------------------------------------- api
def filemetas(cookie, fsid):
    q = urllib.parse.urlencode({"dlink": 0, "fsids": "[%d]" % fsid, "thumb": 0,
                                "channel": "chunlei", "web": 1, "app_id": 250528})
    req = urllib.request.Request("https://pan.baidu.com/api/filemetas?" + q, headers={
        "User-Agent": API_UA, "Cookie": cookie, "Accept": "application/json",
        "Referer": "https://pan.baidu.com/disk/main"})
    try:
        j = json.load(urllib.request.urlopen(req, timeout=30))
    except Exception as e:                           # noqa: BLE001
        print("(filemetas unreachable: %s)" % e, file=sys.stderr)
        return {}
    if j.get("errno"):
        # -6 = "not logged in" for this endpoint; it comes and goes, and the pcs
        # channel does not need it at all, so prefer --path when this trips.
        print("(filemetas errno=%s - this endpoint wants a fresh web session; "
              "prefer --path)" % j["errno"], file=sys.stderr)
        return {}
    if not j.get("info"):
        return {}
    it = j["info"][0]
    return {"name": it.get("server_filename") or os.path.basename(it.get("path", "")),
            "path": it.get("path"), "size": int(it.get("size", 0)), "md5": it.get("md5") or ""}


def pcs_url(path):
    return ("https://pcs.baidu.com/rest/2.0/pcs/file?method=download&app_id=250528&path="
            + urllib.parse.quote(path))


def _get(url, cookie, ua, byte_range, timeout=180):
    """One range request. Returns (status, final_url, total_or_None, body)."""
    h = {"User-Agent": ua, "Cookie": cookie, "Referer": "https://pan.baidu.com/disk/main"}
    if byte_range:
        h["Range"] = "bytes=%d-%d" % byte_range
    req = urllib.request.Request(url, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            total = None
            mm = re.search(r"/(\d+)$", r.headers.get("Content-Range") or "")
            if mm:
                total = int(mm.group(1))
            elif r.headers.get("x-bs-file-size"):
                total = int(r.headers["x-bs-file-size"])
            try:
                body = r.read()
            except http.client.IncompleteRead as e:
                # CDN likes to hang up mid-body under load; keep what arrived
                body = e.partial or b""
                if not body:
                    return 599, r.geturl(), total, b"incomplete read"
            return r.status, r.geturl(), total, body
    except urllib.error.HTTPError as e:
        return e.code, url, None, e.read(400)
    except (urllib.error.URLError, http.client.HTTPException, OSError) as e:
        return 599, url, None, str(e).encode()[:200]


def gate_table(path, cookie, ua):
    """Show what the CDN allows per request; returns (dlink, size, chunk)."""
    url = pcs_url(path)
    st, dlink, total, body = _get(url, cookie, ua, (0, 0))
    print("  pcs  -> HTTP %s  %s" % (st, dlink[:110]))
    if st not in (200, 206):
        sys.exit("PCS refused (%s): %s" % (st, body[:200].decode("utf-8", "replace")))
    chunk = None
    for c in CHUNK_CANDIDATES:
        st2, _, tot2, b2 = _get(dlink, cookie, ua, (0, c - 1))
        total = total or tot2
        ok = st2 in (200, 206) and len(b2) >= min(c, total or c)
        print("  Range 0-%-9d -> HTTP %s%s" % (c - 1, st2, "" if ok else "  " + b2[:90].decode("utf-8", "replace")))
        if ok:
            chunk = c
            break
    if not chunk:
        sys.exit("every range size was refused - nothing to download with")
    print("  per-request cap that works: %d bytes (%.2f MiB)" % (chunk, chunk / MIB))
    return dlink, total, chunk


# --------------------------------------------------------------- download
class Job:
    def __init__(self, dlink, cookie, ua, total, chunk, out):
        self.dlink, self.cookie, self.ua = dlink, cookie, ua
        self.total, self.chunk, self.out = total, chunk, out
        self.n = (total + chunk - 1) // chunk
        self.lock = threading.Lock()
        self.next = 0
        self.done = set()
        self.got = 0
        self.fail = []
        self.retry = []
        self.tries = {}
        self.journal = out + ".chunks"
        self.t0 = time.time()

    def load(self):
        if os.path.exists(self.journal):
            for line in open(self.journal):
                line = line.strip()
                if line.isdigit() and int(line) < self.n:
                    self.done.add(int(line))
            self.got = sum(self.span(i)[1] - self.span(i)[0] + 1 for i in self.done)
            self.next = 0
        fd = os.open(self.out, os.O_RDWR | os.O_CREAT, 0o644)
        os.ftruncate(fd, self.total)
        return fd

    def span(self, i):
        s = i * self.chunk
        return s, min(s + self.chunk, self.total) - 1

    def take(self):
        with self.lock:
            while self.next in self.done and self.next < self.n:
                self.next += 1
            if self.next < self.n:
                i = self.next
                self.next += 1
                return i
            if self.retry:
                return self.retry.pop(0)
            return None

    def worker(self, fd):
        while True:
            i = self.take()
            if i is None:
                return
            s, e = self.span(i)
            want = e - s + 1
            body = b""
            for attempt in range(8):
                try:
                    st, _, _, body = _get(self.dlink, self.cookie, self.ua, (s, e))
                except Exception as ex:              # noqa: BLE001 - network noise
                    st, body = 0, str(ex).encode()
                if st in (200, 206) and len(body) == want:
                    break
                time.sleep(1.5 * (attempt + 1))
            if len(body) != want:
                with self.lock:
                    self.tries[i] = self.tries.get(i, 0) + 1
                    if self.tries[i] < 4:
                        self.retry.append(i)
                        sys.stderr.write("\n  chunk %d short (%d/%d bytes, HTTP %s) - requeued\n"
                                         % (i, len(body), want, st))
                    else:
                        self.fail.append((i, st, len(body)))
                continue
            os.pwrite(fd, body, s)
            with self.lock:
                self.done.add(i)
                self.got += want
                with open(self.journal, "a") as f:
                    f.write("%d\n" % i)
                rate = self.got / 1e6 / max(time.time() - self.t0, 0.01)
                sys.stderr.write("\r  %5.1f%%  %6.1f / %6.1f MiB  %5.2f MiB/s  " % (
                    100.0 * self.got / self.total, self.got / 1e6, self.total / 1e6, rate))
                sys.stderr.flush()

    def run(self, workers):
        fd = self.load()
        if self.done:
            sys.stderr.write("resume: %d/%d chunks already here\n" % (len(self.done), self.n))
        ths = [threading.Thread(target=self.worker, args=(fd,), daemon=True) for _ in range(workers)]
        for t in ths:
            t.start()
        for t in ths:
            t.join()
        os.fsync(fd)
        os.close(fd)
        sys.stderr.write("\n")
        if self.fail:
            sys.exit("%d chunk(s) failed, e.g. #%d HTTP %s len %s - re-run to resume"
                     % (len(self.fail), self.fail[0][0], self.fail[0][1], self.fail[0][2]))


def verify(path, size, md5_want):
    got = os.path.getsize(path)
    h = hashlib.md5()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(8 * MIB), b""):
            h.update(b)
    mine = h.hexdigest()
    print("size %d / %d  %s" % (got, size, "OK" if got == size else "MISMATCH"))
    if md5_want:
        if len(md5_want) == 32 and mine == md5_want:
            print("md5  %s  OK" % mine)
        # baidu replaces index 9 with a marker letter once a file gets slice-md5'd
        elif len(md5_want) == 32 and mine[:9] == md5_want[:9] and mine[10:] == md5_want[10:]:
            print("md5  %s  OK (baidu's %s masks index 9)" % (mine, md5_want))
        else:
            print("md5  %s  != baidu %s  MISMATCH" % (mine, md5_want))
            return False
    return got == size


def main():
    ap = argparse.ArgumentParser(
        description="Download one Baidu Pan file as <=4MiB ranges (needs a logged-in cookie).")
    ap.add_argument("--path", default=None, help="drive path, e.g. /图书资源/foo.pdf (wins over --fsid)")
    ap.add_argument("--fsid", type=int, default=None, help="file id; look the path up first")
    ap.add_argument("-o", "--output", default=None, help="default ~/Downloads/<name>")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--ua", default=CDN_UA)
    ap.add_argument("--probe", action="store_true", help="print the gate table, do not download")
    a = ap.parse_args()
    if not a.path and not a.fsid:
        ap.error("给一个 --path 或 --fsid（没有内置的示例文件）")

    cookie = cookie_header()
    api = filemetas(cookie, a.fsid) if a.fsid else None
    if a.path:
        same = bool(api) and api.get("path") == a.path
        meta = {
            "path": a.path,
            "name": os.path.basename(a.path.rstrip("/")) or "download.bin",
            "size": api.get("size", 0) if same else 0,
            "md5": api.get("md5", "") if same else "",
        }
    elif api and api.get("path"):
        meta = {"path": api["path"], "size": api.get("size") or 0, "md5": api.get("md5") or "",
                "name": os.path.basename(api["path"].rstrip("/")) or "download.bin"}
    else:
        sys.exit("fsid %s 查不到元信息：cookie 过期，或者文件已删除" % a.fsid)
    print("%s  %s  (%s bytes)" % (meta["name"], meta["path"], meta.get("size") or "?"))

    dlink, total, chunk = gate_table(meta["path"], cookie, a.ua)
    total = total or meta.get("size") or 0
    if not total:
        sys.exit("拿不到文件大小，链接多半没签对（检查 cookie / 权限）")
    if a.probe:
        print("dlink:", dlink)
        return

    out = a.output or os.path.join(os.path.expanduser("~/Downloads"), meta["name"])
    job = Job(dlink, cookie, a.ua, total, chunk, out)
    print("→ %s  %d chunks of %.2f MiB, %d workers" % (out, job.n, chunk / MIB, a.workers))
    job.run(a.workers)
    if verify(out, total, meta.get("md5") or ""):
        try:
            os.remove(job.journal)
        except OSError:
            pass
        print("saved %s" % out)


if __name__ == "__main__":
    main()
