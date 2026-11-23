#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
bpd_speedtest.py —— 量百度网盘 CDN 对当前账号的实际吞吐。

为什么要单独量：我们自己的下载器（页面内 6 并发 / aria2 走 /proxy）跑多快，
取决于账号级的限速，而不是代码。这个脚本把「单连接」和「N 连接」分开测，
一眼能看出加连接到底有没有用。

用法：
    python3 bpd_speedtest.py --file /图书资源/foo.epub      # 1MiB x 4 采样 + 2/6 并发
    python3 bpd_speedtest.py --file /图书资源/foo.epub --chunk 4M --conns 1,4,8 --samples 3
    python3 bpd_speedtest.py --url 'https://xxx.baidupcs.com/file/...'   # 跳过 cookie

依赖：只有标准库。直链靠 ~/.baidu_pan_cookie 换（GET pcs /rest/2.0/pcs/file 拿 302）。
没有 cookie 也能跑：--url 直接给一条 baidupcs.com 的签名直链。
"""
import argparse
import http.client
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

PCS = 'https://pcs.baidu.com/rest/2.0/pcs/file?method=download&app_id=250528&path='
UA = 'netdisk;P2SP;3.0.20.128;Windows10;AMD64;Resolution:1920x1080'
COOKIE_FILE = os.path.expanduser('~/.baidu_pan_cookie')
MAX_RANGE = 4 << 20          # CDN 只吃闭合且 <=4MiB 的 Range，超过就 403 31326


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def dlink(path, cookie, timeout=30):
    """拿一条 8 小时有效的 baidupcs CDN 直链。"""
    url = PCS + urllib.parse.quote(path)
    req = urllib.request.Request(url, headers={'Cookie': cookie, 'User-Agent': UA})
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        opener.open(req, timeout=timeout)
        raise SystemExit('pcs 没有回 302，cookie 可能过期了')
    except urllib.error.HTTPError as e:
        loc = e.headers.get('Location')
        if not loc:
            raise SystemExit('pcs 回了 %s 但没有 Location：%s' % (e.code, e.read()[:200]))
        return loc


def head_size(url, timeout=30):
    """问一下文件多大（用闭合 Range 请求 206 的 Content-Range）。"""
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Range': 'bytes=0-0'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        cr = r.headers.get('Content-Range') or ''
        r.read()
    if '/' in cr:
        return int(cr.rsplit('/', 1)[1])
    raise SystemExit('CDN 没给 Content-Range，拿不到总大小')


def fetch(url, start, length):
    """下一个闭合 Range 块，返回 (字节数, 秒数)。"""
    end = start + length - 1
    req = urllib.request.Request(url, headers={'User-Agent': UA,
                                               'Range': 'bytes=%d-%d' % (start, end)})
    t0 = time.time()
    n = 0
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            while True:
                b = r.read(65536)
                if not b:
                    break
                n += len(b)
    except urllib.error.HTTPError as e:
        return (-e.code, time.time() - t0)
    except http.client.IncompleteRead as e:      # CDN 断流：拿到多少算多少
        n += len(e.partial or b'')
    except Exception:
        pass
    return (n, time.time() - t0)


def kb(n):
    return n / 1024.0


def run_single(url, total, length, samples):
    print('\n=== 单连接（每块 %.1f MiB，%d 次采样）===' % (length / 1048576.0, samples))
    speeds = []
    for i in range(samples):
        start = (i * 7919 * 1048576) % max(1, total - length)     # 分散取样，别都挤在开头
        n, dt = fetch(url, start, length)
        if n <= 0:
            print('  offset %-9d 失败 HTTP %d' % (start, -n))
            continue
        sp = kb(n) / dt
        speeds.append(sp)
        print('  offset %-9d %7.1f KB %6.2fs %8.1f KB/s' % (start, kb(n), dt, sp))
    if speeds:
        print('  --- 单连接均值 %.1f KB/s，最快 %.1f，最慢 %.1f' %
              (sum(speeds) / len(speeds), max(speeds), min(speeds)))
    return speeds


def run_parallel(url, total, length, conns):
    print('\n=== %d 连接并发（每块 %.1f MiB）===' % (conns, length / 1048576.0))
    base = min(total - length, 32 << 20)
    starts = [base + i * length for i in range(conns)]
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=conns) as ex:
        res = list(ex.map(lambda s: fetch(url, s, length), starts))
    wall = time.time() - t0
    ok = sum(n for n, _ in res if n > 0)
    bad = [n for n, _ in res if n <= 0]  # <=0 = 断流或 HTTP 错
    for i, (n, dt) in enumerate(res):
        tag = ('%.1f KB/s' % (kb(n) / dt)) if n > 0 else ('断流 0 字节' if n == 0 else 'HTTP %d' % -n)
        print('  conn%-2d %8.1f KB %7.2fs %s' % (i, kb(n), dt, tag))
    if bad:
        print('  %d 个连接失败：%s' % (len(bad), bad))
    agg = kb(ok) / wall
    print('  --- 合计 %.1f MiB / %.2fs = %.1f KB/s（%.2f MB/s）' %
          (ok / 1048576.0, wall, agg, agg / 1024.0))
    return agg


def parse_size(s):
    s = s.strip().upper()
    mult = 1
    for suf, m in (('KIB', 1024), ('MIB', 1 << 20), ('KB', 1000), ('MB', 1000 * 1000), ('K', 1024), ('M', 1 << 20)):
        if s.endswith(suf):
            mult, s = m, s[:-len(suf)]
            break
    return int(float(s) * mult)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--file', default='', help='网盘里的路径，例如 /图书资源/foo.epub（或用 --url）')
    ap.add_argument('--url', default='', help='直接给一条签名直链，跳过 cookie')
    ap.add_argument('--chunk', default='1M', help='每个 Range 块多大，上限 4M')
    ap.add_argument('--samples', type=int, default=4, help='单连接采样次数')
    ap.add_argument('--conns', default='2,6', help='并发连接数，逗号分隔；给 0 跳过')
    a = ap.parse_args()
    if not a.url and not a.file:
        ap.error('给 --file（网盘路径）或 --url（签名直链）之一')

    length = min(parse_size(a.chunk), MAX_RANGE)
    if a.url:
        url = a.url
    else:
        if not os.path.exists(COOKIE_FILE):
            sys.exit('没有 %s，也没有 --url' % COOKIE_FILE)
        cookie = open(COOKIE_FILE).read().strip()
        url = dlink(a.file, cookie)
    total = head_size(url)
    print('文件 %s' % (a.file or '(url)'))
    print('大小 %.2f MiB，块 %.2f MiB，UA %s' % (total / 1048576.0, length / 1048576.0, UA))
    print('直链主机 %s' % urllib.parse.urlparse(url).netloc)

    single = run_single(url, total, length, a.samples)
    aggs = []
    for c in [int(x) for x in a.conns.split(',') if x.strip() and int(x) > 0]:
        aggs.append((c, run_parallel(url, total, length, c)))

    print('\n=== 结论 ===')
    if single:
        s1 = sum(single) / len(single)
        print('单连接 %.1f KB/s' % s1)
        for c, agg in aggs:
            print('%d 连接 %.1f KB/s（%.2fx 单连接，理论线性应该是 %dx）' % (c, agg, agg / s1, c))
        if aggs:
            best = max(agg for _, agg in aggs)
            if best < s1 * 1.6:
                print('加连接几乎不提速 → 瓶颈是「账号级总带宽」，不是我们的分段/并发。')
            else:
                print('加连接有收益 → 瓶颈是「单连接限速」，可以继续加连接。')
        print('按当前速度下这份 %.1f MiB 需要 %.1f 分钟；若到 5 MB/s 只要 %.0f 秒。' %
              (total / 1048576.0, total / 1024.0 / s1 / 60, total / (5 << 20)))


if __name__ == '__main__':
    main()
