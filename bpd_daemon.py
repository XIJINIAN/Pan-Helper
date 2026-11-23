#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""bpd_daemon.py —— 百度网盘直链用户脚本的本机小后端。

页面是 https，直接打 127.0.0.1 会被 Chrome 的私有网络预检（Private Network
Access）拦掉：aria2 的 RPC 不会回 `Access-Control-Allow-Private-Network`，
所以浏览器里点「推送」一定失败。这个守护进程干两件事：

  1. 当跳板：把任务转给 aria2 JSON-RPC（Motrix / Aria2GUI / aria2c --enable-rpc），
     顺手把百度必须的 Cookie 与 netdisk UA 塞进 header —— 浏览器里做不到这两件事。
  2. 备胎：直接拉起多线程 python worker 把文件拉下来（旧的「送到终端」路径）。

用法：
    python3 bpd_daemon.py
    nohup python3 bpd_daemon.py >/tmp/bpd_daemon.out 2>&1 &

环境变量：
    BPD_PORT        默认 8765
    BPD_ARIA        默认 http://127.0.0.1:16800/jsonrpc   （Motrix 默认端口）
    BPD_ARIA_SECRET aria2 --rpc-secret，没设就别填
    BPD_OUTDIR      默认 ~/Downloads
    BPD_WORKER      默认同目录 baidu_epub_dlink.py
    BPD_TOKEN       固定鉴权 token（默认每次启动随机，/ping 会告诉你）
    BPD_PROXY_HOSTS /proxy 允许的域名后缀，逗号分隔

接口：
    GET  /ping                       -> 自己活着没、cookie 在不在、aria2 连得上不、token
    GET  /aria                       -> aria2 getVersion + getGlobalStat + 正在下的任务
    GET  /proxy?u=<urlencode(直链)>   -> 4MiB 分块中转（aria2 用；浏览器也可直接开）
    POST /push   {"items":[{url,name,size,ua}]}  -> 逐个 aria2.addUri
    POST /start  {"path":"/a.epub"}  -> 用 python worker 直接下（备胎）
    GET  /jobs                       -> worker 任务
    GET  /log?file=<日志绝对路径>      -> worker 日志尾部（只认 LOGDIR 里的文件）

安全模型（本机 127.0.0.1，仍按「网页能打字进来」的前提设防）：
    * Host 必须是 127.0.0.1 / localhost —— 挡 DNS rebinding；
    * Origin 只认 https://pan.baidu.com / https://yun.baidu.com，其余一律 403，
      所以别的网站连 /ping 都读不到，更别说 POST；
    * 改动状态的接口（/push、/start）另要求 X-BPD-Token，token 只在 /ping 里给；
    * /proxy 只代取百度 CDN 域名，不是开放中转；rpc 参数只认回环地址。
"""

import json
import os
import re
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))
WORKER = os.environ.get("BPD_WORKER", os.path.join(HERE, "baidu_epub_dlink.py"))
OUTDIR = os.path.expanduser(os.environ.get("BPD_OUTDIR", "~/Downloads"))
LOGDIR = os.path.expanduser(os.environ.get("BPD_LOGDIR", "/tmp/bpd_daemon"))
COOKIE_FILE = os.path.expanduser("~/.baidu_pan_cookie")
PORT = int(os.environ.get("BPD_PORT", "8765"))
ARIA_RPC = os.environ.get("BPD_ARIA", "http://127.0.0.1:16800/jsonrpc")
ARIA_SECRET = os.environ.get("BPD_ARIA_SECRET", "")
VERSION = "1.6.0"

# ---------------------------------------------------------------- 安全模型
# 只监听 127.0.0.1 不等于安全：浏览器里任何一个网站都能给 localhost 发请求，
# 而 /push 能让 aria2 往任意目录写文件、/log 能读文件、/proxy 能代取 URL。
# 所以三层：Host 校验（挡 DNS rebinding）→ Origin 白名单 → 改状态接口要 token。
ALLOWED_ORIGINS = {"https://pan.baidu.com", "https://yun.baidu.com"}
LOOPBACK = {"127.0.0.1", "localhost", "::1"}
TOKEN = os.environ.get("BPD_TOKEN") or secrets.token_urlsafe(18)
AUTH = os.environ.get("BPD_AUTH", "1").lower() not in ("0", "false", "off", "no")
PROXY_HOSTS = tuple(
    h.strip().lower() for h in os.environ.get(
        "BPD_PROXY_HOSTS",
        ".baidupcs.com,.baidu.com,.bcebos.com,.baidubce.com").split(",") if h.strip())

# 百度 CDN 只认客户端 UA：Chrome UA 直接 403 31326
DEFAULT_UA = "netdisk;P2SP;3.0.20.128;Windows10;AMD64;Resolution:1920x1080"
REFERER = "https://pan.baidu.com/disk/main"

JOBS = []          # [{pid, path, log, started}]
MAX_JOBS = 4


# ---------------------------------------------------------------- aria2 JSON-RPC
def aria_call(method, params, rpc=None, secret=None, timeout=8):
    """发一条 aria2 JSON-RPC。返回 result；出错抛 RuntimeError（消息是给人看的）。"""
    rpc = rpc or ARIA_RPC
    secret = ARIA_SECRET if secret is None else secret
    p = list(params)
    if secret:
        p = ["token:" + secret] + p
    body = json.dumps({"jsonrpc": "2.0", "id": "bpd", "method": method, "params": p}).encode()
    req = urllib.request.Request(rpc, data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            j = json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        raise RuntimeError("aria2 RPC HTTP %s：%s" % (e.code, e.read()[:200].decode("utf-8", "replace")))
    except Exception as e:
        raise RuntimeError("连不上 aria2 RPC（%s）：%s　—— Motrix 起了吗？RPC 开了吗？" % (rpc, e))
    if "error" in j:
        err = j["error"] or {}
        raise RuntimeError("aria2 报错 %s：%s" % (err.get("code"), err.get("message")))
    return j.get("result")


def cookie_header():
    if not os.path.exists(COOKIE_FILE):
        return ""
    txt = open(COOKIE_FILE, "r", errors="replace").read().strip()
    txt = txt.replace("\n", "").replace("\r", "")
    return txt


def proxy_url(url, name=""):
    """把 CDN 直链包成走本机 /proxy 的链接。"""
    q = "u=" + urllib.parse.quote(url, safe="")
    if name:
        q += "&fn=" + urllib.parse.quote(name, safe="")
    return "http://127.0.0.1:%d/proxy?%s" % (PORT, q)


def _free_name(outdir, name):
    """给 aria2 一个不撞车的目标名。
    为什么必须自己做：aria2 在 `continue=true` + 同名文件已存在时，会按"续传"处理这个文件——
       实测它把一份已下完的 92.6MB epub 直接截断重下（本地文件当场报废）。
       `allow-overwrite=false` / `auto-file-renaming=true` 都拦不住，因为那不是"覆盖"，是"续传"。
       所以名字先在这里定死，撞了就叫 `名字 (1).ext`，aria2 那边就不会触发续传语义。"""
    base, ext = os.path.splitext(name)
    cand, i = name, 1
    while os.path.exists(os.path.join(outdir, cand)):
        cand = "%s (%d)%s" % (base, i, ext)
        i += 1
    return cand


def push_one(item, rpc, secret, mode="proxy", opts=None):
    """opts（都来自页面设置，可缺省）：dir / split / conn / minSplit / cookie"""
    opts = opts or {}
    url = (item.get("url") or "").strip()
    if not url.startswith("http"):
        raise RuntimeError("直链无效")
    name = item.get("name") or ""
    name = re.sub(r"[/\\\x00]", "_", name) or "download.bin"
    ua = item.get("ua") or DEFAULT_UA
    # cookie 只对 python 备胎 worker 有意义；CDN 直链只要签名 + UA，没有这个文件也照下
    ck = (opts.get("cookie") or "").strip() or cookie_header()
    outdir = os.path.expanduser(opts.get("dir") or OUTDIR)
    if not os.path.isabs(outdir):
        outdir = OUTDIR
    split = str(int(opts.get("split") or 4))
    conn = str(int(opts.get("conn") or split))
    mss = str(opts.get("minSplit") or "1M")
    outname = _free_name(outdir, name)
    aopts = {
        "out": outname,
        "dir": outdir,
        "user-agent": ua,
        "header": ["Referer: " + REFERER] + (["Cookie: " + ck] if ck else []),
        # 百度 CDN 按单请求限速，多连接不会更快，但断了能续
        "split": split,
        "max-connection-per-server": conn,
        "min-split-size": mss,
        "file-allocation": "none",
        "continue": "true",
        "auto-file-renaming": "true",
        "allow-overwrite": "false",
        "referer": REFERER,
    }
    target = url if mode == "direct" else proxy_url(url, name)
    gid = aria_call("aria2.addUri", [[target], aopts], rpc=rpc, secret=secret)
    return {"name": name, "gid": gid, "out": os.path.join(outdir, outname), "url": target,
            "opts": {"split": split, "conn": conn, "minSplit": mss, "dir": outdir}}


# ------------------------------------------------------- 4MiB 分块中转（给 aria2 用）
# 百度 CDN 只吃「闭合且 ≤4MiB」的 Range：bytes=S-E 可以，bytes=0- 直接 31326 403。
# aria2 收尾/探测一定发 bytes=S-，所以直链喂给 aria2 必然 403。这里把它的请求
# 拆成 4MiB 闭合块串流回去，aria2 端看起来就是一条普通支持断点续传的 URL。
CHUNK = 4 << 20
_RETRY = 3


def _ascii_url(u):
    """把 8.3 里那点非 ASCII（fm2 里的省份）转成 %XX，别让 urllib 崩在 ascii 编码上。"""
    return "".join(c if ord(c) < 128 else urllib.parse.quote(c) for c in u)


def _cdn_open(url, start, end, ua):
    """拿一块 [start,end]，返回 (resp, total)。"""
    url = _ascii_url(url)
    last = None
    for _ in range(_RETRY):
        req = urllib.request.Request(url, headers={
            "User-Agent": ua,
            "Referer": REFERER,
            "Range": "bytes=%d-%d" % (start, end),
        })
        try:
            r = urllib.request.urlopen(req, timeout=60)
        except urllib.error.HTTPError as e:
            last = "HTTP %s %s" % (e.code, e.read()[:120].decode("utf-8", "replace"))
            time.sleep(0.6)
            continue
        except Exception as e:  # noqa: BLE001
            last = repr(e)
            time.sleep(0.6)
            continue
        total = None
        cr = r.headers.get("Content-Range") or ""
        m = re.match(r"bytes\s+\d+-\d+/(\d+)", cr)
        if m:
            total = int(m.group(1))
        return r, total
    raise RuntimeError(last or "CDN 请求失败")


# ------------------------------------------------------------------- http 层
def hostname_of(h):
    """从 Host / URL 里取主机名，兼容 [::1]:8765 这种写法。"""
    h = (h or "").strip().lower()
    if h.startswith("["):
        return h[:h.find("]") + 1] if "]" in h else h
    return h.split(":")[0]


def rpc_allowed(url):
    """aria2 RPC 只允许回环地址，否则 /push 就成了任意外发 POST 的跳板。"""
    p = urllib.parse.urlparse(url or "")
    return p.scheme in ("http", "https") and hostname_of(p.netloc).strip("[]") in LOOPBACK


def proxy_allowed(url):
    """/proxy 只代取百度 CDN，不做开放中转。"""
    p = urllib.parse.urlparse(url or "")
    if p.scheme not in ("http", "https"):
        return False
    h = (p.hostname or "").lower()
    return any(h == s.lstrip(".") or h.endswith(s) for s in PROXY_HOSTS)


def _cors(handler):
    # 只对网盘页面回 CORS 头；别的 Origin 拿不到 Access-Control-Allow-Origin，
    # 浏览器就不会把响应交给它们，等于连 /ping 都读不了。
    origin = handler.headers.get("Origin")
    if origin and origin.rstrip("/") in ALLOWED_ORIGINS:
        handler.send_header("Access-Control-Allow-Origin", origin)
        handler.send_header("Vary", "Origin")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type, X-BPD-Token")
    # 少了这一行，https 页面 fetch 本机会被判成「私有网络请求」而拒绝
    handler.send_header("Access-Control-Allow-Private-Network", "true")


class Handler(BaseHTTPRequestHandler):
    server_version = "bpd-daemon/" + VERSION
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *a):
        sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), fmt % a))

    # ------------------------------------------------------------ 请求准入
    def _origin_ok(self):
        o = self.headers.get("Origin")
        return not o or o.rstrip("/") in ALLOWED_ORIGINS

    def _host_ok(self):
        h = self.headers.get("Host")
        return not h or hostname_of(h).strip("[]") in LOOPBACK

    def _guard(self):
        """每个请求先过这两关：Host 骗不过，Origin 不在白名单直接 403。"""
        if not self._host_ok():
            self._send(403, {"ok": False, "error": "Host %s 不被接受：只允许 127.0.0.1 / localhost"
                             % self.headers.get("Host")})
            return False
        if not self._origin_ok():
            self._send(403, {"ok": False, "error": "Origin %s 不被接受：只有网盘页面和本地工具能调用"
                             % self.headers.get("Origin")})
            return False
        return True

    def _auth_ok(self):
        if not AUTH:
            return True
        # 只认请求头：token 进 query string 会漏进日志和历史记录
        got = self.headers.get("X-BPD-Token") or ""
        return secrets.compare_digest(got.encode("utf-8"), TOKEN.encode("utf-8"))

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False)
        raw = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        _cors(self)
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self):
        if not self._guard():
            return
        self.send_response(204)
        _cors(self)
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ------------------------------------------------------------------ GET
    def do_GET(self):
        if not self._guard():
            return
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == "/ping":
            aria = {"ok": False}
            try:
                aria = {"ok": True, "version": aria_call("aria2.getVersion", [], timeout=3).get("version")}
            except RuntimeError as e:
                aria = {"ok": False, "error": str(e)}
            return self._send(200, {
                "ok": True, "version": VERSION,
                "auth": AUTH, "token": TOKEN if AUTH else "",
                "proxy_hosts": list(PROXY_HOSTS),
                "worker": WORKER, "worker_exists": os.path.exists(WORKER),
                "cookie_file": os.path.exists(COOKIE_FILE), "outdir": OUTDIR,
                "defaults": {"split": 4, "conn": 4, "minSplit": "1M", "dir": OUTDIR},
                "jobs": len(JOBS), "aria": aria, "rpc": ARIA_RPC,
            })
        if u.path == "/aria":
            rpc = (q.get("rpc") or [ARIA_RPC])[0]
            if not rpc_allowed(rpc):
                return self._send(400, {"ok": False, "error": "rpc 只能是本机地址：%s" % rpc})
            secret = (q.get("secret") or [ARIA_SECRET])[0]
            try:
                ver = aria_call("aria2.getVersion", [], rpc=rpc, secret=secret)
                gs = aria_call("aria2.getGlobalStat", [], rpc=rpc, secret=secret)
                act = aria_call("aria2.tellActive", [], rpc=rpc, secret=secret)
                return self._send(200, {
                    "ok": True, "version": ver.get("version"),
                    "speed": int(gs.get("downloadSpeed") or 0),
                    "active": len(act or []),
                    "names": [d.get("files", [{}])[0].get("path", "").split("/")[-1] for d in (act or [])],
                })
            except RuntimeError as e:
                return self._send(200, {"ok": False, "error": str(e)})
        if u.path == "/proxy":
            return self._proxy(q)
        if u.path == "/jobs":
            return self._send(200, {"ok": True, "jobs": JOBS})
        if u.path == "/log":
            f = (q.get("file") or [""])[0]
            base = os.path.realpath(LOGDIR)
            real = os.path.realpath(f) if f else ""
            # 只读 LOGDIR 里的日志：这个接口原来是任意文件读取
            if not real.startswith(base + os.sep) or not os.path.isfile(real):
                return self._send(404, {"ok": False, "error": "no such log"})
            f = real
            with open(f, "r", errors="replace") as fh:
                lines = fh.readlines()[-200:]
            return self._send(200, "".join(lines), "text/plain; charset=utf-8")
        return self._send(404, {"ok": False, "error": "not found"})

    # ------------------------------------------------------------ /proxy 实现
    def _proxy(self, q):
        raw = (q.get("u") or [""])[0]
        if not raw:
            return self._send(400, {"ok": False, "error": "缺少 u 参数"})
        url = raw
        if not proxy_allowed(url):
            return self._send(403, {"ok": False, "error":
                                    "只代取百度 CDN 的直链，不接受的域名：%s" % url[:120]})
        ua = DEFAULT_UA
        rng = self.headers.get("Range") or ""
        m = re.match(r"bytes=(\d+)-(\d*)", rng)
        start = int(m.group(1)) if m else 0
        end_req = int(m.group(2)) if (m and m.group(2)) else None

        first_end = start + CHUNK - 1
        if end_req is not None and end_req < first_end:
            first_end = end_req
        try:
            r, total = _cdn_open(url, start, first_end, ua)
        except RuntimeError as e:
            sys.stderr.write("[proxy] 首块失败 start=%d %s\n" % (start, e))
            return self._send(502, {"ok": False, "error": str(e)})

        stop = end_req if end_req is not None else (total - 1 if total else None)

        fn = (q.get("fn") or [""])[0]
        self.send_response(206 if m else 200)
        self.send_header("Content-Type", r.headers.get("Content-Type") or "application/octet-stream")
        if fn:
            self.send_header("Content-Disposition",
                             "attachment; filename*=UTF-8''" + urllib.parse.quote(fn, safe=""))
        self.send_header("Accept-Ranges", "bytes")
        if total is not None and stop is not None:
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, stop, total))
            self.send_header("Content-Length", str(stop - start + 1))
        else:
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()

        pos = start
        resp = r
        try:
            while True:
                if stop is not None and pos > stop:
                    break
                need = CHUNK if stop is None else min(CHUNK, stop - pos + 1)
                while need > 0:
                    try:
                        buf = resp.read(min(need, 65536))
                    except Exception as e:  # noqa: BLE001
                        sys.stderr.write("[proxy] 读中断 pos=%d %r\n" % (pos, e))
                        buf = b""
                        need = 0
                        stop = pos - 1
                        break
                    if not buf:
                        need = 0
                        if stop is None:
                            stop = pos - 1
                        break
                    self.wfile.write(buf)
                    pos += len(buf)
                    need -= len(buf)
                try:
                    resp.close()
                except Exception:  # noqa: BLE001
                    pass
                if stop is not None and pos > stop:
                    break
                if stop is None and total is not None and pos >= total:
                    break
                try:
                    nxt_end = pos + CHUNK - 1 if stop is None else min(pos + CHUNK - 1, stop)
                    resp, t2 = _cdn_open(url, pos, nxt_end, ua)
                    if t2:
                        total = t2
                except RuntimeError as e:
                    sys.stderr.write("[proxy] 续块失败 pos=%d %s\n" % (pos, e))
                    break
        except (BrokenPipeError, ConnectionResetError):
            sys.stderr.write("[proxy] 客户端断开 pos=%d\n" % pos)
            return
        finally:
            try:
                resp.close()
            except Exception:  # noqa: BLE001
                pass

    def do_HEAD(self):
        if not self._guard():
            return
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path != "/proxy":
            return self._send(404, {"ok": False, "error": "not found"})
        url = (q.get("u") or [""])[0]
        if not proxy_allowed(url):
            return self._send(403, {"ok": False, "error": "只代取百度 CDN 的直链"})
        try:
            r, total = _cdn_open(url, 0, CHUNK - 1, DEFAULT_UA)
            r.close()
        except RuntimeError as e:
            return self._send(502, {"ok": False, "error": str(e)})
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(total or 0))
        _cors(self)
        self.end_headers()

    # ----------------------------------------------------------------- POST
    def do_POST(self):
        if not self._guard():
            return
        u = urlparse(self.path)
        n = int(self.headers.get("Content-Length") or 0)
        if n > (2 << 20):
            return self._send(413, {"ok": False, "error": "请求体太大"})
        raw = self.rfile.read(n) if n else b"{}"
        try:
            data = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            return self._send(400, {"ok": False, "error": "bad json"})

        if not self._auth_ok():
            return self._send(401, {"ok": False, "error":
                                    "缺少或错误的 X-BPD-Token。用户脚本 2.9.48+ 会自动从 /ping 取；"
                                    "旧脚本请更新（重新导入 baidu_pan_direct.user.js）；"
                                    "命令行调用就带上 X-BPD-Token: <GET /ping 里的 token>"})

        if u.path == "/push":
            items = data.get("items")
            if not items and data.get("url"):
                items = [data]
            if not items:
                return self._send(400, {"ok": False, "error": "没有可推送的直链"})
            rpc = data.get("rpc") or ARIA_RPC
            if not rpc_allowed(rpc):
                return self._send(400, {"ok": False, "error": "rpc 只能是本机地址：%s" % rpc})
            secret = data.get("secret") if data.get("secret") is not None else ARIA_SECRET
            mode = data.get("mode") or "proxy"
            base = {"dir": data.get("dir"), "split": data.get("split"),
                    "conn": data.get("conn"), "minSplit": data.get("minSplit"),
                    "cookie": data.get("cookie")}
            added, failed = [], []
            client = ""
            for it in items:
                try:
                    o = dict(base)
                    for k, v in (it.get("opts") or {}).items():
                        if v not in (None, ""):
                            o[k] = v
                    r = push_one(it, rpc, secret, mode=mode, opts=o)
                    if not client:
                        try:
                            client = "aria2 " + str(aria_call("aria2.getVersion", [], rpc=rpc,
                                                              secret=secret, timeout=5).get("version"))
                        except RuntimeError:
                            client = "aria2"
                    added.append(r)
                except RuntimeError as e:
                    failed.append({"name": it.get("name") or "", "error": str(e)})
                except Exception as e:  # noqa: BLE001
                    failed.append({"name": it.get("name") or "", "error": repr(e)})
            if not added and failed:
                return self._send(200, {"ok": False, "error": failed[0]["error"],
                                        "added": added, "failed": failed})
            return self._send(200, {"ok": True, "client": client, "rpc": rpc,
                                    "added": added, "failed": failed})

        if u.path != "/start":
            return self._send(404, {"ok": False, "error": "not found"})

        path = (data.get("path") or "").strip()
        if not path.startswith("/"):
            return self._send(400, {"ok": False, "error": "path 要以 / 开头，例如 /a.epub"})

        alive = [j for j in JOBS if j.get("rc") is None and _alive(j["pid"])]
        if len(alive) >= MAX_JOBS:
            return self._send(429, {"ok": False, "error": "已经在跑 %d 个任务了" % len(alive)})

        if not os.path.exists(WORKER):
            return self._send(500, {"ok": False, "error": "找不到下载脚本：" + WORKER})

        os.makedirs(LOGDIR, exist_ok=True)
        name = str(data.get("name") or "").replace("\\", "/")
        name = os.path.basename(name) or os.path.basename(path) or "download.bin"
        name = re.sub(r"[\x00-\x1f]", "", name).strip() or "download.bin"
        log = os.path.join(LOGDIR, "%s-%s.log" % (time.strftime("%Y%m%d-%H%M%S"), _slug(name)))
        target = os.path.realpath(os.path.join(OUTDIR, name))
        if os.path.dirname(target) != os.path.realpath(OUTDIR):
            return self._send(400, {"ok": False, "error": "文件名不合法：%s" % name})
        if os.path.exists(target) and not data.get("force"):
            return self._send(409, {"ok": False, "error": "目标已存在，先改名或删掉：" + target})
        cmd = [sys.executable, WORKER, "--path", path, "-o", target]
        fh = open(log, "wb")
        proc = subprocess.Popen(cmd, stdout=fh, stderr=subprocess.STDOUT, cwd=HERE,
                                start_new_session=True)
        job = {"pid": proc.pid, "path": path, "name": name, "log": log,
               "started": time.strftime("%Y-%m-%d %H:%M:%S"), "cmd": " ".join(cmd), "rc": None}
        JOBS.append(job)
        del JOBS[:-20]
        sys.stderr.write("started pid=%d %s\n" % (proc.pid, path))
        return self._send(200, {"ok": True, "pid": proc.pid, "log": log, "cmd": job["cmd"]})


def _alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _slug(s):
    keep = "".join(c if (c.isalnum() or c in "-_.") else "-" for c in s)
    return keep[:60] or "job"


def main():
    # Cookie 只跟 python 备胎 worker（/start）有关；aria2 走 CDN /proxy，只要签名 + UA，
    # 不需要任何本地 cookie 文件，所以缺了也照常工作。
    if not os.path.exists(COOKIE_FILE):
        sys.stderr.write(
            "提示：没找到 ~/.baidu_pan_cookie。aria2 直链/中转不受影响；\n"
            "      只有 python 备胎 worker（POST /start）需要它：python3 %s\n"
            % os.path.join(HERE, "chrome_baidu_cookie.py"))
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError as e:
        sys.exit("端口 %d 起不来（%s）。八成已经有一个在跑了：\n"
                 "  curl -s 127.0.0.1:%d/ping     # 有响应就是它\n"
                 "  lsof -ti tcp:%d | xargs kill  # 或者换 BPD_PORT"
                 % (PORT, e.strerror or e, PORT, PORT))
    sys.stderr.write("bpd daemon v%s 监听 http://127.0.0.1:%d\n  worker=%s\n  aria2=%s\n"
                     % (VERSION, PORT, WORKER, ARIA_RPC))
    if AUTH:
        sys.stderr.write("  写操作需要 token（页面自动从 /ping 取）：%s\n" % TOKEN)
    try:
        aria_call("aria2.getVersion", [], timeout=2)
        sys.stderr.write("  aria2 连上了\n")
    except RuntimeError as e:
        sys.stderr.write("  %s\n" % e)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        sys.stderr.write("\nbye\n")


if __name__ == "__main__":
    main()
