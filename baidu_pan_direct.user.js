// ==UserScript==
// @name         百度网盘 直链下载（接管原生下载按钮）
// @name:en      Baidu Pan direct download — takes over the native 下载 button
// @namespace    https://pan.baidu.com/
// @version      2.9.51
// @description  点网盘里原来那个「下载」按钮，就用客户端身份分块从 PCS/CDN 拉真实文件，不弹「>50MB 请用客户端」。进度是套在原生图标上的一圈细环，悬停出卡片：暂停/继续/取消、复制直链、复制命令行、送到本机终端多线程下载。
// @author       -
// @homepageURL  https://github.com/XIJINIAN/Pan-Helper
// @supportURL   https://github.com/XIJINIAN/Pan-Helper/issues
// @match        https://pan.baidu.com/disk/*
// @match        https://pan.baidu.com/s/*
// @connect      pan.baidu.com
// @connect      pcs.baidu.com
// @connect      *.baidupcs.com
// @connect      baidupcs.com
// @connect      127.0.0.1
// @run-at       document-start
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        unsafeWindow
// ==/UserScript==

/* 原理（两句话）
 * 1. 「>50MB 请用客户端」这道墙量的是**单次请求**落下的字节数，不是文件大小：
 *    Range: bytes=0-4194303 → 206 放行；bytes=0-8388607 → 403 {"error_code":31326}。
 *    所以整份文件 = N 个 ≤4MiB 的 Range 拼起来。
 * 2. 另一半开关是 User-Agent：CDN 上 netdisk 客户端 UA → 206，Chrome UA → 403。
 *    网页 fetch 改不了 UA（forbidden header），只有 GM_xmlhttpRequest 能改。
 */

(function () {
  'use strict';

  var VERSION = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '2.9.51';
  var CHUNK = 512 * 1024;                 // 512KiB：远低于 4MiB 墙，进度每 ~4s 动一次，请求固定开销摊得开
  var CLIENT_UA = [
    'netdisk;P2SP;3.0.20.128;Windows10;AMD64;Resolution:1920x1080',
    'netdisk;P2SP;2.2.5.2;Windows10;AMD64',
    'netdisk;8.0.0;android-android-10;network/UNKNOWN;'
  ];
  var REFERER = 'https://pan.baidu.com/disk/main';
  var DAEMON = 'http://127.0.0.1:8765';

  /* ------------------------------------------------------------------ 设置
   * 全部存在 GM 存储里（bpd_cfg），页面右下角齿轮改，改完立即生效、下次开页还在。
   * 默认值就是「本机守护进程 + 本机 aria2」这套最常见组合，装上不用改也能跑。 */
  var DEF = {
    daemon: 'http://127.0.0.1:8765',        /* 本机守护进程：/proxy 中转 + /push 转发 */
    rpc: 'http://127.0.0.1:16800/jsonrpc',  /* aria2 JSON-RPC（Motrix 默认 16800） */
    secret: '',                             /* aria2 --rpc-secret，没设就留空 */
    split: 4,                               /* aria2 线程数（-x / -s） */
    conn: 4,                                /* aria2 max-connection-per-server */
    minSplit: '1M',                         /* aria2 min-split-size */
    ariaDir: '',                            /* 空=用 aria2 自己的下载目录 */
    cap: 6,                                 /* 页面内同时发几个 Range */
    chunk: 512,                             /* 页面内每块多少 KiB */
    shareDir: '/'                           /* 分享页文件先转存到哪 */
  };
  var CFG = null;
  function cfg() {
    if (CFG) return CFG;
    var c = {}, k;
    for (k in DEF) c[k] = DEF[k];
    var saved = gGet('bpd_cfg', null);
    if (saved && typeof saved === 'object') {
      for (k in saved) if (k in c) c[k] = saved[k];
    } else {                                /* 老版本的散键，迁过来 */
      c.cap = +gGet('bpd_cap', c.cap) || c.cap;
      c.rpc = gGet('bpd_rpc_url', c.rpc) || c.rpc;
      c.shareDir = gGet('bpd_dir', c.shareDir) || c.shareDir;
    }
    CFG = c;
    return CFG;
  }
  function saveCfg(patch) {
    var c = cfg(), k;
    for (k in patch) if (k in DEF) c[k] = patch[k];
    CFG = c;
    gSet('bpd_cfg', c);
    applyCfg();
  }
  function applyCfg() {
    var c = cfg();
    DAEMON = String(c.daemon || DEF.daemon).replace(/\/+$/, '');
    CHUNK = Math.max(64, Math.min(8192, +c.chunk || 512)) * 1024;
    G.cap = Math.max(1, Math.min(24, +c.cap || 6));
  }

  /* 「复制链接」到底给什么？
     原始 CDN 直链扔给 aria2/IDM 一定 403：百度只认「闭合且 ≤4MiB」的 Range，
     aria2 探测和收尾都发 bytes=S-，直接被 31326 打回。所以复制出去的是本机
     守护进程的 4MiB 分块中转链接——任何下载器都吃，能续传，也能直接拖进浏览器。 */
  function proxyLink(t) {
    if (!t || !t.url) return '';
    return DAEMON + '/proxy?u=' + encodeURIComponent(t.url)
      + '&fn=' + encodeURIComponent(t.name || 'download.bin');
  }
  /* 守护进程活着没：决定「复制链接」给中转链接还是给纯 shell 分块命令、以及「推送」能不能用。
     没装 python 的人也用得上——页面内下载本来就不依赖守护进程。 */
  var DAEMON_OK = null;
  var DAEMON_TOKEN = '';                  /* 写操作要带它：/ping 给，重启后自动重取 */
  function pingDaemon(silent) {
    return fetch(DAEMON + '/ping', { cache: 'no-store' }).then(function (r) { return r.json(); })
      .then(function (j) {
        DAEMON_OK = !!(j && j.ok); DAEMON_INFO = j || null;
        DAEMON_TOKEN = (j && j.token) || '';
        if (!silent) renderAll();
        return DAEMON_OK;
      })
      .catch(function () { DAEMON_OK = false; DAEMON_INFO = null; return false; });
  }
  var DAEMON_INFO = null;

  /* 没有守护进程时，「复制链接」改成给一段纯 shell 命令：curl 自己按 4MiB 闭合 Range 并行拉块。
     机器上有 bash + curl 就能用（macOS / Linux / WSL 都有），不需要 python、不需要 aria2。
     三个踩过的坑：① 每块都得回显，否则几十分钟没输出，看着像卡死（97MB 那回就是这么被 Ctrl-C 的）
     ② 不能写 exit 1——粘到交互终端里执行失败会把整个窗口关掉 ③ part.* 落在当前目录，
     重跑同一段就是续传，这一点必须写在输出里，否则没人知道该不该重来。 */
  function curlLoop(t) {
    if (!t || !t.url || !t.size) return '';
    var CS = 4194304, n = Math.max(1, Math.ceil(t.size / CS)), last = t.size - 1;
    var nm = String(t.name || 'download.bin').replace(/["`$\\]/g, '\\$&');
    var ua = (t.ua || CLIENT_UA[0]).replace(/["`$\\]/g, '\\$&');
    return [
      '# 零依赖版：' + n + ' 个 4MiB 闭合 Range，4 路并行（只要有 bash + curl，不用守护进程/aria2/python）',
      '# 百度会随机掐断连接（curl 报 transfer closed），每块都带重试；真掉了就在同一目录重跑整个脚本',
      '# 百度对这个账号的总带宽只有几十到一百多 KB/s'
        + (t.size >= 8 * 1048576
          ? '，' + mb(t.size) + ' 要跑几十分钟以上——慢是账号限速，不是卡住'
          : '，几 MB 的小文件一两分钟就能完'),
      'U="' + t.url + '"',
      'CS=' + CS + '; N=' + n + '; LAST=' + last + '; SIZE=' + t.size + '; UA="' + ua + '"',
      'export U CS N LAST SIZE UA',
      'echo "开始：$N 块 × 4MiB，4 路并行，共 $SIZE 字节。中断了就在同一目录重跑这段，已下好的块会跳过"',
      /* 这里刻意不用 xargs -I：macOS 的 xargs 在 -I 模式下对命令长度有 ~250 字节的硬限制，
         脚本里只要有中文就会 "command line cannot be assembled, too long"。-n 1 没这个毛病，
         块号从 $1 拿（末尾那个 _ 是 sh -c 的 $0）。 */
      String.raw`seq 0 $((N-1)) | xargs -P 4 -n 1 sh -c 'f=$(printf "part.%05d" "$1"); if [ -s "$f" ]; then echo "块 $1 已在，跳过"; exit 0; fi; s=$(($1*CS)); e=$((s+CS-1)); [ $e -gt $LAST ] && e=$LAST; curl -fsS --retry 5 --retry-all-errors --retry-delay 1 -H "User-Agent: $UA" -r $s-$e -o "$f" "$U" && echo "块 $1 ok $(wc -c < "$f" | tr -d " ") B" || { rm -f "$f"; echo "块 $1 失败，重跑这段会重试它" >&2; }' _`,
      /* 别用 part.* 这种裸 glob：zsh 的 nomatch 会对不上就报错，连带 cnt 变成空串 */
      'cnt=$(find . -maxdepth 1 -type f -name "part.[0-9]*" | wc -l | tr -d " ")',
      'if [ "$cnt" -lt "$N" ]; then',
      '  echo "只下好 $cnt/$N 块：在同一目录重跑这段，已完成的块会跳过"',
      'else',
      '  : > "' + nm + '"',
      '  i=0; while [ "$i" -lt "$N" ]; do cat "$(printf "part.%05d" "$i")" >> "' + nm + '"; i=$((i+1)); done',
      '  find . -maxdepth 1 -type f -name "part.[0-9]*" -delete',
      '  S=$(wc -c < "' + nm + '" | tr -d " ")',
      '  if [ "$S" -eq "$SIZE" ]; then echo "完成 $S 字节 → ' + nm + '"; else echo "大小不对：$S / $SIZE（重跑会补）"; fi',
      'fi'
    ].join('\n');
  }

  function aria2Cmd(t) {
    if (!t || !t.url) return '';
    var c = cfg();
    /* 有守护进程就喂中转链接（任意大小都能下）；没有就喂原始直链——aria2 会发开口 Range，
       ≤4MiB 的文件能过，更大的会被百度 403（这是单请求上限，不是我们加的） */
    var target = DAEMON_OK === false ? t.url : proxyLink(t);
    return 'aria2c -c -x' + (+c.split || 4) + ' -s' + (+c.split || 4)
      + ' -k' + (c.minSplit || '1M') + ' --file-allocation=none -o "' + (t.name || 'download.bin')
      + '" "' + target + '"';
  }

  /* ------------------------------------------------------------------ 小工具 */
  function pageWin() {
    try { return (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window; } catch (e) { return window; }
  }
  function gGet(k, d) { try { var v = GM_getValue(k); return v === undefined ? d : v; } catch (e) { return d; } }
  function gSet(k, v) { try { GM_setValue(k, v); } catch (e) { /* noop */ } }
  /* 大小：够 1 MB 才用 MB，否则退回 KB / B——几百 KB 的文件显示成「0.3 MB」没人看得懂。
     阈值取 1 MiB-512：再往上 Math.round 就会进位成 1024 KB，与其留这个假单位，不如升到 MB。 */
  function mb(n) {
    n = +n || 0;
    if (n >= 1048064) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return Math.round(n) + ' B';
  }
  /* 速度同理：这个账号稳态就在 100 KB/s 附近，一律 toFixed(1)+' MB/s' 只会看到「0.1 MB/s」这种没信息量的数 */
  function rateTxt(r) {
    r = +r || 0;
    if (r >= 1048064) return (r / 1048576).toFixed(1) + ' MB/s';
    if (r >= 1024) return Math.round(r / 1024) + ' KB/s';
    return r > 0 ? Math.max(0.1, Math.round(r / 102.4) / 10) + ' KB/s' : '0 KB/s';
  }
  function short(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').slice(0, 120); }
  /* 名字过长：hover 整行时来回滚一遍，两边各停一下；装得下就不动 */
  function mqInner(box) {
    var k = box && box.firstElementChild;
    return (k && k.tagName === 'B') ? k : null;
  }
  function mqStart(box) {
    var b = mqInner(box);
    if (!b) return;
    var over = Math.max(0, b.scrollWidth - box.clientWidth);
    if (over <= 6) { mqStop(box); return; }              /* 差 6px 以内不值得滚 */
    b.style.setProperty('--mq-dist', (-over) + 'px');
    b.style.setProperty('--mq-dur', (over / 38 + 0.7).toFixed(2) + 's');  /* 38px/s，两端各停 .35s */
    box.classList.remove('is-mq');
    void b.offsetWidth;                                   /* 同一帧 remove+add 不会重跑动画 */
    box.classList.add('is-mq');
  }
  function mqStop(box) {
    if (box) box.classList.remove('is-mq');
  }
  /* 装不下就挂 is-cut（右端渐隐），装得下就摘掉 */
  function mqCut(box) {
    var b = mqInner(box);
    if (!b) return;
    box.__cutW = box.clientWidth;
    box.classList.toggle('is-cut', b.scrollWidth - box.clientWidth > 1);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function hms(sec) {
    if (!isFinite(sec) || sec <= 0) return '--:--';
    sec = Math.round(sec);
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    function p(x) { return (x < 10 ? '0' : '') + x; }
    return h ? h + ':' + p(m) + ':' + p(s) : m + ':' + p(s);
  }
  function copyText(text) {
    try { GM_setClipboard(text, 'text'); return true; } catch (e) { /* 退回 textarea */ }
    try {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e2) { return false; }
  }

  /* 带中止能力的 GM 请求：GM_xmlhttpRequest 返回的 handle 支持 abort() */
  function gm(opt) {
    var req = null, settled = false, rejectFn = null;

    /* 必须在 Promise executor 外面定义：abort() 要能同步 reject，
     * 否则 Violentmonkey 的 onabort 不一定回调，Promise 永不 settle，
     * G.inflight 计数泄光 → 恢复后 pump() 起不来（v2.1.0 的 bug） */
    function fail(msg, isAbort) {
      if (settled || !rejectFn) return;
      settled = true;
      var e = new Error(msg);
      if (isAbort) e.aborted = true;
      rejectFn(e);
    }

    var p = new Promise(function (resolve, reject) {
      rejectFn = reject;
      req = GM_xmlhttpRequest({
        method: opt.method || 'GET',
        url: opt.url,
        headers: opt.headers || {},
        data: opt.data,
        responseType: opt.responseType,
        timeout: opt.timeout || 60000,
        anonymous: false,
        onload: function (r) { if (!settled) { settled = true; resolve(r); } },
        onerror: function () { fail('网络错误'); },
        ontimeout: function () { fail('超时'); },
        onabort: function () { fail('已中止', true); }
      });
    });
    p.abort = function () {
      fail('已中止', true);                       // 先同步落地，保证 inflight 计数回收
      try { if (req && req.abort) req.abort(); } catch (e) { /* noop */ }
    };
    return p;
  }

  function json(url, opt) {
    opt = opt || {};
    return fetch(url, {
      method: opt.method || 'GET',
      credentials: 'include',
      headers: opt.headers || {},
      body: opt.body
    }).then(function (r) { return r.text(); }).then(function (t) {
      try { return JSON.parse(t); } catch (e) { throw new Error('返回不是 JSON：' + short(t)); }
    });
  }

  function qs(pairs) {
    return '&' + pairs.map(function (p) { return p[0] + '=' + encodeURIComponent(p[1]); }).join('&');
  }

  var API_TAIL = qs([['channel', 'chunlei'], ['web', '1'], ['app_id', '250528']]);

  function pcsUrl(path) {
    return 'https://pcs.baidu.com/rest/2.0/pcs/file?method=download&app_id=250528&path='
      + encodeURIComponent(path);
  }

  /* --------------------------------------------------------------- 文件元信息 */
  var metaCache = {};

  function curDir() {
    var h = location.hash || '';
    var m = /[?&]path=([^&]*)/.exec(h);
    if (m) { try { return decodeURIComponent(m[1]); } catch (e) { /* noop */ } }
    return '/';
  }

  function listDir(dir) {
    var url = '/api/list?order=name&desc=0&showempty=0&page=1&num=1000&dir='
      + encodeURIComponent(dir) + '&t=' + Date.now() + '&channel=chunlei&web=1&app_id=250528';
    return json(url).then(function (j) {
      if (j.errno !== 0 || !j.list) throw new Error('/api/list errno=' + j.errno);
      var map = {};
      j.list.forEach(function (it) {
        map[String(it.fs_id)] = {
          fsid: String(it.fs_id), name: it.server_filename,
          path: it.path || ((dir === '/' ? '' : dir) + '/' + it.server_filename),
          size: +it.size, isdir: +it.isdir === 1, md5: it.md5 || ''
        };
      });
      return map;
    });
  }

  function metaOf(fsid) {
    fsid = String(fsid);
    if (metaCache[fsid]) return Promise.resolve(metaCache[fsid]);
    var url = '/api/filemetas?dlink=1&fsids=' + encodeURIComponent('[' + fsid + ']')
      + '&app_id=250528&web=1';
    return json(url).then(function (j) {
      if (j.errno === 0 && j.info && j.info[0]) {
        var it = j.info[0];
        var m = {
          fsid: fsid, name: it.server_filename,
          path: it.path, size: +it.size || 0, isdir: +it.isdir === 1
        };
        metaCache[fsid] = m;
        return m;
      }
      return listDir(curDir()).then(function (map) {
        var m2 = map[fsid];
        if (!m2) throw new Error('找不到文件 ' + fsid + '（errno=' + j.errno + '）');
        metaCache[fsid] = m2;
        return m2;
      });
    });
  }

  /* -------------------------------------------------------------- 探测可用直链 */
  function probe(path) {
    var url = pcsUrl(path);
    var i = 0;
    function attempt() {
      if (i >= CLIENT_UA.length) return Promise.reject(new Error('客户端身份都被 CDN 拒了'));
      var ua = CLIENT_UA[i++];
      return gm({
        method: 'GET', url: url, responseType: 'arraybuffer', timeout: 30000,
        headers: { 'User-Agent': ua, 'Referer': REFERER, 'Range': 'bytes=0-0' }
      }).then(function (r) {
        if (r.status !== 200 && r.status !== 206) {
          throw new Error('HTTP ' + r.status + ' ' + short(r.responseText));
        }
        return { url: r.finalUrl || url, ua: ua };
      }).catch(function (e) {
        console.warn('[bpd] probe ' + ua + ' → ' + e.message);
        return attempt();
      });
    }
    return attempt();
  }

  function rangeGet(url, ua, from, to) {
    var base = gm({
      method: 'GET', url: url, responseType: 'arraybuffer', timeout: 180000,
      headers: { 'User-Agent': ua, 'Referer': REFERER, 'Range': 'bytes=' + from + '-' + to }
    });
    var p = base.then(function (r) {
      if ((r.status !== 200 && r.status !== 206) || !r.response) {
        throw new Error('HTTP ' + r.status + ' ' + short(r.responseText));
      }
      return r.response;
    });
    /* .then() 出来的是派生 Promise，没有 abort，必须把中止能力接出来，
     * 否则暂停时 inflight 永不回收（v2.1.0 的 bug） */
    p.abort = base.abort;
    return p;
  }

  /* ================================================================== 任务引擎 */
  var TASKS = [], TID = 0;
  var G = { cap: +cfg().cap || 6, inflight: 0 };

  function newTask(meta, btn) {
    var t = {
      id: ++TID,
      fsid: String(meta.fsid), name: meta.name || '', size: meta.size || 0, path: meta.path || '',
      btn: btn || null,
      state: 'probe',                 // probe | run | pause | done | err | cancel（取消/完成/失败都留在列表里，面板不消失）
      err: '', url: '', ua: '',
      n: 0, parts: null, queue: [], tries: {}, ctrl: {},
      got: 0, samples: [], rate: 0, pushed: false,
      startAt: Date.now(), endAt: 0, dom: null
    };
    TASKS.push(t);
    /* 新任务必须让人立刻看见：面板缩成小圆钮了、或停在「已结束/已推送」tab 上时，
       自动弹开并切回「进行中」。否则点了下载却「看不到到底什么在进行中」。 */
    try {
      if (panelEl) {
        if (FOLDED) setFold(false);
        if (curTab() !== 'active') setTab('active');
      }
    } catch (e) { /* noop */ }
    return t;
  }

  function idOf(t) { return 'bpd-t' + t.id; }

  function runningTask() {
    for (var i = 0; i < TASKS.length; i++) {
      var t = TASKS[i];
      if (t.state === 'run' && t.queue.length) return t;
    }
    return null;
  }

  function pump() {
    var guard = 0;
    while (G.inflight < G.cap && guard++ < 200) {
      var t = runningTask();
      if (!t) break;
      if (!startChunk(t)) break;
    }
    if (!TASKS.length) stopUi();
  }

  function startChunk(t) {
    var i = t.queue.shift();
    if (i === undefined) return false;
    /* 用任务自己的块大小：中途改设置不能改变在跑任务的分块网格，否则偏移全错、文件必坏 */
    var cs = t.chunk || CHUNK;
    var from = i * cs, to = Math.min(from + cs, t.size) - 1, want = to - from + 1;
    G.inflight++; 
    var req = rangeGet(t.url, t.ua, from, to);
    t.ctrl[i] = req;
    var settled = false;
    function done() {
      if (settled) return;
      settled = true;
      G.inflight--;
      if (t.ctrl[i] === req) delete t.ctrl[i];
    }
    req.then(function (ab) {
      done();
      if (t.state === 'cancel') return;
      if (ab.byteLength !== want) {
        t.tries[i] = (t.tries[i] || 0) + 1;
        if (t.tries[i] > 6) return failTask(t, new Error('块 ' + i + ' 长度 ' + ab.byteLength + '/' + want));
        t.queue.unshift(i);
        return void setTimeout(pump, 600 * t.tries[i]);
      }
      t.parts[i] = ab;
      t.got += want;
      t.tries[i] = 0;
      sample(t);
      if (t.got >= t.size) return completeTask(t);
      pump();
    }, function (e) {
      done();
      if (t.state === 'cancel') return;
      if (t.state === 'pause' || e.aborted) { t.queue.unshift(i); return; }
      t.tries[i] = (t.tries[i] || 0) + 1;
      if (t.tries[i] > 6) return failTask(t, e);
      t.queue.unshift(i);
      setTimeout(pump, 600 * t.tries[i]);
    });
    return true;
  }

  function sample(t) {
    var now = Date.now();
    t.samples.push({ ts: now, got: t.got });
    while (t.samples.length > 2 && now - t.samples[0].ts > 6000) t.samples.shift();
    var first = t.samples[0];
    var dt = (now - first.ts) / 1000;
    if (dt > 0.4) t.rate = (t.got - first.got) / dt;
  }

  function abortInflight(t) {
    Object.keys(t.ctrl).forEach(function (k) {
      try { t.ctrl[k].abort(); } catch (e) { /* noop */ }
    });
  }

  function pauseTask(t) {
    if (t.state !== 'run' && t.state !== 'probe') return;
    t.state = 'pause';
    abortInflight(t);
    renderAll();
    pump();
  }

  function resumeTask(t) {
    if (t.state !== 'pause') return;
    t.state = t.queue.length || t.got < t.size ? 'run' : 'done';
    if (t.state === 'run') pump();
    renderAll();
  }

  /* ------------------------------------------------- 历史：已结束 / 已推送
   * 语义收敛成一条规则：任务要么在活跃列表里，要么不在。
   * 「取消」「完成」「推送成功」都把任务从活跃列表摘掉（进度环复原、悬停卡片消失），
   * 同时在下面这两个桶里留一条记录——只有面板的 tab 才看得到它们。
   * end 桶 = 已结束（取消 + 完成），条目用 st 区分：'cancel' | 'done'。 */
  var HIST = { end: [], push: [] };
  var HIST_MAX = 60, HIST_ID = 0;

  function loadHist() {
    try {
      var v = GM_getValue('bpd_hist');
      if (v && typeof v === 'object') {
        /* 老数据在 cancel 桶里 → 迁到 end；老条目没有 st，一律当「已取消」 */
        var oldEnd = Array.isArray(v.end) ? v.end : (Array.isArray(v.cancel) ? v.cancel : []);
        HIST.end = oldEnd.map(function (h) { if (h && !h.st) h.st = 'cancel'; return h; });
        HIST.push = Array.isArray(v.push) ? v.push : [];
      }
    } catch (e) { /* noop */ }
    HIST.end.concat(HIST.push).forEach(function (h) {
      HIST_ID = Math.max(HIST_ID, +(h && h.hid) || 0);
    });
  }

  function saveHist() {
    try { GM_setValue('bpd_hist', { end: HIST.end, push: HIST.push }); } catch (e) { /* noop */ }
  }

  function histAdd(kind, it, st) {
    if (!HIST[kind]) return;
    HIST[kind].unshift({
      hid: ++HIST_ID, fsid: String((it && it.fsid) || ''),
      name: (it && it.name) || ('fs_id ' + (it && it.fsid)), size: (it && it.size) || 0,
      at: Date.now(), st: st || ''
    });
    if (HIST[kind].length > HIST_MAX) HIST[kind].length = HIST_MAX;
    saveHist();
  }

  function histDel(kind, hid) {
    if (!HIST[kind]) return;
    HIST[kind] = HIST[kind].filter(function (h) { return +h.hid !== +hid; });
    saveHist();
    renderAll();
  }

  function histClear(kind) {
    if (!HIST[kind] || !HIST[kind].length) return;
    var n = HIST[kind].length;
    HIST[kind] = [];
    saveHist();
    renderAll();
    tip('已清空 ' + n + ' 条记录');
  }

  /* 从活跃列表摘掉（取消、推送成功共用）：行内环、悬停卡片、勾选、列表一处不落 */
  function dropTask(t) {
    var i = TASKS.indexOf(t);
    if (i >= 0) TASKS.splice(i, 1);
    delete SEL[t.id];
    if (cardTask && String(cardTask.id) === String(t.id)) hideCard();
    unmountRing(t);
  }

  function cancelTask(t) {
    t.state = 'cancel';
    abortInflight(t);
    /* 转存出来的副本一律不删（见 sharePush 上方的说明） */
    t.parts = null;
    t.queue = [];
    histAdd('end', t, 'cancel');
    dropTask(t);
    pump();
    renderAll();
  }

  /* ✕：直接丢掉，不记历史（收尾清理动作用） */
  function removeTask(t) {
    if (t.state !== 'cancel') {
      t.state = 'cancel';
      abortInflight(t);
      t.parts = null;
      t.queue = [];
      unmountRing(t);
    }
    dropTask(t);
    pump();
    renderAll();
  }

  function failTask(t, e) {
    if (t.state === 'cancel' || t.state === 'done') return;
    t.state = 'err';
    t.err = (e && e.message) || '失败';
    t.endAt = Date.now();
    tip('直链下载失败：' + t.err);
    unmountRing(t);
    renderAll();
  }

  function completeTask(t) {
    t.state = 'done';
    t.endAt = Date.now();
    var blob = new Blob(t.parts, { type: 'application/octet-stream' });
    t.parts.length = 0;
    t.parts = null;
    saveBlob(blob, t.name);
    tip('已保存 ' + t.name + '（' + mb(blob.size) + '）');
    /* 完成即离场：进「已结束」，不再占着「进行中」 */
    histAdd('end', t, 'done');
    dropTask(t);
    renderAll();
    pump();
  }

  function saveBlob(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name || 'download.bin';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 60000);
  }

  /* ==================================================================== 样式 */
  var cssDone = false;
  var FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';
  function injectCss() {
    if (cssDone || !document.head) return;
    cssDone = true;
    var s = document.createElement('style');
    s.id = 'bpd-style';
    s.textContent = [
      /* 图标上的进度环 */
      '.bpd-ring{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;',
      'pointer-events:none;z-index:3}',
      '.bpd-ring svg{width:22px;height:22px;transform:rotate(-90deg);overflow:visible}',
      '.bpd-ring circle{fill:none;stroke-width:2.4;cx:12;cy:12;r:10}',
      '.bpd-ring .bg{stroke:#dde3ea}',
      '.bpd-ring .fg{stroke:#06a7ff;stroke-linecap:round;stroke-dasharray:62.83;stroke-dashoffset:62.83;',
      'transition:stroke-dashoffset .35s ease}',
      '.bpd-ring.is-pause .fg{stroke:#9aa4b1}',
      '.bpd-ring.is-err .fg{stroke:#e2483d}',
      '.bpd-ring.is-done .fg{stroke:#12a45a}',
      /* 悬停浮条：只有一排图标，不再是一张卡片。
         卡片那种「弹窗里再盖一层弹窗」在面板上尤其难看（面板自己就是个浮窗）。 */
      '.bpd-strip{position:fixed;z-index:2147483647;display:none;align-items:center;gap:2px;padding:3px;',
      'background:rgba(255,255,255,.99);border-radius:9px;',
      'box-shadow:0 6px 18px rgba(3,8,26,.16),0 0 0 1px rgba(3,8,26,.08)}',
      '.bpd-strip button{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;',
      'padding:0;border:0;border-radius:6px;background:transparent;color:#566278;cursor:pointer}',
      '.bpd-strip button:hover{background:#f1f3f8;color:#03081a}',
      '.bpd-strip button[data-op="toggle"]:hover{background:#eaf7ff;color:#06a7ff}',
      '.bpd-strip button[data-op="cancel"]:hover{background:#fdf1f0;color:#e2483d}',
      '.bpd-strip button svg{width:15px;height:15px;display:block}',
      '.bpd-strip button .u-icon{font-size:16px;line-height:16px;display:inline-block;margin:-1px 0 0}',
      '.bpd-strip button:disabled{opacity:.38;cursor:default}',
      '.bpd-strip button:disabled:hover{background:transparent;color:#566278}',
      '.bpd-bar{height:8px;border-radius:4px;background:#edf0f4;overflow:hidden}',
      '.bpd-bar>i{display:block;height:100%;width:0;border-radius:3px;',
      'background:linear-gradient(90deg,#06a7ff,#54c4ff);transition:width .3s ease}',
      '.bpd-bar.is-pause>i{background:linear-gradient(90deg,#a7b1bd,#c3cbd5)}',
      '.bpd-bar.is-done>i{background:linear-gradient(90deg,#12a45a,#45c98a)}',
      '.bpd-bar.is-err>i{background:linear-gradient(90deg,#e2483d,#f0796f)}',
      '.bpd-stats{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:8px;',
      'color:#495366;font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden}',
      '.bpd-stats b{color:#03081a;font-weight:600}',
      '.bpd-ops{display:flex;gap:6px;margin-top:11px}',
      '.bpd-btn{flex:1;height:29px;padding:0 8px;border-radius:7px;border:1px solid #e3e7ee;background:#fff;',
      'color:#566278;font:500 12px/1 ' + FONT + ';cursor:pointer;transition:background .15s,border-color .15s}',
      '.bpd-btn:hover{background:#f7fafd;border-color:#d4d9e2}',
      '.bpd-btn.primary{background:#06a7ff;border-color:#06a7ff;color:#fff}',
      '.bpd-btn.primary:hover{background:#009ef2;border-color:#009ef2}',
      '.bpd-btn.danger{color:#e2483d;border-color:#f0d7d4}',
      '.bpd-btn.danger:hover{background:#fdf4f3}',
      /* 右下角任务面板：收起时整块朝右下角缩进去，跟小圆钮无缝接上 */
      '.bpd-panel{position:fixed;right:16px;bottom:16px;width:336px;z-index:2147483645;',
      'background:rgba(255,255,255,.99);border-radius:12px;overflow:hidden;color:#03081a;',
      'box-shadow:0 12px 34px rgba(31,35,41,.18),0 0 0 1px rgba(31,35,41,.07);font:13px/1.5 ' + FONT + ';',
      'transform-origin:100% 100%;opacity:1;transform:none;',
      'transition:opacity .18s ease-in,transform .22s cubic-bezier(.22,.8,.28,1),visibility 0s linear}',
      '.bpd-panel.is-hide{opacity:0;transform:scale(.34);pointer-events:none;visibility:hidden;',
      'transition:opacity .18s ease-in,transform .22s cubic-bezier(.22,.8,.28,1),visibility 0s linear .22s}',
      '.bpd-panel__hd{display:flex;align-items:center;gap:2px;padding:7px 8px 7px 12px;background:#fff;',
      'border-bottom:1px solid #f1f3f8;font-size:13px;color:#566278;user-select:none;white-space:nowrap}',
      '.bpd-panel__hd b{font-size:13px;font-weight:500;color:#03081a;white-space:nowrap;flex:none}',
      '.bpd-panel__hd .cnt{font-size:12px;color:#a2abbd}',
      '.bpd-panel__hd .sp{flex:1}',
      '.bpd-panel__hd button{display:inline-flex;align-items:center;justify-content:center;width:27px;height:27px;',
      'padding:0;border:0;background:transparent;color:#86909c;cursor:pointer;border-radius:6px;flex:none;',
      'transition:background .15s,color .15s}',
      '.bpd-panel__hd button:hover{background:#f1f3f8;color:#03081a}',
      '.bpd-panel__hd button svg{width:17px;height:17px;display:block}',
      '.bpd-task{display:flex;flex-wrap:wrap;align-items:center;gap:0 8px;padding:9px 12px;',
      'border-bottom:1px solid #f1f3f8;cursor:pointer}',
      '.bpd-task:last-child{border-bottom:0}',
      '.bpd-task:hover{background:#f7fafd}',
      '.bpd-task.is-sel{background:#eef8ff}',
      '.bpd-task__ck{position:relative;display:inline-flex;flex:none;width:15px;height:15px}',
      '.bpd-task__ck input{appearance:none;-webkit-appearance:none;box-sizing:border-box;width:15px;height:15px;',
      'margin:0;padding:0;border:1px solid #d4d9e2;border-radius:3px;background:#fff;cursor:pointer;',
      'transition:background .15s,border-color .15s}',
      '.bpd-task__ck input:hover{border-color:#06a7ff}',
      '.bpd-task__ck input:checked{background:#06a7ff;border-color:#06a7ff}',
      '.bpd-task__ck svg{position:absolute;left:1px;top:1px;width:13px;height:13px;pointer-events:none;',
      'opacity:0;transition:opacity .12s}',
      '.bpd-task__ck input:checked~svg{opacity:1}',
      '.bpd-task__nm{flex:1;min-width:0;display:flex;align-items:baseline;gap:8px;font-size:12px}',
      '.bpd-task__nm i{flex:1;font-style:normal;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
      'color:#03081a}',
      '.bpd-task__nm span{color:#495366;font-variant-numeric:tabular-nums;flex:none}',
      /* 名字过长时 hover 整行走马灯：内层 <b> 平移，外层裁切 */
      '.bpd-task__nm i>b,.bpd-hist__nm>b{display:inline-block;white-space:nowrap;font-weight:400;will-change:transform}',
      '.bpd-task__nm i.is-mq,.bpd-hist__nm.is-mq{text-overflow:clip}',
      /* 内联块子元素吃不到 text-overflow:ellipsis，溢出时用 12px 右侧渐隐代替省略号 */
      '.bpd-task__nm i.is-cut,.bpd-hist__nm.is-cut{-webkit-mask-image:linear-gradient(90deg,#000 calc(100% - 12px),transparent 100%);',
      'mask-image:linear-gradient(90deg,#000 calc(100% - 12px),transparent 100%)}',
      '.bpd-task__nm i.is-mq,.bpd-hist__nm.is-mq{-webkit-mask-image:none;mask-image:none}',
      '.is-mq>b{animation:bpd-mq var(--mq-dur,3.2s) linear infinite alternate}',
      '@keyframes bpd-mq{0%,9%{transform:translateX(0)}91%,100%{transform:translateX(var(--mq-dist,0px))}}',
      '.bpd-task .bpd-bar{flex:0 0 100%;margin-top:6px;height:6px}',
      '.bpd-task__x{flex:none;border:0;background:transparent;color:#a2abbd;font-size:13px;line-height:1;',
      'cursor:pointer;padding:2px 3px;border-radius:4px}',
      '.bpd-task__x:hover{background:#f1f3f8;color:#566278}',
      /* 面板 tab：进行中 / 已取消 / 已推送 */
      '.bpd-tabs{display:flex;gap:2px;padding:0 12px;background:#fff;border-bottom:1px solid #f1f3f8}',
      '.bpd-tabs button{flex:1;height:31px;padding:0 2px;border:0;border-bottom:2px solid transparent;',
      'background:transparent;color:#495366;font:500 12px/1 ' + FONT + ';cursor:pointer;white-space:nowrap}',
      '.bpd-tabs button:hover{color:#03081a}',
      '.bpd-tabs button b{margin-left:4px;font-weight:500;color:#a2abbd;font-variant-numeric:tabular-nums}',
      '.bpd-tabs button.is-on{color:#06a7ff;border-bottom-color:#06a7ff}',
      '.bpd-tabs button.is-on b{color:#06a7ff}',
      /* 历史行（已取消 / 已推送）：只有名字、大小时间、✕ */
      '.bpd-hist{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #f1f3f8;',
      'font:12px/1.4 ' + FONT + '}',
      '.bpd-hist:last-child{border-bottom:0}',
      '.bpd-hist__nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#495366}',
      '.bpd-hist__mt{flex:none;color:#a2abbd;font-variant-numeric:tabular-nums}',
      '.bpd-hist__x{flex:none;border:0;background:transparent;color:#a2abbd;font-size:12px;line-height:1;',
      'cursor:pointer;padding:2px 3px;border-radius:4px}',
      '.bpd-hist__x:hover{background:#f1f3f8;color:#566278}',
      /* 行内 / 批量「推送」按钮：跟原生 H 工具条一样，平时 0 宽，行 hover 才展开 */
      /* 推送按钮：只补图形尺寸，外壳/间距/颜色一律沿用百度的类，
         不然它在一排原生图标里就会像颗外来钉（对比、重复、对齐、亲密性全丢） */
      /* 别写成 display:block——那一排的行高是 50px，块级子元素会把按钮压成 16px 高 */
      /* 别在这里写 stroke-width：分享页的图标是 16 网格 1.13333 的细笔画（native 同族），
         这里若写 1.9 会盖掉 svg 自己的属性，画出来比旁边两颗粗一倍。 */
      '.bpd-send svg{width:16px;height:16px;display:block}',
      /* 字图版图标：跟原生 <i class="u-icon-download"> 一样 inline-block + 基线对齐，
         原生就是靠它在 16px 方框里按字体基线摆正字形，我们照抄 */
      /* 只补 16px 与 -2px 上移：图标↔文字的 6px 间距原生 .u-button i 已经给了，
         这里再给一次就变成 12px，按钮宽 82 而不是 76 */
      '.bpd-send>.u-icon{font-size:16px;line-height:16px;display:inline-block;vertical-align:baseline;margin-top:-2px}',
      /* 只有图标的行内按钮：原生那颗 <i> 身边有空白文本节点，行盒里有个 14px 的字面 strut，
         而我们的按钮里只有 <i> + display:none 的 span，没有 strut，基线就差了 0.6px
         （实测原生 icon top 529.9 / 我们 530.5）。这里按实测值补回来。 */
      '.bpd-send:not(.bpd-send--bulk)>.u-icon{top:1.4px}',
      '.bpd-send[data-bpd="push"]{cursor:pointer}',
      '.bpd-send.bpd-send--bulk{margin-left:0}',
      /* 桌面批量按钮的图标壳：跟分享页药丸借的 .share-list-toolbar__icon 同一个思路 */
      /* 图标要对齐原生那颗 <i class="u-icon-download">：它是 font-size:16 的字图，
         字形基线在 16px 方框里偏下（原生用 margin-top:-2px 把它抬回来）。
         我们是一个 16px 的 flex 盒子，按同样的 margin:-2px + vertical-align:middle 排出来，
         文字正好落在原生位置（88.1），图标方框顶却比原生高 0.8px。
         实测四个候选值：0.4→88.0 / 0.6→88.2 / 0.8→88.4 / 1.0→88.6，
         0.8 与原生 88.4 完全一致；用 relative 位移不影响行盒，所以右边文字不动。 */
      '.bpd-send__ic{display:inline-block;line-height:16px;vertical-align:baseline;margin:-2px 6px 0 0}',
      '.bpd-send__ic .u-icon{font-size:16px;line-height:16px;display:inline-block;margin:0}',
      '.bpd-send__ic svg{display:block;width:16px;height:16px}',
      /* 药丸里「图标↔文字」的 4px 间距：原生靠 .share-list-toolbar__icon 给，
         这里再兜一层，网页改类名也不会挤在一起 */
      '.bpd-send--bulk .wp-svg-icon{display:flex;align-items:center;justify-content:center;margin-right:4px}',
      /* 只在「进行中」tab 显示的批量按钮 / 只在历史 tab 显示的清空 */
      '.bpd-panel__tools [data-op=hclear]{display:none}',
      '.bpd-panel.is-hist [data-op=hclear]{display:block;flex:1}',
      '.bpd-panel.is-hist [data-op=selall],.bpd-panel.is-hist [data-op=btoggle],',
      '.bpd-panel.is-hist [data-op=bcancel],.bpd-panel.is-hist [data-op=blink],',
      '.bpd-panel.is-hist [data-op=bpush]{display:none}',
      /* 面板批量工具条 */
      '.bpd-panel__tools{display:flex;gap:6px;padding:8px 12px;border-bottom:1px solid #f1f3f8;background:#fbfcfe}',
      '.bpd-panel__tools button{flex:1;height:26px;padding:0 2px;border-radius:6px;border:1px solid #e6eaf1;',
      'background:#fff;color:#566278;font:500 12px/1 ' + FONT + ';cursor:pointer;white-space:nowrap}',
      '.bpd-panel__tools button:hover{background:#f7fafd;border-color:#d4d9e2}',
      '.bpd-panel__tools button:disabled{opacity:.45;cursor:default}',
      '.bpd-panel__empty{padding:16px 12px;color:#a2abbd;font-size:12px;text-align:center}',
      /* 设置弹窗：按网盘的设计语言来（主色 #06a7ff、灰底输入 #f1f3f8、药丸按钮、16px 方角勾选框） */
      '.bpd-mask{position:fixed;inset:0;z-index:2147483647;background:rgba(3,8,26,.42);',
      'display:flex;align-items:center;justify-content:center}',
      '.bpd-cfg{width:560px;max-width:calc(100vw - 24px);max-height:94vh;display:flex;flex-direction:column;',
      'background:#fff;border-radius:12px;box-sizing:border-box;overflow:hidden;',
      'box-shadow:0 16px 44px rgba(3,8,26,.22);font:14px/1.5 ' + FONT + ';color:#333}',
      '.bpd-cfg__hd{display:flex;align-items:center;gap:8px;padding:16px 20px 12px;',
      'font-size:16px;font-weight:500;color:#03081a}',
      '.bpd-cfg__hd .sp{flex:1}',
      '.bpd-cfg__x{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;',
      'margin-right:-8px;padding:0;border:0;background:transparent;color:#86909c;cursor:pointer;border-radius:6px}',
      '.bpd-cfg__x:hover{background:#f1f3f8;color:#03081a}',
      '.bpd-cfg__x svg{width:16px;height:16px;display:block}',
      '.bpd-cfg__body{overflow-y:auto;overflow-x:hidden;padding:0 20px 6px}',
      /* 设置项一律「左边标题+副标题 / 右边控件」的列表行：标题左对齐成一列，
         控件右对齐成一列，开关放最右——比「标签|控件 / 说明缩进到控件下」整齐得多 */
      '.bpd-cfg__grp{padding:10px 0 2px;margin-top:4px;border-top:1px solid #f1f3f8;',
      'font-size:12px;color:#a2abbd;line-height:18px}',
      '.bpd-cfg__grp:first-child{margin-top:0;padding-top:0;border-top:0}',
      '.bpd-cfg__row{display:flex;align-items:center;gap:16px;min-height:40px;padding:2px 0;',
      'cursor:default}',
      '.bpd-cfg__row .k{flex:1;min-width:0;display:flex;flex-direction:column;cursor:pointer}',
      '.bpd-cfg__row .k b{font-weight:400;font-size:13px;line-height:19px;color:#03081a}',
      '.bpd-cfg__row .k i{font-style:normal;font-size:12px;line-height:16px;color:#a2abbd;',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.bpd-cfg__row .c{flex:0 0 auto;display:flex;align-items:center}',
      /* 开关 */
      '.bpd-cfg input[type=text]{width:264px;height:32px;padding:0 10px;border:1px solid #f1f3f8;border-radius:8px;',
      'box-sizing:border-box;background:#f1f3f8;font:13px/1 ' + FONT + ';color:#03081a}',
      '.bpd-cfg input[type=number]{width:88px;height:32px;padding:0 10px;border:1px solid #f1f3f8;',
      'border-radius:8px;box-sizing:border-box;background:#f1f3f8;font:13px/1 ' + FONT + ';',
      'color:#03081a;-moz-appearance:textfield}',
      '.bpd-cfg input[type=number]::-webkit-inner-spin-button,',
      '.bpd-cfg input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}',
      '.bpd-sl{position:relative;display:inline-flex;align-items:center}',
      '.bpd-sl::after{content:"";position:absolute;right:11px;top:50%;width:6px;height:6px;',
      'border-right:1.5px solid #86909c;border-bottom:1.5px solid #86909c;',
      'transform:translateY(-70%) rotate(45deg);pointer-events:none}',
      '.bpd-cfg select{width:128px;height:32px;padding:0 28px 0 10px;border:1px solid #f1f3f8;border-radius:8px;',
      'box-sizing:border-box;background:#f1f3f8;font:13px/1 ' + FONT + ';color:#03081a;cursor:pointer;',
      'appearance:none;-webkit-appearance:none}',
      /* 只给文本框/数字框/下拉框做 hover/focus 变色，别的控件不受影响 */
      '.bpd-cfg input[type=text]:hover,.bpd-cfg input[type=number]:hover,.bpd-cfg select:hover{',
      'background:#eaeef5;border-color:#eaeef5}',
      '.bpd-cfg input[type=text]:focus,.bpd-cfg input[type=number]:focus,.bpd-cfg select:focus{',
      'outline:0;background:#fff;border-color:#06a7ff}',
      '.bpd-cfg__stat{padding:8px 20px;font-size:12px;color:#86909c;border-top:1px solid #f1f3f8;',
      'background:#fafbfc;display:none}',
      '.bpd-cfg__stat.on{display:block}',
      '.bpd-cfg__stat.ok{color:#12a45a}',
      '.bpd-cfg__stat.bad{color:#e2483d}',
      '.bpd-cfg__ft{display:flex;align-items:center;gap:8px;padding:12px 20px 16px;border-top:1px solid #f1f3f8}',
      '.bpd-cfg__ft .sp{flex:1}',
      '.bpd-cfg__ft .bpd-btn{flex:none;min-width:78px;height:32px;border-radius:16px;border:1px solid transparent;',
      'background:#f1f3f8;color:#566278;font:400 13px/1 ' + FONT + '}',
      '.bpd-cfg__ft .bpd-btn:hover{background:#eaeef5;border-color:transparent}',
      '.bpd-cfg__ft .bpd-btn.primary{background:#06a7ff;color:#fff}',
      '.bpd-cfg__ft .bpd-btn.primary:hover{background:#009ef2;border-color:transparent}',
      '.bpd-cfg__ft .bpd-btn.ghost{background:transparent;border-color:#cfeaff;color:#06a7ff}',
      '.bpd-cfg__ft .bpd-btn.ghost:hover{background:#f2f9ff;border-color:#a9d9ff}',
      /* 收起后右下角的小圆钮：点它把面板放回来。面板缩小时它就在同一个位置长出来，
         所以看着像「面板变成了球」，而不是「面板消失 + 不知道哪冒出来一个球」。 */
      '.bpd-fab{position:fixed;right:16px;bottom:16px;z-index:2147483644;width:40px;height:40px;',
      'display:flex;align-items:center;justify-content:center;border-radius:50%;border:1px solid #e6eaf1;',
      'background:#fff;box-shadow:0 4px 14px rgba(3,8,26,.14);cursor:pointer;color:#06a7ff;',
      'opacity:0;transform:scale(.55);pointer-events:none;',
      'transition:opacity .16s ease,transform .22s cubic-bezier(.22,.8,.28,1),box-shadow .16s}',
      '.bpd-fab.on{opacity:1;transform:none;pointer-events:auto;transition-delay:.1s,.1s,0s}',
      '.bpd-fab.on:hover{box-shadow:0 6px 18px rgba(3,8,26,.2);transform:translateY(-1px);transition-delay:0s}',
      '.bpd-fab svg{width:20px;height:20px;display:block}',
      /* 收起来以后任务还在跑：球外面呼吸一圈，点开才知道在动 */
      '.bpd-fab.is-run::before{content:"";position:absolute;inset:-3px;border-radius:50%;',
      'border:2px solid #06a7ff;opacity:.3;animation:bpd-pulse 1.6s ease-out infinite}',
      '@keyframes bpd-pulse{0%{transform:scale(.86);opacity:.32}70%{transform:scale(1.16);opacity:0}',
      '100%{transform:scale(1.16);opacity:0}}',
      /* 顶部提示 */
      '.bpd-tip{position:fixed;z-index:2147483647;left:50%;bottom:46px;transform:translateX(-50%);',
      'background:rgba(0,0,0,.85);color:#fff;border-radius:6px;padding:8px 14px;font:13px/1.5 ' + FONT + ';',
      'box-shadow:0 8px 24px rgba(0,0,0,.2);max-width:70vw}'
    ].join('');
    document.head.appendChild(s);
  }

  var tipTimer = null;
  function tip(text) {
    injectCss();
    var el = document.getElementById('bpd-tip');
    if (!el) {
      el = document.createElement('div');
      el.id = 'bpd-tip';
      el.className = 'bpd-tip';
      document.body.appendChild(el);
    }
    el.textContent = text;
    clearTimeout(tipTimer);
    tipTimer = setTimeout(function () { el.remove(); }, 4200);
  }

  /* ------------------------------------------------------- 图标上的进度环（零位移） */
  function mountRing(t) {
    var btn = t.btn;
    if (!btn) return;
    unmountRing(t);
    var icon = btn.querySelector('i') || btn.querySelector('svg');
    if (icon) { icon.style.visibility = 'hidden'; t.icon = icon; }
    if (getComputedStyle(btn).position === 'static') btn.style.position = 'relative';
    var ring = document.createElement('span');
    ring.className = 'bpd-ring';
    ring.innerHTML = '<svg viewBox="0 0 24 24"><circle class="bg"></circle><circle class="fg"></circle></svg>';
    btn.appendChild(ring);
    t.ring = ring;
  }

  function unmountRing(t) {
    if (t.ring) { t.ring.remove(); t.ring = null; }
    if (t.icon) { t.icon.style.visibility = ''; t.icon = null; }
  }

  /* 页面会整行重渲染（React 换掉 <tr>），旧 btn 变游离节点 -> 环和悬停都丢。
     每次重绘都先自查一次：btn 不在了就按 fs_id 重新找回行里的下载按钮并重挂。 */
  function ensureRing(t) {
    if (t.ring && t.ring.isConnected) return true;
    var btn = t.btn;
    if (!btn || !btn.isConnected) {
      var row = document.querySelector('[data-id="' + t.fsid + '"],[data-file-key="' + t.fsid + '"]');
      if (!row) return false;
      var cands = row.querySelectorAll('button[title="下载"],button[aria-label="下载"],.bottom_download_btn,.share-list-toolbar__pill-btn');
      btn = cands[0] || row.querySelector('button');
      if (!btn) return false;
      t.btn = btn;
      bindHover(btn, t);
    }
    unmountRing(t);
    mountRing(t);
    return !!t.ring;
  }

  function paintRing(t) {
    if (t.state !== 'done' && t.state !== 'cancel') ensureRing(t);
    if (!t.ring) return;
    var pct = t.size ? t.got / t.size : 0;
    var circ = 62.83;
    var fg = t.ring.querySelector('.fg');
    if (fg) fg.style.strokeDashoffset = (circ * (1 - Math.max(0, Math.min(1, pct)))).toFixed(2);
    t.ring.className = 'bpd-ring' + (t.state === 'pause' ? ' is-pause' : t.state === 'err' ? ' is-err'
      : t.state === 'done' ? ' is-done' : '');
  }

  /* ------------------------------------------------------------------ 悬停浮条
     一排图标：暂停/继续、取消、复制链接、推送。鼠标停在文件名旁的进度环上，
     或停在右下角面板里某条任务的进度条上，都浮出这一条。
     不再用卡片：卡片有标题、进度、两行数字，等于在「浮窗上面再盖一个浮窗」，
     面板自己就是右下角的浮窗，叠起来就是用户说的「套娃」。 */
  var cardEl = null, cardTask = null, hideTimer = null, cardAnchorEl = null;

  function cardsFor(t) { return String(t.id); }

  /* 别手画了：整站 209 个图标全是字体图标 union-design-icons（<i class="u-icon-x">），
     16px 方框、1.5 的笔画、圆头圆角，字形都按同一套网格刻。手绘 SVG 无论怎么调
     stroke-width / viewBox，笔画角度、圆角、光学尺寸都跟别人不同族，一排图标里立刻显形。
     所以直接借字体里语义最近的字形 transfer（⇄ 传输/转移）——同字体、同笔画、同基线，
     颜色随 color 自动跟随（行内蓝、分享页深色、浮条深灰都对）。 */
  var PLANE_SVG = '<i class="u-icon u-icon-transfer" aria-hidden="true"></i>';

  /* 分享页（/s/…）是另一套图标体系：SVG sprite（<svg><use href="#wp-icon-download">），
     全部 16 网格、stroke 1.13333、圆头圆角，页面根本没加载 union-design-icons
     （实测那颗 <i> 的 ::before content 是 none，宽度 0，直接隐形）。
     所以分享页按它们的规范手画一个同样的 ⇄：16 网格、1.13333 笔画、圆头。 */
  var SHARE_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.13333"'
    + ' stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M13.1 5H2.9"/><path d="M4.9 3 2.9 5l2 2"/>'
    + '<path d="M2.9 10h10.2"/><path d="M11.1 8l2 2-2 2"/></svg>';

  function isSharePage() { return /^\/s\//.test(location.pathname); }

  /* 浮条是我们自己的，但图标也全部改借页面字体：四个键互相之间、以及和页面上那些
     图标之间才是同一套笔画。自绘 SVG 和字体混在一颗按钮里，粗细和圆角一眼能分辨。 */
  function glyph(n) { return '<i class="u-icon u-icon-' + n + '" aria-hidden="true"></i>'; }
  var STRIP_ICON_FONT = {
    pause: glyph('pause'),
    play: glyph('play'),
    cancel: glyph('close'),
    link: glyph('link'),
    send: PLANE_SVG
  };
  /* 分享页没有图标字体，浮条退回自绘（这四个彼此同族，放在我们自己那块浮条里不违和） */
  var STRIP_ICON_SVG = {
    pause: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">'
      + '<path d="M9.5 5.2v13.6M14.5 5.2v13.6"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8.6 5.1v13.8L19 12z"/></svg>',
    cancel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">'
      + '<path d="M6.6 6.6l10.8 10.8M17.4 6.6L6.6 17.4"/></svg>',
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"'
      + ' stroke-linejoin="round"><path d="M10.3 13.7a4.1 4.1 0 0 0 5.8 0l2.4-2.4a4.1 4.1 0 0 0-5.8-5.8l-1.4 1.4"/>'
      + '<path d="M13.7 10.3a4.1 4.1 0 0 0-5.8 0l-2.4 2.4a4.1 4.1 0 0 0 5.8 5.8l1.4-1.4"/></svg>',
    send: SHARE_ICON
  };
  var STRIP_ICON = isSharePage() ? STRIP_ICON_SVG : STRIP_ICON_FONT;

  function buildStrip() {
    var el = document.createElement('div');
    el.className = 'bpd-strip';
    el.setAttribute('role', 'toolbar');
    el.innerHTML = ['toggle', 'cancel', 'link', 'push'].map(function (op) {
      return '<button type="button" data-op="' + op + '"></button>';
    }).join('');
    el.addEventListener('mouseenter', function () { clearTimeout(hideTimer); });
    el.addEventListener('mouseleave', scheduleHideCard);
    el.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button[data-op]') : null;
      if (!b || !cardTask) return;
      e.preventDefault();
      e.stopPropagation();
      act(cardTask, b.getAttribute('data-op'), e);
    });
    return el;
  }

  /* 浮条该出现在哪：锚点由调用方给（面板里是进度条、行里是下载图标），
     没给才退回进度环 / 原生按钮，全都没有再拿整行兜底。 */
  function placeCard(t, el) {
    if (!cardEl) return;
    var r = el && el.getBoundingClientRect ? el.getBoundingClientRect()
      : { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
    if (!r.width && !r.height && el && el.closest) {
      var host = el.closest('tr') || el.closest('[data-file-key]') || el.closest('.bpd-task');
      if (host) r = host.getBoundingClientRect();
    }
    var inPanel = !!(el && el.closest && el.closest('.bpd-panel'));
    var w = cardEl.offsetWidth || 124, h = cardEl.offsetHeight || 32;
    var left, top;
    if (inPanel) {
      /* 面板贴在右下角、里面本来就排满了按钮：浮条放到面板左边外侧，
         既不盖住面板自己的工具条，也不会像以前那样再叠一层「套娃弹窗」。 */
      var pr = el.closest('.bpd-panel').getBoundingClientRect();
      left = pr.left - w - 8;
      if (left < 8) left = 8;
      /* 锚点若是一整行，就用行高（含上下 padding）的中点，浮条与条目居中对齐 */
      top = r.top + r.height / 2 - h / 2;
    } else {
      /* 行内图标右边就是「手机看 / 更多」，横着放会盖住它们，
         所以统一往上放（等同于贴着这个图标弹一层），上面没地方就往下。 */
      left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
      top = r.top - h - 6;
      if (top < 8) top = r.bottom + 6;
    }
    top = Math.min(Math.max(8, top), window.innerHeight - h - 8);
    cardEl.style.left = Math.round(left) + 'px';
    cardEl.style.top = Math.round(top) + 'px';
  }

  function showCard(t, anchor) {
    if (!document.body || !t || !byId(t.id)) return;
    injectCss();
    clearTimeout(hideTimer);
    if (!cardEl) { cardEl = buildStrip(); document.body.appendChild(cardEl); }
    cardTask = t;
    cardEl.setAttribute('data-tid', cardsFor(t));
    cardEl.style.display = 'block';
    cardAnchorEl = (anchor && anchor.isConnected) ? anchor
      : ((t.ring && t.ring.isConnected) ? t.ring : t.btn);
    updateCard();
    placeCard(t, cardAnchorEl);
  }

  /* 指针还在浮条里、或还压在面板进度条上，就别收：面板每隔几百毫秒重画一次行，
     重画会让 mouseleave 误触发，不收的条件用 :hover 现场复核比记状态可靠。 */
  function stillOnCard() {
    if (cardEl && cardEl.matches && cardEl.matches(':hover')) return true;
    return !!document.querySelector('.bpd-panel .bpd-task:hover');
  }

  function scheduleHideCard() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function () { if (!stillOnCard()) hideCard(); }, 260);
  }

  function hideCard() {
    if (cardEl) cardEl.style.display = 'none';
    cardTask = null;
    cardAnchorEl = null;
  }

  function updateCard() {
    if (!cardEl || !cardTask || cardEl.style.display === 'none') return;
    var t = cardTask;
    var over = (t.state === 'done' || t.state === 'err' || t.state === 'cancel');
    var tg = cardEl.querySelector('[data-op="toggle"]');
    if (tg) {
      tg.innerHTML = t.state === 'pause' ? STRIP_ICON.play : STRIP_ICON.pause;
      tg.title = over ? '已结束' : (t.state === 'pause' ? '继续' : '暂停');
      tg.disabled = over;
    }
    var cx = cardEl.querySelector('[data-op="cancel"]');
    if (cx) {
      cx.innerHTML = STRIP_ICON.cancel;
      cx.title = over ? '从列表移除' : '取消（任务直接消失）';
    }
    var lk = cardEl.querySelector('[data-op="link"]');
    if (lk) {
      lk.innerHTML = STRIP_ICON.link;
      lk.title = !t.url ? '还在取直链，稍等'
        : (DAEMON_OK === false ? '复制 curl 分块命令（4 路并行，粘到终端跑）'
          : '复制下载链接（粘到浏览器/下载器；⌥ = aria2c 命令）');
      lk.disabled = !t.url;
    }
    var ps = cardEl.querySelector('[data-op="push"]');
    if (ps) { ps.innerHTML = STRIP_ICON.send; ps.title = '推送到 aria2'; }
    /* 面板贴在右下角、高度跟着任务数变，里面的行会整体上下挪。
       浮条只在弹出时定位一次的话，任务增减后就会悬在半空，所以每帧跟着锚点走。 */
    if (cardAnchorEl && !cardAnchorEl.isConnected) {
      cardAnchorEl = (t.ring && t.ring.isConnected) ? t.ring : t.btn;
    }
    if (cardAnchorEl) placeCard(t, cardAnchorEl);
  }

  /* ------------------------------------------------------------------ 设置面板 */
  var cfgEl = null;

  /* 设置列表行：左「标题 + 副标题」，右控件 */
  /* 说明默认只在 hover 时以 title 浮出（第四参数 true），只有真正容易踩坑的几行才常驻显示 */
  function row(title, hint, control, hoverOnly) {
    var inline = hint && !hoverOnly;
    return '<label class="bpd-cfg__row"' + (hint && hoverOnly ? ' title="' + hint + '"' : '') + '>'
      + '<span class="k"><b>' + title + '</b>' + (inline ? '<i>' + hint + '</i>' : '') + '</span>'
      + '<span class="c">' + control + '</span></label>';
  }
  function txt(name, ph) {
    return '<input name="' + name + '" type="text" spellcheck="false" placeholder="' + ph + '">';
  }
  function num(name, min, max) {
    return '<input name="' + name + '" type="number" min="' + min + '" max="' + max + '" step="1">';
  }
  function sel(name, pairs) {
    return '<span class="bpd-sl"><select name="' + name + '">' + pairs.map(function (p) {
      return '<option value="' + p[0] + '">' + p[1] + '</option>';
    }).join('') + '</select></span>';
  }
  var CHECK_SVG = '<svg viewBox="0 0 16 16"><path d="M3.6 8.4 6.4 11.2 12.4 5.2" fill="none" '
    + 'stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function cfgHtml() {
    return [
      '<div class="bpd-cfg">',
      '  <div class="bpd-cfg__hd">设置<span class="sp"></span>',
      '    <button class="bpd-cfg__x" data-act="close" title="关闭">',
      '      <svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor"',
      '      stroke-width="1.5" stroke-linecap="round"/></svg></button>',
      '  </div>',
      '  <div class="bpd-cfg__body">',
      '    <div class="bpd-cfg__grp">推送 / 命令行中转</div>',
      row('守护进程地址', '可选：只有 >4 MiB 的文件推 aria2 才需要它', txt('daemon', 'http://127.0.0.1:8765'), true),
      row('aria2 RPC', 'Motrix 默认 16800', txt('rpc', 'http://127.0.0.1:16800/jsonrpc'), true),
      row('RPC 密钥', '加了 --rpc-secret 才需要填，一般留空', txt('secret', '留空即可'), true),
      row('线程数', 'aria2 的 -x / -s', num('split', 1, 16), true),
      row('最大连接', '每服务器连接数', num('conn', 1, 16), true),
      row('最小分片', 'aria2 的 min-split-size',
        sel('minSplit', [['1M', '1M'], ['4M', '4M'], ['8M', '8M'], ['16M', '16M']]), true),
      row('推送目录', '留空 = 用 aria2 自己的下载目录', txt('ariaDir', '/Users/you/Downloads')),
      '    <div class="bpd-cfg__grp">页面内下载</div>',
      row('并行连接数', '页面里同时发几个 Range', num('cap', 1, 24), true),
      row('分块大小', '越小越不容易卡死，512 KiB 最稳',
        sel('chunk', [['256', '256 KiB'], ['512', '512 KiB'], ['1024', '1 MiB'], ['2048', '2 MiB']])),
      '    <div class="bpd-cfg__grp">分享页转存</div>',
      row('转存目录', '目录要已存在，默认根目录', txt('shareDir', '/'), true),
      '  </div>',
      '  <div class="bpd-cfg__stat"></div>',
      '  <div class="bpd-cfg__ft">',
      '    <button class="bpd-btn ghost" data-act="test">测试连接</button>',
      '    <button class="bpd-btn" data-act="reset">恢复默认</button><span class="sp"></span>',
      '    <button class="bpd-btn" data-act="close">取消</button>',
      '    <button class="bpd-btn primary" data-act="save">保存</button>',
      '  </div>',
      '</div>'
    ].join('');
  }

  function paintCfg() {
    if (!cfgEl) return;
    var c = cfg();
    cfgEl.querySelector('[name=daemon]').value = c.daemon;
    cfgEl.querySelector('[name=rpc]').value = c.rpc;
    cfgEl.querySelector('[name=secret]').value = c.secret || '';
    cfgEl.querySelector('[name=split]').value = c.split;
    cfgEl.querySelector('[name=conn]').value = c.conn;
    cfgEl.querySelector('[name=minSplit]').value = c.minSplit;
    cfgEl.querySelector('[name=ariaDir]').value = c.ariaDir || '';
    cfgEl.querySelector('[name=cap]').value = c.cap;
    cfgEl.querySelector('[name=chunk]').value = c.chunk;
    cfgEl.querySelector('[name=shareDir]').value = c.shareDir || '/';
  }

  function readCfg() {
    var c = cfg(), g = function (n) { return cfgEl.querySelector('[name=' + n + ']'); };
    var clip = function (v, d, lo, hi) {
      var n = parseInt(v, 10);
      if (isNaN(n)) n = d;
      return Math.max(lo, Math.min(hi, n));
    };
    return {
      daemon: (g('daemon').value || DEF.daemon).trim().replace(/\/+$/, ''),
      rpc: (g('rpc').value || DEF.rpc).trim(),
      secret: g('secret').value.trim(),
      split: clip(g('split').value, c.split, 1, 16),
      conn: clip(g('conn').value, c.conn, 1, 16),
      minSplit: g('minSplit').value,
      ariaDir: g('ariaDir').value.trim(),
      cap: clip(g('cap').value, c.cap, 1, 24),
      chunk: clip(g('chunk').value, c.chunk, 64, 8192),
      shareDir: (g('shareDir').value || '/').trim() || '/'
    };
  }

  function openCfg() {
    injectCss();
    if (cfgEl && cfgEl.isConnected) { cfgEl.style.display = 'flex'; paintCfg(); return; }
    cfgEl = document.createElement('div');
    cfgEl.className = 'bpd-mask';
    cfgEl.innerHTML = cfgHtml();
    cfgEl.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (e.target === cfgEl) { closeCfg(); return; }
      if (!b) return;
      e.preventDefault();
      var act = b.getAttribute('data-act');
      if (act === 'close') { closeCfg(); return; }
      if (act === 'test') {
        var d = (cfgEl.querySelector('[name=daemon]').value || DEF.daemon).trim().replace(/\/+$/, '');
        var st = cfgEl.querySelector('.bpd-cfg__stat');
        st.className = 'bpd-cfg__stat on';
        st.textContent = '正在连 ' + d + ' …';
        fetch(d + '/ping').then(function (r) { return r.json(); }).then(function (j) {
          if (!j) throw new Error('空的响应');
          var ariaOk = !!(j.aria && j.aria.ok);
          st.textContent = '守护进程 v' + j.version
            + (ariaOk ? '　aria2 ' + j.aria.version : '　aria2 没连上')
            + '　目录 ' + (j.outdir || '?');
          st.className = 'bpd-cfg__stat on ' + (ariaOk ? 'ok' : 'bad');
        }).catch(function () {
          st.textContent = '连不上 ' + d + ' —— 守护进程没起？python3 bpd_daemon.py';
          st.className = 'bpd-cfg__stat on bad';
        });
        return;
      }
      if (act === 'reset') {
        var d = {};
        for (var k in DEF) d[k] = DEF[k];
        saveCfg(d);
        paintCfg();
        tip('已恢复默认设置');
        return;
      }
      if (act === 'save') {
        var before = cfg();
        var panelWas = before.panel;
        var patch = readCfg();
        saveCfg(patch);
        closeCfg();
        tip('设置已保存' + (patch.chunk !== before.chunk || patch.cap !== before.cap ? '（新任务生效）' : ''));
        if (panelWas !== patch.panel) location.reload();
        else { renderAll(); if (typeof pump === 'function') pump(); }
      }
    });
    document.body.appendChild(cfgEl);
    paintCfg();
  }

  function closeCfg() { if (cfgEl) cfgEl.style.display = 'none'; }

  /* ------------------------------------------------------------ 右下角任务面板 */
  var panelEl = null;
  var SEL = {};   /* 勾选：{taskId:true} */

  function byId(id) {
    var out = null;
    TASKS.forEach(function (t) { if (String(t.id) === String(id)) out = t; });
    return out;
  }

  function selectedTasks() {
    return TASKS.filter(function (t) { return SEL[t.id]; });
  }

  /* 有勾选就用勾选，没有就退回「所有未完成的」——批量按钮不用先全选 */
  function targetTasks() {
    var picked = selectedTasks();
    if (picked.length) return picked;
    return TASKS.filter(function (t) { return t.state === 'run' || t.state === 'pause' || t.state === 'probe'; });
  }

  function ensurePanel() {
    injectCss();
    if (!document.body) return null;
    if (panelEl && panelEl.isConnected) return panelEl;
    panelEl = document.createElement('div');
    panelEl.className = 'bpd-panel';
    panelEl.innerHTML = [
      '<div class="bpd-panel__hd">',
      '  <b>网盘助手</b><span class="cnt"></span><span class="sp"></span>',
      '  <button data-op="cfg" title="设置" aria-label="设置">',
      '    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"',
      '      stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.1"/>',
      '      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06',
      '        a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09',
      '        A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06',
      '        A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09',
      '        A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06',
      '        A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09',
      '        a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06',
      '        A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09',
      '        a1.65 1.65 0 0 0-1.51 1z"/></svg></button>',
      '  <button data-op="fold" title="收起" aria-label="收起">',
      '    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"',
      '      stroke-linecap="round" stroke-linejoin="round">',
      '      <path d="M6.5 9.6 12 15.1l5.5-5.5"/><path d="M5.6 19.4h12.8"/></svg></button>',
      '</div>',
      '<div class="bpd-tabs">',
      '  <button data-tab="active" class="is-on">进行中<b></b></button>',
      '  <button data-tab="end">已结束<b></b></button>',
      '  <button data-tab="push">已推送<b></b></button>',
      '</div>',
      '<div class="bpd-panel__tools">',
      '  <button data-op="selall">全选</button>',
      '  <button data-op="btoggle">暂停</button>',
      '  <button data-op="bcancel">取消</button>',
      '  <button data-op="blink">链接</button>',
      '  <button data-op="bpush">推送</button>',
      '  <button data-op="hclear">清空</button>',
      '</div>',
      '<div class="bpd-panel__body"></div>'
    ].join('');
    panelEl.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-op]');
      if (b) {
        e.preventDefault();
        e.stopPropagation();
        panelOp(b.getAttribute('data-op'), e);
        return;
      }
      var tb = e.target.closest('.bpd-tabs button[data-tab]');
      if (tb) {
        e.preventDefault();
        if (FOLDED) setFold(false);  /* 点 tab 就是想看，先展开 */
        setTab(tb.getAttribute('data-tab'));
        return;
      }
      var hr = e.target.closest('.bpd-hist');
      if (hr) {
        e.preventDefault();
        if (e.target.closest('.bpd-hist__x')) histDel(curTab(), hr.getAttribute('data-hid'));
        return;
      }
      var row = e.target.closest('[data-tid]');
      if (!row) return;
      var t = byId(row.getAttribute('data-tid'));
      if (!t) return;
      if (e.target.closest('.bpd-task__x')) { e.preventDefault(); removeTask(t); return; }
      if (e.target.closest('.bpd-task__ck')) return;
      e.preventDefault();
      showCard(t, row, e);
    });
    panelEl.addEventListener('change', function (e) {
      var ck = e.target;
      if (!ck || ck.type !== 'checkbox') return;
      var row = ck.closest('[data-tid]');
      var t = row && byId(row.getAttribute('data-tid'));
      if (!t) return;
      if (ck.checked) SEL[t.id] = true; else delete SEL[t.id];
      renderAll();
    });
    document.body.appendChild(panelEl);
    /* 不再记忆「收起」：面板就是唯一能看到「什么在进行中」的地方，
       记忆成收起 = 下次进来一片空白（用户就是这么被坑的）。收起只在本次会话内有效。 */
    return panelEl;
  }

  /* 收起/展开（唯一出口，别处别再自己改 class）。收起 = 整块缩成右下角的小圆钮，
     展开 = 反过来。只记在内存里，不落盘：刷新后永远是展开的面板。 */
  var FOLDED = false;
  function setFold(folded) {
    folded = !!folded;
    FOLDED = folded;
    var el = ensurePanel();
    if (!el) return;
    el.classList.toggle('is-hide', folded);
    el.setAttribute('aria-hidden', folded ? 'true' : 'false');
    ensureFab().classList.toggle('on', folded);
    if (!folded) renderAll();
  }

  function panelOp(op, ev) {
    if (op === 'blink' && ev && ev.altKey) op = 'blinkcmd';
    if (op === 'cfg') { openCfg(); return; }
    if (op === 'hclear') { histClear(curTab()); return; }
    if (op === 'fold') { setFold(!FOLDED); return; }
    if (op === 'selall') {
      var all = TASKS.every(function (t) { return SEL[t.id]; });
      SEL = {};
      if (!all) TASKS.forEach(function (t) { SEL[t.id] = true; });
      renderAll();
      return;
    }
    var list = targetTasks();
    if (!list.length) { tip('没有可操作的任务'); return; }
    if (op === 'btoggle') {
      var anyPaused = list.every(function (t) { return t.state === 'pause'; });
      list.forEach(function (t) {
        if (anyPaused) { resumeTask(t); } else { pauseTask(t); }
      });
      tip((anyPaused ? '已继续 ' : '已暂停 ') + list.length + ' 个任务');
      return;
    }
    if (op === 'bcancel') {
      list.forEach(function (t) { cancelTask(t); });
      SEL = {};
      tip('已取消 ' + list.length + ' 个任务');
      return;
    }
    if (op === 'blink' || op === 'blinkcmd') {
      var has = list.filter(function (t) { return t.url; });
      if (!has.length) { tip('这几个任务还没拿到直链'); return; }
      if (DAEMON_OK === false) {
        var cl = has.map(curlLoop).filter(Boolean);
        tip(copyText(cl.join('\n\n'))
          ? '没检测到守护进程，已复制 ' + cl.length + ' 段零依赖的 curl 分块命令'
          : '复制失败，请手动复制');
        return;
      }
      var lines = has.map(op === 'blinkcmd' ? aria2Cmd : proxyLink);
      copyText(lines.join('\n'));
      tip('已复制 ' + lines.length + ' 条' + (op === 'blinkcmd' ? ' aria2c 命令' : '下载链接（⌥ 点复制命令）'));
      return;
    }
    if (op === 'bpush') { pushMany(list); return; }
  }

  /* 收起后右下角的小圆钮（40px）。它是面板的「另一个形态」，不是独立入口：
     只在收起时出现，点一下面板就长回来。 */
  var fabEl = null;
  function ensureFab() {
    if (fabEl && fabEl.isConnected) return fabEl;
    injectCss();
    fabEl = document.createElement('button');
    fabEl.type = 'button';
    fabEl.className = 'bpd-fab';
    fabEl.title = '展开网盘助手';
    fabEl.setAttribute('aria-label', '展开网盘助手');
    fabEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"'
      + ' stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M12 4.2v8.6"/><path d="M8.5 9.5 12 13l3.5-3.5"/>'
      + '<path d="M4.8 16.8v1.8a1.6 1.6 0 0 0 1.6 1.6h11.2a1.6 1.6 0 0 0 1.6-1.6v-1.8"/></svg>';
    fabEl.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      setFold(false);
    });
    document.body.appendChild(fabEl);
    return fabEl;
  }

  /* 只记在本次会话里，不落盘。之前把 tab 记进 GM 存储，结果下次打开页面停在
     「已推送」这个空列表上，标题却写着「2 个在下载」——用户看不到任务就是这么来的。 */
  var CUR_TAB = 'active';
  function curTab() {
    return CUR_TAB === 'end' || CUR_TAB === 'push' ? CUR_TAB : 'active';
  }
  function setTab(name) {
    CUR_TAB = (name === 'end' || name === 'push') ? name : 'active';
    renderAll();
  }

  function hhmm(ts) {
    var d = new Date(ts || 0);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  /* 历史 tab 的列表：只有名字、大小/时间、✕。按签名判断要不要重建，别每 400ms 重画 */
  function renderHistBody(body, kind) {
    var list = HIST[kind] || [];
    var sig = kind + '|' + list.map(function (h) { return h.hid + (h.st || ''); }).join(',');
    if (body.__sig === sig) return;
    body.__sig = sig;
    body.innerHTML = list.length
      ? list.map(function (h) {
        return '<div class="bpd-hist" data-hid="' + h.hid + '">'
          + '<div class="bpd-hist__nm" title="' + esc(h.name) + '"><b>' + esc(h.name) + '</b></div>'
          + '<span class="bpd-hist__mt">'
          + (kind === 'end' ? (h.st === 'done' ? '完成' : '已取消') + ' · ' : '')
          + (h.size ? mb(h.size) + ' · ' : '') + hhmm(h.at) + '</span>'
          + '<button class="bpd-hist__x" title="从列表移除">✕</button></div>';
      }).join('')
      : '<div class="bpd-panel__empty">' + (kind === 'end' ? '还没有结束的任务' : '还没有推送过文件') + '</div>';
    Array.prototype.slice.call(body.querySelectorAll('.bpd-hist')).forEach(function (hr) {
      var nm = hr.querySelector('.bpd-hist__nm');
      hr.addEventListener('mouseenter', function () { mqStart(nm); });
      hr.addEventListener('mouseleave', function () { mqStop(nm); });
      mqCut(nm);
    });
  }

  function renderPanel() {
    var el = ensurePanel();
    if (!el) return;
    if (document.body) {
      var busy = false;
      for (var k = 0; k < TASKS.length; k++) if (TASKS[k].state === 'run') { busy = true; break; }
      ensureFab().classList.toggle('is-run', busy);
    }
    if (FOLDED) return;                      /* 收起时不重画，免得跟缩小的动画抢帧 */

    var tab = curTab();
    var run = TASKS.filter(function (t) { return t.state === 'run'; }).length;
    var cnt = el.querySelector('.cnt');
    if (cnt) {
      /* 只说「有几个在下载」：总数 tab 上已经有了，写成「1 个（1 进行中）」纯属自我重复 */
      cnt.textContent = run ? '· ' + run + ' 个在下载' : '';
    }
    el.classList.toggle('is-hist', tab !== 'active');
    Array.prototype.forEach.call(el.querySelectorAll('.bpd-tabs button'), function (b) {
      var k = b.getAttribute('data-tab');
      b.classList.toggle('is-on', k === tab);
      var c = b.querySelector('b');
      if (c) {
        var n = k === 'active' ? TASKS.length : (HIST[k] || []).length;
        c.textContent = n ? String(n) : '';
      }
    });

    var body = el.querySelector('.bpd-panel__body');
    if (!body) return;
    /* 换 tab 就整块清掉：历史行和任务行结构不同，留着会串 */
    if (body.__tab !== tab) {
      body.innerHTML = '';
      body.__tab = tab;
      body.__sig = '';
    }
    if (tab !== 'active') {
      Array.prototype.slice.call(body.querySelectorAll('[data-tid]')).forEach(function (r) { r.remove(); });
      renderHistBody(body, tab);
      setToolState(el, false);
      return;
    }
    var empty = body.querySelector('.bpd-panel__empty');
    if (!TASKS.length) {
      Array.prototype.slice.call(body.querySelectorAll('[data-tid]')).forEach(function (r) { r.remove(); });
      if (!empty) body.innerHTML = '<div class="bpd-panel__empty">点文件行上的下载图标开始</div>';
      else empty.style.display = '';
      setToolState(el, false);
      return;
    }
    if (empty) empty.remove();
    TASKS.forEach(function (t) {
      var row = body.querySelector('[data-tid="' + t.id + '"]');
      if (!row) {
        row = document.createElement('div');
        row.className = 'bpd-task';
        row.setAttribute('data-tid', String(t.id));
        row.innerHTML = [
          '<label class="bpd-task__ck"><input type="checkbox">' + CHECK_SVG + '</label>',
          '<div class="bpd-task__nm"><i><b></b></i><span></span></div>',
          '<button class="bpd-task__x" title="从列表移除">✕</button>',
          '<div class="bpd-bar"><i></i></div>'
        ].join('');
        /* 整个条目就是把手：hover 任意位置都浮出那排图标，锚点也用行本身，
           这样浮条与条目垂直居中对齐，而不是黏在下面那根 6px 的进度条上。 */
        if (!row.__bpdHover) {
          row.__bpdHover = true;
          row.addEventListener('mouseenter', function () {
            var tt = byId(row.getAttribute('data-tid'));
            if (tt) showCard(tt, row);
            mqStart(row.querySelector('.bpd-task__nm i'));
          });
          row.addEventListener('mouseleave', function () {
            scheduleHideCard();
            mqStop(row.querySelector('.bpd-task__nm i'));
          });
        }
        body.appendChild(row);
      }
      var pct = t.size ? Math.min(100, Math.floor(100 * t.got / t.size)) : 0;
      var nmI = row.querySelector('.bpd-task__nm i');
      var mq = mqInner(nmI);
      var nmTxt = t.name || ('fs_id ' + t.fsid);
      if (mq && mq.textContent !== nmTxt) { mq.textContent = nmTxt; mqStop(nmI); nmI.__cutW = -1; }
      if (nmI.__cutW !== nmI.clientWidth) mqCut(nmI);   /* 面板宽度变了也要重新量 */
      var st = row.querySelector('.bpd-task__nm span');
      st.textContent = t.state === 'err' ? '失败' : t.state === 'probe' ? '获取链接中'
        : t.state === 'pause' ? '已暂停 ' + pct + '%' : t.state === 'done' ? '完成'
          : pct + '% · ' + rateTxt(t.rate);
      row.classList.toggle('is-sel', !!SEL[t.id]);
      var ck = row.querySelector('input[type=checkbox]');
      if (ck) ck.checked = !!SEL[t.id];
      var x = row.querySelector('.bpd-task__x');
      if (x) x.style.display = (t.state === 'done' || t.state === 'err') ? '' : 'none';
      var bar = row.querySelector('.bpd-bar');
      bar.className = 'bpd-bar' + (t.state === 'pause' ? ' is-pause' : t.state === 'err' ? ' is-err'
        : t.state === 'done' ? ' is-done' : '');
      bar.querySelector('i').style.width = (t.state === 'done' ? 100 : pct) + '%';
    });
    Array.prototype.slice.call(body.querySelectorAll('[data-tid]')).forEach(function (row) {
      if (!byId(row.getAttribute('data-tid'))) row.remove();
    });
    setToolState(el, true);
  }
  function setToolState(el, on) {
    ['btoggle', 'bcancel', 'blink', 'bpush'].forEach(function (op) {
      var b = el.querySelector('[data-op="' + op + '"]');
      if (b) b.disabled = !on;
    });
    var sel = el.querySelector('[data-op="selall"]');
    if (sel) sel.textContent = (TASKS.length && TASKS.every(function (t) { return SEL[t.id]; })) ? '取消全选' : '全选';
    var tg = el.querySelector('[data-op="btoggle"]');
    if (tg) {
      var cand = targetTasks();
      tg.textContent = (cand.length && cand.every(function (t) { return t.state === 'pause'; })) ? '继续' : '暂停';
    }
  }

    /* ---------------------------------------------------------------- UI 统一刷新 */
  var uiTimer = null;

  function startUi() {
    if (uiTimer) return;
    uiTimer = setInterval(renderAll, 400);
  }

  function stopUi() {
    if (!uiTimer) return;
    clearInterval(uiTimer);
    uiTimer = null;
  }

  function renderAll() {
    TASKS.forEach(paintRing);
    if (cardTask) { if (!byId(cardTask.id)) hideCard(); else updateCard(); }
    renderPanel();
  }

  /* ------------------------------------------------------------------ 动作分发 */
  function act(t, op, ev) {
    if (op === 'link' && ev && ev.altKey) op = 'linkcmd';
    if (op === 'toggle') {
      if (t.state === 'pause') resumeTask(t);
      else if (t.state === 'run' || t.state === 'probe') pauseTask(t);
      renderAll();
      return;
    }
    if (op === 'cancel') {
      if (t.state === 'done' || t.state === 'err' || t.state === 'cancel') removeTask(t);
      else cancelTask(t);
      return;
    }
    if (op === 'close') { hideCard(); return; }
    if (op === 'link' || op === 'linkcmd') {
      if (!t.url) { tip('直链还没拿到，等探测完成'); return; }
      if (DAEMON_OK === false) {
        /* 守护进程没起：CDN 直链给下载器必 403，改给一段 curl 分块命令，照样 parallax 多线程 */
        tip(copyText(curlLoop(t))
          ? '没检测到守护进程，已复制 curl 分块命令：粘到终端跑，会一块一块回显进度，中断了重跑同一段就是续传'
          : '复制失败，请手动复制');
        return;
      }
      if (op === 'link') {
        tip(copyText(proxyLink(t))
          ? '已复制下载链接（本机 4MiB 中转，粘到浏览器地址栏或下载器；粘到终端没用，⌥ 点复制命令行）'
          : '复制失败，请手动复制');
        return;
      }
      tip(copyText(aria2Cmd(t)) ? '已复制 aria2c 命令，粘到终端就能跑' : '复制失败');
      return;
    }
    if (op === 'push') {
      pushMany([t]); return;
    }
  }

  /* 取「元信息 + 直链」，不建下载任务：行内推送按钮 / 批量推送 / 卡片推送都走它 */
  function resolveItem(fsid) {
    return metaOf(fsid).then(function (m) {
      if (m.isdir) throw new Error('这是文件夹');
      return probe(m.path).then(function (pr) {
        return { fsid: String(fsid), name: m.name, size: m.size, path: m.path, url: pr.url, ua: pr.ua };
      });
    });
  }

  /* 推送到 aria2 JSON-RPC（Motrix / Aria2GUI / aria2c --enable-rpc 都吃这套）。
     页面 https 直接打 127.0.0.1:16800 会被 Chrome 的私有网络预检拦掉，所以统一走本机守护进程转发。
     推成功 = 这份文件交给 aria2 了：活跃列表里的同 fs_id 任务摘掉，记一条「已推送」。 */
  var pushing = false;

  /* 不经守护进程的直推：GM_xmlhttpRequest 是扩展级请求，不受 CORS / 私有网络预检 / 混合内容限制，
     可以直接打 aria2 RPC（页面自己的 fetch 会被 Chrome 的 Private Network Access 预检拦掉，
     因为 aria2 不返回 Access-Control-Allow-Private-Network）。
     它唯一的代价是没法改写 Range：aria2 每条连接都发开口的 bytes=S-，而百度只接受闭合且 ≤4MiB 的
     Range —— 所以超过 4MiB 的文件直推一定 403。官方客户端能下大文件，是因为它自己也在内部分块。
     换句话说：小文件、或者链接本来就能整段拿的，不需要守护进程；大文件才需要中转。 */
  function ariaDirect(items, c) {
    var base = String(c.rpc || DEF.rpc || '').trim();
    if (!base) return Promise.reject(new Error('没配 aria2 RPC 地址'));
    /* 单请求上限 4 MiB：文件比这大，aria2 那条 bytes=0- 必然被 403 打回。
       与其在 aria2 里留一条必挂的任务，不如当场说清楚该走哪条路。 */
    var CAP = 4194304;
    var big = items.filter(function (x) { return +x.size > CAP; });
    if (big.length === items.length) {
      return Promise.resolve({ ok: false, client: 'aria2', added: [], failed: [], tooBig: true,
        error: '全部 ' + items.length + ' 个都超过 4 MiB，aria2 直推必 403' });
    }
    var skipped = big.map(function (x) { return x.name; });
    items = items.filter(function (x) { return +x.size <= CAP; });
    var tok = c.secret ? ['token:' + c.secret] : [];
    var added = [], failed = [];
    return items.reduce(function (chain, x) {
      return chain.then(function () {
        var opts = {
          out: x.name,
          'user-agent': x.ua || CLIENT_UA[0],
          'referer': REFERER,
          'header': ['Referer: ' + REFERER],
          /* 直推时我们看不到 aria2 的下载目录，没法自己算不撞车的文件名，所以这里关掉续传语义：
             打开 continue 时 aria2 会把同名已存在文件当"续传目标"，实测会把一份下完的文件截断重下；
             关掉之后由 allow-overwrite=false + auto-file-renaming=true 接管，只会另存一份 (1)。 */
          'continue': 'false',
          'auto-file-renaming': 'true',
          'allow-overwrite': 'false',
          'split': String(+c.split || 4),
          'max-connection-per-server': String(+c.conn || +c.split || 4),
          'min-split-size': c.minSplit || '1M',
          'file-allocation': 'none'
        };
        if (c.ariaDir) opts.dir = c.ariaDir;
        return gm({
          method: 'POST', url: base, responseType: 'text', timeout: 15000,
          headers: { 'Content-Type': 'application/json' },
          data: JSON.stringify({
            jsonrpc: '2.0', id: 'bpd-' + Date.now(), method: 'aria2.addUri',
            params: tok.concat([[x.url], opts])
          })
        }).then(function (r) {
          var j = null;
          try { j = JSON.parse(r.responseText); } catch (e) { /* noop */ }
          if (j && j.result) added.push({ name: x.name, gid: j.result });
          else failed.push({ name: x.name, error: (j && j.error && (j.error.message || j.error.code)) || ('HTTP ' + r.status) });
        }, function (e) {
          failed.push({ name: x.name, error: e.message || 'RPC 连不上' });
        });
      });
    }, Promise.resolve()).then(function () {
      return { ok: !!added.length, client: 'aria2（直推）', rpc: base, added: added, failed: failed,
               skipped: skipped,
               error: added.length ? '' : ((failed[0] && failed[0].error) || '') };
    });
  }

  /* 推送成功后的统一收尾：写历史、摘掉页面里同文件的活跃任务、刷新面板。
     守护进程中转和直推两条路都走它，保证「页面任务」和「已推送」两边状态不会一边显示还在下、一边显示已推走。 */
  function afterPush(items, j) {
    var added = j.added || [];
    var okNames = {};
    added.forEach(function (a) { okNames[a.name] = true; });
    items.forEach(function (x) {
      if (!okNames[x.name]) return;
      histAdd('push', x);
      TASKS.filter(function (t) { return String(t.fsid) === String(x.fsid); }).forEach(function (t) {
        t.state = 'cancel';
        abortInflight(t);
        t.parts = null;
        t.queue = [];
        dropTask(t);
      });
    });
    var msg = '已推送 ' + added.length + ' 个到 ' + (j.client || 'aria2');
    if (j.failed && j.failed.length) msg += '，' + j.failed.length + ' 个失败（' + (j.failed[0].error || '') + '）';
    tip(msg + '，面板「已推送」里能查到');
    SEL = {};
    pump();
    renderAll();
    return true;
  }

  function pushItems(items) {
    items = (items || []).filter(function (x) { return x && x.url; });
    if (!items.length) { tip('没取到直链，没法推送'); return Promise.resolve(false); }
    if (pushing) { tip('上一批还在推，稍等一下'); return Promise.resolve(false); }
    pushing = true;
    var c = cfg();
    var payload = JSON.stringify({
      items: items.map(function (x) {
        return { url: x.url, name: x.name, size: x.size, ua: x.ua, fsid: x.fsid };
      }),
      rpc: c.rpc, secret: c.secret, mode: 'proxy',
      dir: c.ariaDir || '', split: +c.split || 4, conn: +c.conn || +c.split || 4,
      minSplit: c.minSplit || '1M'
    });
    function postPush() {
      return fetch(DAEMON + '/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-BPD-Token': DAEMON_TOKEN },
        body: payload
      }).then(function (r) {
        return r.json().then(function (j) { return { status: r.status, json: j }; });
      });
    }
    return postPush().then(function (res) {
      /* 401 = token 变了（守护进程重启过，或者页面比守护进程旧）：重取一次 token 再试 */
      if (res.status !== 401) return res;
      return pingDaemon(true).then(postPush);
    }).then(function (res) { return res.json; }).then(function (j) {
      pushing = false;
      if (!j || !j.ok) {
        DAEMON_OK = false;
        tip('推送失败：' + ((j && j.error) || '未知错误') + ' —— 没装守护进程就用「复制链接」的 curl 分块命令');
        return false;
      }
      return afterPush(items, j);
    }).catch(function () {
      /* 守护进程没起 → 直推 aria2，不再让「推送」整体不可用 */
      DAEMON_OK = false;
      return ariaDirect(items, c).then(function (j) {
        if (!j.ok) {
          pushing = false;
          tip(j.tooBig
            ? '没检测到守护进程，而「' + (items[0] && items[0].name || '') + '」超过 4 MiB：aria2 直吃直链必 403（百度只收闭合 ≤4 MiB 的 Range）。要推大文件就跑一次 python3 bpd_daemon.py；不需要 aria2 就直接用页面内下载，它不依赖任何本地进程。'
            : '推送失败：' + (j.error || 'RPC 没响应'));
          return false;
        }
        if (j.failed && j.failed.length) tip(j.failed.length + ' 个没推上（' + (j.failed[0].error || '') + '）');
        var ok = afterPush(items, j);
        if (j.skipped && j.skipped.length) {
          tip('推了 ' + (j.added || []).length + ' 个；另有 ' + j.skipped.length + ' 个超过 4 MiB（如「'
            + j.skipped[0] + '」）没推，需要本机中转');
        }
        return ok;
      });
    });
  }

  /* 面板 / 卡片上的「推送」：任务可能还没拿到直链，等它 */
  function pushMany(list) {
    list = list || [];
    if (!list.length) { tip('没有可推送的任务'); return; }
    tip('正在取直链并推送 ' + list.length + ' 个…');
    var jobs = list.map(function (t) {
      if (t.url) return Promise.resolve({ fsid: t.fsid, name: t.name, size: t.size, url: t.url, ua: t.ua });
      return resolveItem(t.fsid).catch(function () { return null; });
    });
    Promise.all(jobs).then(function (arr) { return pushItems(arr.filter(Boolean)); });
  }

  /* 行内 / 批量的推送按钮：直接给 fs_id，不建浏览器任务 */
  function quickPush(ids) {
    ids = (ids || []).filter(Boolean);
    if (!ids.length) { tip('没有选中文件'); return; }
    tip('正在取直链并推送 ' + ids.length + ' 个…');
    var jobs = ids.map(function (id) { return resolveItem(id).catch(function () { return null; }); });
    Promise.all(jobs).then(function (arr) {
      var ok = arr.filter(Boolean);
      if (!ok.length) { tip('一个都没取到直链（文件夹会被跳过）'); return; }
      return pushItems(ok);
    });
  }

  /* --------------------------------------------------- 入口：直链 / 分享页转存 */
  function directDownload(fsid, btn) {
    var t = newTask({ fsid: fsid, name: '', size: 0, path: '' }, btn);
    mountRing(t);
    startUi();
    renderAll();
    return metaOf(fsid).then(function (m) {
      if (m.isdir) throw new Error('这是文件夹');
      t.name = m.name; t.size = m.size; t.path = m.path;
      t.chunk = CHUNK;
      t.n = Math.max(1, Math.ceil(t.size / t.chunk));
      t.parts = new Array(t.n);
      t.queue = [];
      for (var i = 0; i < t.n; i++) t.queue.push(i);
      return probe(m.path).then(function (pr) { t.url = pr.url; t.ua = pr.ua; });
    }).then(function () {
      if (t.state === 'cancel') return;
      t.state = 'run';
      pump();
      renderAll();
    }).catch(function (e) { failTask(t, e); });
  }

  function sekeyValue() {
    var m = document.cookie.match(/(?:^|;\s*)BDCLND=([^;]+)/);
    if (!m) return '';
    try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
  }

  function shareCtx() {
    var w = pageWin();
    var y = w.yunData || window.yunData || {}, lo = w.locals || window.locals || {};
    return {
      shareid: y.shareid || lo.shareid,
      uk: y.share_uk || lo.share_uk,
      bdstoken: lo.bdstoken || y.bdstoken || '',
      sekey: sekeyValue(),
      dir: safeDir()
    };
  }

  function safeDir() {
    var d = cfg().shareDir || '/';
    if (typeof d !== 'string' || !d) return '/';
    d = d.replace(/\/+$/, '');
    if (!d) return '/';
    return d.charAt(0) === '/' ? d : '/' + d;
  }

  function md5Key(s) { return String(s || '').toLowerCase().replace(/[^0-9a-f]/g, '-'); }

  /* 分享页的文件名/大小/md5 在 yunData.file_list 里；翻页或搜索结果里可能没有，那就只能老实转存 */
  function shareFileMeta(fsid) {
    fsid = String(fsid);
    var w = pageWin(), y = w.yunData || window.yunData || {}, fl = y.file_list || [];
    for (var i = 0; i < fl.length; i++) {
      if (String(fl[i].fs_id) === fsid) {
        return { fsid: fsid, name: fl[i].server_filename,
                 size: +fl[i].size || 0, md5: md5Key(fl[i].md5) };
      }
    }
    return null;
  }

  /* 转存前先在目标目录里找同一份内容（size 一致 + md5 去 slice 标记后一致）。
     百度对同名文件只会改名成 (1)(2)(3)，不会按内容去重——不先查一遍，重复推送就会堆副本。 */
  function findSame(dir, sf) {
    if (!sf || !sf.md5 || !sf.size) return Promise.resolve(null);
    return listDir(dir).then(function (map) {
      var hit = null;
      Object.keys(map).forEach(function (k) {
        var it = map[k];
        if (hit || it.isdir || +it.size !== sf.size) return;
        if (md5Key(it.md5) === sf.md5) hit = it;
      });
      return hit;
    }).catch(function () { return null; });
  }

  function transferOne(ctx, fsid) {
    var url = '/share/transfer?shareid=' + ctx.shareid + '&from=' + ctx.uk
      + '&sekey=' + encodeURIComponent(ctx.sekey)
      + '&ondup=newcopy&async=1'
      + API_TAIL
      + '&bdstoken=' + encodeURIComponent(ctx.bdstoken);
    var body = 'fsidlist=' + encodeURIComponent('[' + fsid + ']')
      + '&path=' + encodeURIComponent(ctx.dir);
    return json(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body
    }).then(function (j) {
      if (j.errno !== 0) {
        console.error('[bpd] transfer failed URL=' + url + ' BODY=' + body + ' RESP=' + JSON.stringify(j));
        throw new Error('转存失败 errno=' + j.errno + (j.show_msg ? '：' + j.show_msg : ''));
      }
      var it = (j.extra && j.extra.list && j.extra.list[0]) || {};
      return String(j.to_fs_id || it.to_fs_id || it.to_fsid || '');
    });
  }

  function shareDownload(fsid, btn) {
    var t = newTask({ fsid: fsid, name: '', size: 0, path: '' }, btn);
    mountRing(t);
    startUi();
    renderAll();
    var ctx = shareCtx();
    var newFsid = '';
    return findSame(ctx.dir, shareFileMeta(fsid)).then(function (hit) {
      if (hit) {
        newFsid = hit.fsid; t.state = 'probe';
        tip('网盘里已有同一份文件，直接用它（不再转存副本）');
        return null;
      }
      return transferOne(ctx, fsid).then(function (id) {
        if (!id) throw new Error('转存没拿到新 fs_id');
        newFsid = id;
        t.state = 'probe';
        tip('已转存到 ' + ctx.dir + '，开始拉直链');
      });
    }).then(function () {
      return metaOf(newFsid);
    }).then(function (m) {
      t.name = m.name; t.size = m.size; t.path = m.path;
      t.chunk = CHUNK;
      t.n = Math.max(1, Math.ceil(t.size / t.chunk));
      t.parts = new Array(t.n);
      t.queue = [];
      for (var i = 0; i < t.n; i++) t.queue.push(i);
      return probe(m.path).then(function (pr) { t.url = pr.url; t.ua = pr.ua; });
    }).then(function () {
      if (t.state === 'cancel') return;
      t.state = 'run';
      pump();
      renderAll();
    }).catch(function (e) { failTask(t, e); });
  }

  /* 分享页的推送 = 转存 → 取直链 → 推 aria2。串行转存，免得百度把并发转存当成刷接口。
     转存出来的副本一律不删：/api/filemanager?opera=delete 在这个账号上恒返回 errno=132，
     而且去重命中时「副本」其实是用户网盘里本来就有的那份，删它等于删用户自己的文件。
     删不掉还骗人比明说不删更糟，所以只如实告诉用户副本在哪个目录。 */
  function sharePush(ids) {
    ids = (ids || []).filter(Boolean);
    if (!ids.length) { tip('没有选中文件'); return; }
    var ctx = shareCtx();
    tip('分享页要先转存：' + ids.length + ' 个 → ' + ctx.dir + ' 再推送，稍等…');
    var out = [], reused = 0;
    var chain = Promise.resolve();
    ids.forEach(function (id) {
      chain = chain.then(function () {
        return findSame(ctx.dir, shareFileMeta(id)).then(function (hit) {
          if (hit) {
            reused++;
            return resolveItem(hit.fsid).then(function (it) { out.push(it); });
          }
          return transferOne(ctx, id).then(function (nf) {
            if (!nf) throw new Error('转存没拿到新 fs_id');
            return resolveItem(nf).then(function (it) { out.push(it); });
          });
        }).catch(function (e) {
          console.warn('[bpd] 分享页转存/取链失败 fsid=' + id, e);
        });
      });
    });
    chain.then(function () {
      if (!out.length) { tip('一个都没转存成功（文件夹会被跳过，见控制台）'); return; }
      return pushItems(out).then(function (ok) {
        if (!ok) return;
        var made = out.length - reused;
        tip('已推送 ' + out.length + ' 个' + (reused ? '（其中 ' + reused + ' 个复用网盘里已有的同名同内容文件，没造副本）' : '')
          + (made ? '；新转存的 ' + made + ' 份副本在 ' + ctx.dir + '，用完请自行删除' : ''));
      });
    });
  }

  /* -------------------------------------------------------------- 接管原生按钮 */
  var bypass = false;
  var lastRow = null;
  var IS_SHARE = /^\/s\//.test(location.pathname);

  var DL_SEL = 'button[title="下载"],button[aria-label="下载"],.bottom_download_btn,'
    + '.share-list-toolbar__pill-btn,[data-bpd="1"]';

  function rowOf(el) { return el && el.closest ? el.closest('[data-id],[data-file-key]') : null; }

  function fsidOf(el) {
    var r = rowOf(el);
    if (!r) return null;
    return r.getAttribute('data-id') || r.getAttribute('data-file-key');
  }

  function rowIsDir(row) {
    if (!row) return false;
    var img = row.querySelector('img.wp-s-pan-list__file-name-title-icon, img[class*="file-name"][alt]');
    if (img && img.alt) return img.alt === 'folder';
    var svgTitle = row.querySelector('[class*="JS-fileicon"] svg title');
    return /folder|dir/i.test((svgTitle && svgTitle.textContent) || '');
  }

  function isDownloadButton(el) {
    if (!el || !el.closest) return null;
    var b = el.closest(DL_SEL);
    if (!b) return null;
    if (b.closest('.wp-s-ctx-menu,.ctx-menu-container')) return null;
    return b;
  }

  function selectedFsids() {
    var out = [];
    document.querySelectorAll('tr[data-id]').forEach(function (tr) {
      if (tr.classList.contains('selected') || tr.querySelector('.u-checkbox.is-checked')
        || tr.querySelector('.u-checkbox__input.is-checked')
        || tr.querySelector('.u-checkbox__original:checked')) {
        out.push(tr.getAttribute('data-id'));
      }
    });
    if (!out.length) {
      document.querySelectorAll('dd[data-file-key]').forEach(function (dd) {
        var box = dd.querySelector('[role="checkbox"][aria-checked="true"]');
        if (box || dd.querySelector('.wp-checkbox--checked')) out.push(dd.getAttribute('data-file-key'));
      });
    }
    return out;
  }

  function taskFor(fsid, btn) {
    if (!btn) {
      var r = document.querySelector('[data-id="' + fsid + '"],[data-file-key="' + fsid + '"]');
      btn = r && (r.querySelector('button[title="下载"]') || r.querySelector('.bottom_download_btn'));
    }
    if (IS_SHARE) return shareDownload(fsid, btn);
    if (rowIsDir(rowOf(btn))) return null;
    return directDownload(fsid, btn);
  }

  /* 悬停卡片：painted 按钮上一挂监听 */
  function bindHover(btn, t) {
    if (!btn) return;
    /* 同一个按钮可能先后对应多个任务（取消 + ✕ 删掉后再下一次）。
       监听只挂一次，任务记在按钮上，每次悬停现取。 */
    btn.__bpdTask = t;
    if (btn.__bpdHover) return;
    btn.__bpdHover = true;
    btn.addEventListener('mouseenter', function (ev) {
      var cur = btn.__bpdTask;
      if (!cur || !byId(cur.id)) return;   /* 已被 ✕ 移除：什么都不弹，别闪 */
      showCard(cur, btn, ev);
    });
    btn.addEventListener('mouseleave', scheduleHideCard);
  }

  function onClickCapture(e) {
    if (bypass) return;
    var t = e.target instanceof Element ? e.target : (e.target && e.target.parentElement);
    if (!t) return;

    /* 我们自己插的推送按钮（行内 / 批量） */
    var sb = t.closest('[data-bpd="push"]');
    if (sb) {
      e.preventDefault();
      e.stopImmediatePropagation();
      e.stopPropagation();
      var qids = sb.classList.contains('bpd-send--bulk')
        ? selectedFsids()
        : [sb.getAttribute('data-fsid')].filter(Boolean);
      /* 分享页的文件不在自己网盘里，取不到直链：必须先转存再推 */
      if (IS_SHARE) sharePush(qids); else quickPush(qids);
      /* 点完就失焦：Chrome 的 focus 描边（rgb(0,95,204) auto 1px）留在按钮上，
         视觉上就像「这个按钮样式和别人不一样」；原生按钮点完会弹窗、焦点自然走开 */
      try { sb.blur(); } catch (e2) { /* noop */ }
      return;
    }

    /* 右键菜单「下载」 */
    var item = t.closest('.wp-s-ctx-menu__item');
    if (item) {
      var label = (item.textContent || '').replace(/\s+/g, '');
      if (label !== '下载') return;
      var ids = selectedFsids();
      if (!ids.length && lastRow) ids = [fsidOf(lastRow)];
      if (!ids.length) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      ids.forEach(function (id) { taskFor(id, null); });
      return;
    }

    /* 行内 / 工具栏「下载」按钮 */
    var btn = isDownloadButton(t);
    if (!btn) return;

    var fsid = fsidOf(btn);
    if (fsid) {
      if (!IS_SHARE && rowIsDir(rowOf(btn))) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      e.stopPropagation();
      var task = IS_SHARE ? shareDownload(fsid, btn) : directDownload(fsid, btn);
      /* 找到刚建的任务，把悬停卡片挂到这个按钮上 */
      var last = TASKS[TASKS.length - 1];
      if (last && last.btn === btn) bindHover(btn, last);
      return task;
    }

    var sel = selectedFsids();
    if (!sel.length) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    e.stopPropagation();
    sel.forEach(function (id) { taskFor(id, null); });
  }

  /* ------------------------------------------------- 推送按钮（行内 + 批量）
   * 只画图形，外壳一律借百度的类：
   *   /disk/main 的行内动作是 `__h-action` 格子（16px 宽、12px 间距、图标 16px、主色 #06a7ff）
   *   /disk/main 的批量工具条是同款格子，但按钮带文字，高 32
   *   /s/... 分享页的行内动作是 32×32 的 .share-list-item-actions__button，
   *           工具条是 26px 高的 .share-list-toolbar__pill-btn
   * 所以四个入口四种外壳，统一由这里按环境挑，别自己发明尺寸。 */
  var SEND_SVG = isSharePage() ? SHARE_ICON : PLANE_SVG;

  function makeSend(bulk, fsid) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'bpd-send' + (bulk ? ' bpd-send--bulk' : '');
    b.setAttribute('data-bpd', 'push');
    b.title = bulk ? '把选中的文件推送到 aria2' : '推送到 aria2（不用先下载）';
    b.setAttribute('aria-label', b.title);
    if (!bulk) b.setAttribute('data-fsid', fsid || '');
    b.innerHTML = SEND_SVG + '<span style="display:none"></span>';
    return b;
  }

  /* 桌面版的「一个动作格子」：跟旁边那几个完全同一种 div，格距和分隔线都白拿 */
  function deskActionCell(btn) {
    var w = document.createElement('div');
    w.className = 'wp-s-agile-tool-bar__h-action is-need-left-sep is-list';
    w.appendChild(btn);
    return w;
  }

  /* 那一排的高度不是 CSS 给的，是 React 写在 button 上的内联 style="height:50px"，
     所以外壳要连 style 一起借，否则自己排出来的按钮只有 16px 高。 */
  /* 分享页的提示气泡是页面自己的 Vue 组件画的（深色、带箭头）。克隆出来的按钮没有
     Vue 指令，气泡不会出现；给它挂 title 又会变成 Chrome 的白色原生提示，和邻居明显
     不一样。所以按它渲染出来的结构自己画一个，class 一并借用（作用域样式要带 data-v）。 */
  var shareTipEl = null;
  function showShareTip(el, text) {
    if (!shareTipEl) {
      shareTipEl = document.createElement('span');
      shareTipEl.setAttribute('data-v-56dcc1d5', '');
      shareTipEl.className = 'wp-tooltip__popup wp-tooltip__popup--top wp-tooltip__popup--with-arrow';
      shareTipEl.setAttribute('role', 'tooltip');
      shareTipEl.style.position = 'fixed';
      shareTipEl.style.margin = '0';
      shareTipEl.style.transform = 'translate(-50%, -100%)';
      shareTipEl.innerHTML = '<span data-v-56dcc1d5="" class="wp-tooltip__arrow" aria-hidden="true"></span>'
        + '<span data-v-56dcc1d5="" class="wp-tooltip__content"></span>';
      document.body.appendChild(shareTipEl);
    }
    var txt = shareTipEl.querySelector('.wp-tooltip__content');
    if (txt) txt.textContent = text;
    var r = el.getBoundingClientRect();
    shareTipEl.style.left = Math.round(r.left + r.width / 2) + 'px';
    shareTipEl.style.top = Math.round(r.top - 4) + 'px';
    shareTipEl.style.display = '';
    clearTimeout(shareTipTimer);
    shareTipTimer = setTimeout(hideShareTip, 8000);
  }
  function hideShareTip() {
    clearTimeout(shareTipTimer);
    if (shareTipEl) shareTipEl.style.display = 'none';
  }
  /* 气泡的显示/隐藏只能走 document 级委托：
     分享页是 Vue 渲染的，行会被重排重画，挂在按钮自己的 mouseleave 上时，
     节点一被换掉就再也收不到事件，气泡会永久钉在屏幕上（实测卡在 (938,219)）。
     委托到 document 后，指针移到别处 / 点一下 / 滚一下都会收，再兜一个超时。 */
  var shareTipTimer = null;
  function attachShareTip(el, text) {
    if (!el) return;
    el.__bpdTipText = text;
    installShareTip();
  }
  function installShareTip() {
    if (installShareTip.done) return;
    installShareTip.done = true;
    document.addEventListener('mouseover', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('[data-bpd="push"]') : null;
      if (b && b.__bpdTipText) { showShareTip(b, b.__bpdTipText); return; }
      if (e.target && e.target.closest && e.target.closest('.wp-tooltip__popup')) return;
      hideShareTip();
    }, true);
    document.addEventListener('click', hideShareTip, true);
    document.addEventListener('scroll', hideShareTip, true);
    window.addEventListener('resize', hideShareTip);
  }

  function copyInline(ref, b) {
    var st = ref && ref.getAttribute ? ref.getAttribute('style') : '';
    if (st) b.setAttribute('style', st);
    return b;
  }

  function deskButton(bulk) {
    var b = makeSend(bulk, '');
    /* u-button--small 不能少：行内那一排的高度（50px）是它撑出来的，
       少了这个类按钮就只有 16px 高，图标会浮在格子顶端。 */
    b.className += ' u-button wp-s-agile-tool-bar__h-action-button u-button--text u-button--small';
    /* 图标必须包一层 inline-flex 的壳、再用 margin-right 顶开文字：
       直接把 <svg display:block> 摆在字前面，块级会把文字挤到第二行，
       结果按钮变成「上图下字」的 54px 窄条，跟旁边 76px 的字标按钮完全不是一族。 */
    /* 结构照抄原生：<i class="u-icon-x"></i><span>文字</span>。
       之前多套一层 span 是为了给自绘 SVG 摆位，换成字图后那层壳反而把行盒撑高
       （17.2 而不是原生的 14），把文字基线推高 0.5px。 */
    if (bulk) b.innerHTML = SEND_SVG + '<span>推送</span>';
    return b;
  }

  /* 页面换状态时（选中 → 未选中、切目录）React 只删自己的节点，我们插进去的格子是「外来户」，
     会跟着容器留下来：未选中时工具条变成「上传 / 新建文件夹 …」，我们的「推送」就贴在
     智能PPT 后面成了孤儿（实测出现过 上传|新建文件夹|…|推送）。所以每次补挂前先清一遍：
       · 工具条里没有「下载」格子了 → 摘掉批量那颗；
       · 行里的推送 data-fsid 和所在行的 data-id 不一致（行被复用给了别的文件）→ 摘掉。 */
  function pruneSend() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-bpd="push"]'), function (b) {
      var cell = b.closest('.wp-s-agile-tool-bar__h-action');
      if (cell) {
        var bar = cell.closest('.wp-s-agile-tool-bar');
        var row = cell.closest('tr[data-id]');
        if (bar && !row && !bar.querySelector('button[title="下载"],button[aria-label="下载"]')) {
          cell.remove();                                  /* 批量那颗：所在工具条已经没有下载 */
          return;
        }
        if (row && b.getAttribute('data-fsid') && b.getAttribute('data-fsid') !== row.getAttribute('data-id')) {
          cell.remove();                                  /* 行内那颗：行已经换给别的文件了 */
        }
      }
    });
  }

  function ensureSend(root) {
    var scope = root || document;
    pruneSend();

    /* ---- 桌面版行内：单独一格，别塞进「下载」那一格里（那一格会从 16px 被撑成 37px，
            于是整排图标的间距就它一个是特例，看上去就是「没对齐」） */
    Array.prototype.forEach.call(
      scope.querySelectorAll('td button[title="下载"],td button[aria-label="下载"]'),
      function (dl) {
        var cell = dl.closest('.wp-s-agile-tool-bar__h-action');
        var row = rowOf(dl);
        var id = row && (row.getAttribute('data-id') || row.getAttribute('data-file-key'));
        if (!cell || !cell.parentNode || !id) return;
        if (rowIsDir(row)) return;                    /* 文件夹推不了，别放个摆设 */
        if (cell.parentNode.querySelector('[data-bpd="push"]')) return;
        var b = copyInline(dl, deskButton(false));
        b.setAttribute('data-fsid', id);
        cell.parentNode.insertBefore(deskActionCell(b), cell.nextSibling);
      });

    /* ---- 桌面版批量：同样单独一格，紧跟在「下载」那一格后面。
            这里不能只插一次：选中/取消选中会让 React 重建这一条，我们那格是「外来的」
            节点，重建后会被挪到队尾（实测变成 … 复制 | 移动 | 推送），所以每次观察
            都要把它搬回「下载」后面，并把重复的删掉。 */
    var head = document.querySelector('.wp-s-agile-tool-bar.is-header-tool');
    if (head) {
      var hdl = head.querySelector('button[title="下载"],button[aria-label="下载"]');
      var hcell = hdl && hdl.closest('.wp-s-agile-tool-bar__h-action');
      if (hcell && hcell.parentNode) {
        var mine = Array.prototype.slice.call(head.querySelectorAll('[data-bpd="push"]'))
          .map(function (b) { return b.closest('.wp-s-agile-tool-bar__h-action'); })
          .filter(Boolean);
        mine.slice(1).forEach(function (c) { c.remove(); });   /* 重建时可能留下孤儿，删掉 */
        if (!mine.length) {
          hcell.parentNode.insertBefore(deskActionCell(copyInline(hdl, deskButton(true))), hcell.nextSibling);
        } else if (mine[0] !== hcell.nextSibling) {
          hcell.parentNode.insertBefore(mine[0], hcell.nextSibling);
        }
      }
    }

    /* ---- 分享页行内：32×32 图标按钮，排在「下载 / 保存至网盘」后面 */
    Array.prototype.forEach.call(
      scope.querySelectorAll('.share-list-item-actions__button[aria-label="下载"]'),
      function (dl) {
        var box = dl.parentNode;
        if (!box || box.querySelector('[data-bpd="push"]')) return;
        var row = rowOf(dl);
        var id = row && row.getAttribute('data-file-key');
        if (!id) return;
        /* 直接克隆原生那个按钮：类名、内联 style、图标盒子的尺寸全都原样继承，
           只把图标换成纸飞机、把 aria-label 换掉。比自己拼一个稳。 */
        var b = dl.cloneNode(true);
        b.className += ' bpd-send';
        b.setAttribute('data-bpd', 'push');
        b.setAttribute('data-fsid', id);
        b.setAttribute('aria-label', '推送');
        b.removeAttribute('title');
        var ic = b.querySelector('span.wp-svg-icon') || b.querySelector('svg');
        if (ic) {
          ic.outerHTML = '<span class="wp-svg-icon" style="width:16px;height:16px;font-size:16px;'
            + 'display:flex;align-items:center;justify-content:center;line-height:16px">'
            + SEND_SVG + '</span>';
        }
        attachShareTip(b, '推送');
        box.appendChild(b);
      });

    /* ---- 分享页批量：工具条里那一排药丸按钮，紧跟「下载」 */
    var pill = document.querySelector('.share-list-toolbar__pill');
    if (pill && !pill.querySelector('[data-bpd="push"]')) {
      var pills = Array.prototype.slice.call(pill.querySelectorAll('.share-list-toolbar__pill-btn'));
      var pdl = pills.filter(function (b) { return /下载/.test(b.textContent || ''); })[0];
      if (pdl) {
        var pb = pdl.cloneNode(true);
        pb.className += ' bpd-send bpd-send--bulk';
        pb.setAttribute('data-bpd', 'push');
        /* 批量推送的 fsid 来自勾选，不挂在按钮上 */
        pb.setAttribute('data-fsid', '');
        pb.setAttribute('aria-label', '推送');
        pb.removeAttribute('title');
        /* 药丸里的图标必须连 share-list-toolbar__icon 一起带上：
           原生 .share-list-toolbar__icon{display:flex;margin-right:4px} 就是图标与文字的间距，
           少了这个类，图标会紧贴文字（56px 宽 vs 原生 60px），看起来「局促」。 */
        var pic = pb.querySelector('span.wp-svg-icon') || pb.querySelector('svg');
        if (pic) {
          pic.outerHTML = '<span class="wp-svg-icon share-list-toolbar__icon"'
            + ' style="width:16px;height:16px;font-size:16px;display:flex;align-items:center;'
            + 'justify-content:center;line-height:16px">' + SEND_SVG + '</span>';
        }
        var spans = pb.querySelectorAll('span');
        if (spans.length) spans[spans.length - 1].textContent = '推送';
        attachShareTip(pb, '推送');
        pdl.parentNode.insertBefore(pb, pdl.nextSibling);
      }
    }
  }

  /* ------------------------------------------------------------------- 启动 */
  function boot() {
    applyCfg();
    injectCss();
    loadHist();

    ensurePanel();
    ensureSend(document);
    /* React 每次重渲染都会把行/工具条换掉：MutationObserver 立刻补挂，1.2s 轮询兜底 */
    var sendTimer = null;
    function scheduleSend() {
      if (sendTimer) return;
      sendTimer = setTimeout(function () { sendTimer = null; ensureSend(document); }, 120);
    }
    try {
      new MutationObserver(scheduleSend).observe(document.body, { childList: true, subtree: true });
    } catch (e) { /* noop */ }
    setInterval(function () { ensureSend(document); }, 1200);
    pingDaemon(true);
    setInterval(function () { pingDaemon(true); }, 30000);
    startUi();
    renderAll();

    document.addEventListener('click', onClickCapture, true);
    document.addEventListener('contextmenu', function (e) {
      var el = e.target instanceof Element ? e.target : null;
      var r = el && rowOf(el);
      if (r) lastRow = r;
    }, true);

    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('设置…（端口 / 线程数 / 分块）', openCfg);
      GM_registerMenuCommand('转存目录（当前 ' + (cfg().shareDir || '/') + '）', function () {
        var d = prompt('分享页里的文件先转存到哪个目录（要已存在）', cfg().shareDir || '/');
        if (d) { saveCfg({ shareDir: d }); location.reload(); }
      });
      GM_registerMenuCommand('推送地址（当前 ' + cfg().rpc + '）', function () {
        var r = prompt('「推送」推到哪个 aria2 JSON-RPC？（Motrix 默认 http://127.0.0.1:16800/jsonrpc）', cfg().rpc);
        if (r) { saveCfg({ rpc: r }); tip('推送地址已改为 ' + r); }
      });
      GM_registerMenuCommand('手动输入 fs_id 下载', function () {
        var id = prompt('文件 fs_id（网盘 URL 或行里的 data-id）');
        if (id) directDownload(String(id).trim(), null);
      });
      GM_registerMenuCommand('自检：拿当前目录最大的文件试一遍', function () {
        listDir(curDir()).then(function (map) {
          var best = null;
          Object.keys(map).forEach(function (k) {
            var m = map[k];
            if (!m.isdir && (!best || m.size > best.size)) best = m;
          });
          if (!best) { tip('这个目录里没有文件'); return; }
          directDownload(best.fsid, null);
        }).catch(function (e) { tip('自检失败：' + e.message); });
      });
      GM_registerMenuCommand('版本 ' + VERSION, function () { tip('百度网盘直链下载 v' + VERSION); });
    }
  }

  /* 调试出口：页面控制台里可直接调 window.__bpd */
  try {
    var W = pageWin();
    W.__bpd = {
      ver: VERSION, tasks: TASKS, probe: probe, metaOf: metaOf, listDir: listDir,
      pcsUrl: pcsUrl, download: directDownload, cap: G,
      push: pushMany, panel: function () { return panelEl; }, sel: function () { return SEL; },
      link: proxyLink, cmd: aria2Cmd, cfg: cfg, saveCfg: saveCfg, openCfg: openCfg,
      curl: curlLoop, ping: pingDaemon, daemonOk: function () { return DAEMON_OK; },
      hist: HIST, quickPush: quickPush, resolve: resolveItem, tab: setTab, curTab: curTab,
      fold: setFold, folded: function () { return FOLDED; },
      sharePush: sharePush, shareFileMeta: shareFileMeta, findSame: findSame, md5Key: md5Key,
      histClear: histClear, dropTask: dropTask,
    };
  } catch (e) { /* noop */ }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
