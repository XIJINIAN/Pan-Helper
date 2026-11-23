#!/usr/bin/env python3
"""Pull the pan.baidu.com cookie out of Chrome into ~/.baidu_pan_cookie.

Why this dance
--------------
`BDUSS` is HttpOnly, so no page script can read it, and on macOS another process
cannot open Chrome's cookie DB: TCC denies `~/Library/Application Support/Google/
Chrome/...` with EPERM no matter which shell you use (`cp`, `sqlite3`, Finder via
osascript - all the same block). Chrome itself is allowed, of course - it owns
that directory.

So let Chrome do the file handling: this script starts a throw-away page on
127.0.0.1, you hand Chrome's own `Cookies` file to a `<input type=file>`, the
bytes come back over localhost, and the values get decrypted with the key from
the login keychain ("Chrome Safe Storage" -> PBKDF2-SHA1, 1003 rounds, salt
"saltysalt" -> AES-128-CBC, IV = 16 spaces, `v10`/`v11` prefix, plaintext starts
with sha256(host_key) which is stripped).

Usage
-----
    ./chrome_baidu_cookie.py                 # interactive: opens the grab page
    ./chrome_baidu_cookie.py --db PATH       # use an already copied Cookies file
    ./chrome_baidu_cookie.py --print         # just show the header, do not save

Then:
    ./baidu_epub_dlink.py                    # 4 MiB-range download past the 50MB wall
"""
import argparse
import glob
import hashlib
import http.server
import os
import socketserver
import sqlite3
import subprocess
import sys
import tempfile
import urllib.parse
import webbrowser

CHROME_GLOBS = [
    "~/Library/Application Support/Google/Chrome/Default/Cookies",
    "~/Library/Application Support/Google/Chrome/Profile */Cookies",
    "~/Library/Application Support/Chromium/Default/Cookies",
    "~/Library/Application Support/Microsoft Edge/Default/Cookies",
]
WANT = ("BDUSS", "STOKEN", "PANPSC", "PANWEB", "BDCLND", "BAIDUID")
OUT = os.path.expanduser("~/.baidu_pan_cookie")
PORT = 8766

PAGE = """<!doctype html><meta charset=utf-8><title>cookie grab</title>
<style>body{font:14px -apple-system,system-ui;padding:24px;max-width:44em}
code{background:#f2f2f2;padding:1px 4px;border-radius:3px;word-break:break-all}</style>
<h3>把 Chrome 的 Cookies 文件交给这个页面</h3>
<p>点下面的按钮，选 <code>~/Library/Application Support/Google/Chrome/Default/Cookies</code>
（不带扩展名，1 MB 左右的那个）。</p>
<p>文件只在 127.0.0.1 上转一手就解密，不会上传到任何地方。</p>
<input type=file id=f>
<pre id=log></pre>
<script>
document.getElementById('f').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  const log = document.getElementById('log');
  log.textContent = 'reading ' + f.name + ' (' + f.size + ' bytes)\\n';
  const r = await fetch('/save?name=' + encodeURIComponent(f.name),
                        {method: 'POST', body: await f.arrayBuffer()});
  log.textContent += await r.text();
});
</script>
"""


class Handler(http.server.BaseHTTPRequestHandler):
    db_bytes = None
    db_name = None

    def log_message(self, *a):
        pass

    def do_GET(self):
        b = PAGE.encode()
        self.send_response(200)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        Handler.db_bytes = self.rfile.read(n)
        Handler.db_name = self.path.split("name=")[-1]
        msg = "收到 %d 字节。回终端看结果。\n" % len(Handler.db_bytes)
        self.send_response(200)
        self.send_header("content-type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(msg.encode())


def read_cookies(db_path):
    """Decrypt every baidu cookie out of a Chrome Cookies sqlite file.

    Raises RuntimeError when the keychain item is unreadable, so callers can
    decide whether that is fatal (this script) or a reason to fall back
    (baidu_epub_dlink.py still has env vars and ~/.baidu_pan_cookie).
    """
    pw = subprocess.run(["security", "find-generic-password", "-w", "-s", "Chrome Safe Storage"],
                        capture_output=True, text=True).stdout.strip()
    if not pw:
        raise RuntimeError('keychain item "Chrome Safe Storage" not readable '
                           '- allow the prompt, or pass --bduss')
    key = hashlib.pbkdf2_hmac("sha1", pw.encode(), b"saltysalt", 1003, 16).hex()

    def dec(host, blob):
        if blob[:3] not in (b"v10", b"v11"):
            return None
        out = subprocess.run(["openssl", "enc", "-d", "-aes-128-cbc", "-K", key,
                              "-iv", "20" * 16, "-nopad"],
                             input=blob[3:], capture_output=True).stdout
        if not out:
            return None
        pad = out[-1]
        if 0 < pad <= 16:
            out = out[:-pad]
        if len(out) > 32 and out[:32] == hashlib.sha256(host.encode()).digest():
            out = out[32:]
        try:
            return out.decode("utf-8")
        except UnicodeDecodeError:
            return None

    jar = {}
    # 只读打开：路径里可能有空格，所以走 URI 并转义（sqlite 不认裸路径的 ?query）
    uri = "file:%s?mode=ro" % urllib.parse.quote(os.path.abspath(db_path))
    con = sqlite3.connect(uri, uri=True)
    for host, name, val, enc in con.execute(
            "select host_key,name,value,encrypted_value from cookies "
            "where host_key like '%baidu%'"):
        v = val or dec(host, bytes(enc))
        if v:
            jar.setdefault(name, v)
    return jar


def save(jar):
    hdr = "; ".join("%s=%s" % (k, jar[k]) for k in WANT if k in jar)
    if "BDUSS" not in jar:
        sys.exit("no BDUSS in there - wrong profile? (tried %d baidu cookies)" % len(jar))
    with open(OUT, "w") as f:
        f.write(hdr + "\n")
    os.chmod(OUT, 0o600)
    print("wrote %s  (%d chars: %s)" % (OUT, len(hdr), ", ".join(k for k in WANT if k in jar)))


def grab_interactive():
    socketserver.TCPServer.allow_reuse_address = True
    srv = socketserver.TCPServer(("127.0.0.1", PORT), Handler)
    url = "http://127.0.0.1:%d/" % PORT
    print("open %s  (a browser window may have opened already)" % url)
    print("choose this file in the page:")
    for g in CHROME_GLOBS:
        for p in glob.glob(os.path.expanduser(g)):
            print("   ", p)
    try:
        webbrowser.open(url)
    except Exception:                                  # noqa: BLE001
        pass
    print("waiting for the file ... (ctrl-c to give up)")
    while Handler.db_bytes is None:
        srv.handle_request()
    srv.server_close()
    # 这是整站 cookie 库（含所有站点的密文），落地就 0600，解完立刻删
    fd, tmp = tempfile.mkstemp(prefix="bpd_cookies_", suffix=".db")
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(Handler.db_bytes)
    print("got %d bytes -> %s (0600, deleted after decrypt)" % (len(Handler.db_bytes), tmp))
    return tmp


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=None, help="an already copied Chrome Cookies file")
    ap.add_argument("--print", action="store_true", dest="show")
    ap.add_argument("--bduss", default=None, help="skip all of this: give BDUSS directly")
    a = ap.parse_args()

    if a.bduss:
        print("BAIDU_PAN_COOKIE='BDUSS=%s'  (API only; the CDN needs STOKEN/PANPSC too)" % a.bduss)
        return

    db = a.db
    grabbed = None
    if not db:
        for g in CHROME_GLOBS:
            for p in glob.glob(os.path.expanduser(g)):
                try:
                    open(p, "rb").read(16)
                    db = p
                    break
                except OSError:
                    continue
            if db:
                break
    if not db:
        print("Chrome's cookie DB is not readable from here (macOS TCC).", file=sys.stderr)
        db = grabbed = grab_interactive()

    try:
        jar = read_cookies(db)
    except RuntimeError as e:
        sys.exit(str(e))
    finally:
        if grabbed and os.path.exists(db):
            os.unlink(db)          # 临时库不留痕
    print("decrypted:", ", ".join("%s(%d)" % (k, len(v)) for k, v in jar.items() if k in WANT))
    if a.show:
        print("; ".join("%s=%s" % (k, jar[k]) for k in WANT if k in jar))
        return
    save(jar)


if __name__ == "__main__":
    main()
