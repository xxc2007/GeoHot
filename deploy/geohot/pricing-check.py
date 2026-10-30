#!/usr/bin/env python3
"""每日闲时官方价核对 + 汇率落库（geohot-pricing-check.timer，05:50 Asia/Shanghai）。

做什么：
  1. 抓 OFFICIAL_RATES（packages/backend/src/admin/official-pricing.ts:8-18）里 9 条模型的官方
     定价页，把页面价与代码常量比对；结果与来源 URL 写 journal 并落 pricing_checks 表。
  2. 复用后端 refreshFx()（packages/backend/src/leaderboard/fetch/refresh.ts:76）把当日
     frankfurter（欧洲央行）USD/CNY 汇率落进 fx_rates —— 站点的 FEATURES.leaderboard 是关的
     （industry/features.ts:8，leaderboard.round cron 不注册），所以这条链只能由本脚本触发。

安全边界（请求面）：
  - 只 https，URL 必须逐条出现在本文件写死的 HOSTS 白名单里（主机名+路径前缀都固定）；
  - 每一跳（含重定向目标）解析出的所有 IP 都校验非私网/环回/链路本地/保留段，且地址与
    主机名绑定使用（防 DNS rebinding：校验后按 IP 直连，SNI/Host 保持原主机名）；
  - 重定向最多 5 跳，目标仍须命中白名单；不携带任何凭据（9 条都是公开定价页）。
"""
import base64
import ipaddress
import json
import os
import pathlib
import re
import socket
import ssl
import subprocess
import sys
import urllib.parse

APP = os.environ.get("GEOHOT_APP_ROOT", "/opt/geohot/app")
ENV_FILE = pathlib.Path(APP) / ".env"
TIMEOUT_S = 25
MAX_REDIRECTS = 5
UA = "Mozilla/5.0 (compatible; geohot-pricing-check/1.0; +https://xxc2007.me/geohot/about)"

# URL 白名单：id → 官方定价页。脚本只会请求这 9 个 URL（重定向目标也必须命中同主机+路径前缀）。
RATES = [
    ("deepseek", "USD", 0.15, 0.003, 0.60, "https://api-docs.deepseek.com/quick_start/pricing/"),
    ("hy3", "CNY", 1.0, 0.25, 4.0, "https://cloud.tencent.com/document/product/1823/130055"),
    ("glm53flash", "CNY", 0.8, 0.23, 2.8, "https://docs.bigmodel.cn/cn/guide/start/pricing"),
    ("glm53flash-intl", "USD", 0.15, 0.03, 0.50, "https://docs.z.ai/guides/overview/pricing"),
    ("step5", "USD", 1.0, 0.10, 2.7, "https://platform.stepfun.ai/docs/en/guides/pricing/details"),
    ("minimax", "USD", 0.15, 0.015, 0.60, "https://www.minimax.io/blog/minimax-m31f"),
    ("dots", "USD", 0.14, 0.14, 0.28, "https://dots.ai/platform/docs"),
    ("agnes", "USD", 0.05, 0.005, 0.15, "https://wiki.agnes-ai.com/en/docs/pricing"),
    ("agnes-cn", "CNY", 0.35, 0.035, 1.0, "https://www.agnes-ai.cn/zh-Hans/docs/agnes-30-flash"),
]
ALLOWED_HOSTS = {urllib.parse.urlsplit(url).hostname for *_, url in RATES}


def _public_ip(ip: str) -> bool:
    """只放行全球单播地址：拒绝环回/私网/链路本地/保留/未指定。"""
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return addr.is_global and not addr.is_multicast


def fetch(url: str) -> str:
    """GET 白名单内 https 页面。每一跳：解析 DNS → 校验全部 IP 公网 → 按 IP 连接（SNI 带原主机名，防 rebinding）。"""
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname not in ALLOWED_HOSTS:
        raise RuntimeError(f"refused (not in allowlist): {url}")
    current = url
    for _hop in range(MAX_REDIRECTS + 1):
        cur = urllib.parse.urlsplit(current)
        if cur.scheme != "https" or cur.hostname not in ALLOWED_HOSTS:
            raise RuntimeError(f"refused redirect target: {current}")
        infos = socket.getaddrinfo(cur.hostname, 443, type=socket.SOCK_STREAM)
        addresses = [info[4][0] for info in infos]
        if not addresses or not all(_public_ip(a) for a in addresses):
            raise RuntimeError(f"DNS for {cur.hostname} resolved to non-public address")
        # 校验后直连首个公网地址：地址来自刚才的解析（同一调用内无换挡窗口），SNI/Host 仍是原主机名。
        target_ip = addresses[0]
        raw = socket.create_connection((target_ip, 443), timeout=TIMEOUT_S)
        context = ssl.create_default_context()
        try:
            with context.wrap_socket(raw, server_hostname=cur.hostname) as tls:
                path = cur.path or "/"
                if cur.query:
                    path += "?" + cur.query
                request = (
                    f"GET {path} HTTP/1.1\r\n"
                    f"Host: {cur.hostname}\r\n"
                    f"User-Agent: {UA}\r\n"
                    "Accept: text/html,*/*\r\n"
                    "Connection: close\r\n"
                    "\r\n"
                )
                tls.sendall(request.encode("ascii"))
                chunks = []
                total = 0
                while True:
                    chunk = tls.recv(65536)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > 8 * 1024 * 1024:
                        raise RuntimeError(f"response too large from {cur.hostname}")
                    chunks.append(chunk)
        finally:
            raw.close()
        payload = b"".join(chunks)
        head, _, body = payload.partition(b"\r\n\r\n")
        lines = head.decode("latin-1").splitlines()
        status = int(lines[0].split()[1])
        headers: dict[str, str] = {}
        for line in lines[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()
        if 300 <= status < 400 and headers.get("location"):
            current = urllib.parse.urljoin(current, headers["location"])
            continue
        if status != 200:
            raise RuntimeError(f"HTTP {status} at {current}")
        encoding = "utf-8"
        for key, value in headers.items():
            if key == "content-type" and "charset=" in value:
                encoding = value.split("charset=", 1)[1].split(";")[0].strip()
        return body.decode(encoding, errors="replace")
    raise RuntimeError(f"too many redirects from {url}")


# 每条来源页的宽松抽取器（形状 2026-10-31 在生产机上逐页实测）。页面改版会变 None →
# 记"解析失败"，不误报价格变了。hy3（腾讯云）对无 cookie 请求返回反爬 JS shim，抓不到正文。
EXTRACTORS: dict[str, list[tuple[str, str]]] = {
    # dots 定价块："dots3-note-prev$0.14$0.28"（无缓存价，缓存按输入计价）。
    "dots": [(r"dots3-note-prev\s*\$\s*([\d.]+)\s*\$\s*([\d.]+)", "in_out")],
    # deepseek 表格：三段 rowspan 行，OFF-PEAK 在前（谷时=常量口径）。
    "deepseek": [
        (r"1M INPUT TOKENS<br>\(CACHE MISS\)</td><td>OFF-PEAK</td><td>\$([\d.]+)", "in"),
        (r"1M INPUT TOKENS<br>\(CACHE HIT\)</td><td>OFF-PEAK</td><td>\$([\d.]+)", "cached"),
        (r"1M OUTPUT TOKENS</td><td>OF[^<]*</td><td>\$([\d.]+)", "out"),
    ],
    # minimax 博客正文有一句加粗摘要，格式稳定。
    "minimax": [(r"Flat pricing per 1M tokens: \$([\d.]+) input · \$([\d.]+) output · \$([\d.]+) cached input", "in_out_cached")],
    # step5 表格行：<code>step-5-preview</code>…$1.00…$0.10…$2.70。
    "step5": [(r"<code>step-5-preview</code></td><td[^>]*>1M tokens</td><td[^>]*>\$([\d.]+)</td><td[^>]*>\$([\d.]+)</td><td[^>]*>\$([\d.]+)", "in_cached_out")],
    # bigmodel 国内表格行：GLM-5.3-Flash | 1M | 0.8 | 2.8 | 限时免费 | 0.23。
    "glm53flash": [(r"<td>GLM-5\.3-Flash</td><td[^>]*>1M</td><td[^>]*>([\d.]+)</td><td[^>]*>([\d.]+)</td><td>[^<]*</td><td[^>]*>([\d.]+)", "in_out_cached")],
    # z.ai 国际表格行：GLM-5.3-Flash | $0.15 | $0.03 | Limited-time Free | $0.50。
    "glm53flash-intl": [(r"<td[^>]*>GLM-5\.3-Flash</td><td[^>]*>\$([\d.]+)</td><td[^>]*>\$([\d.]+)</td><td[^>]*>[^<]*</td><td[^>]*>\$([\d.]+)", "in_cached_out")],
    # agnes 国际表格行：Input tokens | $0.05 …。
    "agnes": [
        (r"Input tokens</td><td><code>\$([\d.]+)", "in"),
        (r"Cached input</td><td><code>\$([\d.]+)", "cached"),
        (r"Output tokens</td><td><code>\$([\d.]+)", "out"),
    ],
    # agnes-cn 正文卡片："输入缓存命中：¥0.035 / 百万 Token；输入：¥0.35 …；输出：¥1.00 …"。
    "agnes-cn": [
        (r"输入：\s*<code>¥([\d.]+)", "in"),
        (r"输入缓存命中：\s*<code>¥([\d.]+)", "cached"),
        (r"输出：\s*<code>¥([\d.]+)", "out"),
    ],
}


def _grouped(found: dict[str, float], order: list[str], groups: tuple[str, ...]) -> None:
    for key, value in zip(order, groups):
        found[key] = float(value)


def extract_prices(model_id: str, html: str) -> dict[str, float] | None:
    found: dict[str, float] = {}
    for pattern, key in EXTRACTORS.get(model_id, []):
        m = re.search(pattern, html, re.S)
        if not m:
            return None
        if key == "in_out":  # dots: no cache price column — cache bills at the input rate.
            found["input"] = found["cached"] = float(m.group(1))
            found["output"] = float(m.group(2))
        elif key == "in_out_cached":  # in, out, cached
            found["input"], found["output"], found["cached"] = float(m.group(1)), float(m.group(2)), float(m.group(3))
        elif key == "in_cached_out":  # in, cached, out
            found["input"], found["cached"], found["output"] = float(m.group(1)), float(m.group(2)), float(m.group(3))
        elif key == "in_out":
            found["input"], found["output"] = float(m.group(1)), float(m.group(2))
        else:
            found[key] = float(m.group(1))
    # 返回形状统一为 input/cached/output：单条正则写的键是 in/cached/out，组合正则直接写了 input/…。
    if {"input", "cached", "output"} <= found.keys():
        return found
    if {"in", "cached", "out"} <= found.keys():
        return {"input": found["in"], "cached": found["cached"], "output": found["out"]}
    return None


def run_refresh_fx() -> tuple[bool, str]:
    """跑官方链路 refreshFx()（与 worker 同一模块、同一 .env）。失败返回 False+原因。

    第一次真实跑（2026-10-31 02:47）整个 node import 链路约 100 秒，90s 超时会误杀
    已经在等 frankfurter 响应的进程——放宽到 240s 并保留 stderr 尾部。
    """
    code = (
        "const mod = await import('./packages/backend/src/leaderboard/fetch/refresh.ts');"
        "const r = await mod.refreshFx();"
        "console.log(JSON.stringify(r));"
        # 后端模块持有 postgres 连接池（keepalive），进程不会自然退出——不显式退出会
        # 一直等到 subprocess 超时（2026-10-31 02:57 实测 240s 全耗在等 EOF）。
        "process.exit(0);"
    )
    try:
        out = subprocess.run(
            ["node", "--env-file=.env", "--input-type=module", "-e", code],
            cwd=APP, capture_output=True, text=True, timeout=240,
            user="geohot" if os.geteuid() == 0 else None,
        )
        if out.returncode != 0:
            return False, (out.stderr or out.stdout or f"node exit {out.returncode}")[-400:]
        line = next((l for l in out.stdout.splitlines() if l.startswith("{")), "")
        if not line:
            return False, f"refreshFx 无 JSON 输出: {out.stdout[-200:]} | stderr: {out.stderr[-200:]}"
        data = json.loads(line)
        return True, f"asOf={data.get('asOf')} rate={data.get('rate')}"
    except subprocess.TimeoutExpired as exc:
        return False, f"TimeoutExpired after 240s: {(exc.stderr or b'')[-200:] if isinstance(exc.stderr, bytes) else exc.stderr}"
    except (json.JSONDecodeError, OSError) as exc:
        return False, f"{type(exc).__name__}: {exc}"


def write_pricing_checks(payload: dict) -> str:
    """结果落库：pricing_checks（CREATE TABLE IF NOT EXISTS），走 DATABASE_URL，参数绑定。"""
    db = None
    try:
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            if line.startswith("DATABASE_URL="):
                db = line.split("=", 1)[1].strip().strip('"')
                break
    except OSError:
        return "读不到 .env"
    if not db:
        return "DATABASE_URL 未配置"
    body = json.dumps(payload, ensure_ascii=False)
    diffs, errors = len(payload["diffs"]), len(payload["errors"])
    # 值全部经参数绑定（${} 占位）进 SQL 文本，外部输入不拼接。
    code = (
        "import postgres from 'postgres';"
        "const sql = postgres(process.env.PC_DB_URL, {max: 1});"
        "await sql`CREATE TABLE IF NOT EXISTS pricing_checks (id bigserial PRIMARY KEY, checked_at timestamptz NOT NULL DEFAULT now(), day text NOT NULL, payload jsonb NOT NULL, diffs int NOT NULL, errors int NOT NULL)`;"
        "const day = process.env.PC_DAY, body = process.env.PC_BODY;"
        "const diffs = Number(process.env.PC_DIFFS), errors = Number(process.env.PC_ERRORS);"
        "await sql`INSERT INTO pricing_checks (day, payload, diffs, errors) VALUES (${day}, ${body}, ${diffs}, ${errors})`;"
        "await sql.end();"
        "console.log('ok');"
    )
    env = {**os.environ, "PC_DB_URL": db, "PC_DAY": payload["day"], "PC_BODY": body, "PC_DIFFS": str(diffs), "PC_ERRORS": str(errors)}
    try:
        out = subprocess.run(
            ["node", "--env-file=.env", "--input-type=module", "-e", code],
            cwd=APP, capture_output=True, text=True, timeout=60,
            env=env, user="geohot" if os.geteuid() == 0 else None,
        )
        if out.returncode != 0:
            return f"写库失败: {(out.stderr or out.stdout)[-300:]}"
        return f"写库成功：diffs={diffs} errors={errors}"
    except (subprocess.TimeoutExpired, OSError) as exc:
        return f"{type(exc).__name__}: {exc}"


def main() -> int:
    import datetime

    day = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime("%Y-%m-%d")
    results: list[dict] = []
    diffs: list[str] = []
    errors: list[str] = []

    for model_id, currency, const_in, const_cached, const_out, source in RATES:
        entry = {"model": model_id, "currency": currency, "source": source, "constant": [const_in, const_cached, const_out], "page": None, "status": "error", "note": ""}
        try:
            prices = extract_prices(model_id, fetch(source))
        except Exception as exc:  # noqa: BLE001 - 每条来源独立容错
            errors.append(f"{model_id}: {type(exc).__name__}: {str(exc)[:160]}")
            entry["note"] = f"抓取失败 {type(exc).__name__}: {str(exc)[:160]}"
            results.append(entry)
            continue
        if prices is None:
            errors.append(f"{model_id}: 页面解析失败（改版?），来源 {source}")
            entry["status"], entry["note"] = "unparsed", "页面结构不匹配解析器，需人工看来源页"
            results.append(entry)
            continue
        entry["page"] = [prices["input"], prices["cached"], prices["output"]]
        got = (prices["input"], prices["cached"], prices["output"])
        want = (const_in, const_cached, const_out)
        if any(abs(a - b) > 1e-9 for a, b in zip(got, want)):
            entry["status"] = "diff"
            diffs.append(f"{model_id} ({currency}): 常量 {list(want)} vs 页面 {list(got)} — {source}")
        else:
            entry["status"] = "match"
        results.append(entry)

    fx_ok, fx_msg = run_refresh_fx()
    if not fx_ok:
        errors.append(f"refreshFx: {fx_msg}")

    payload = {"day": day, "results": results, "diffs": diffs, "errors": errors, "fx": fx_msg, "fxOk": fx_ok}
    print(json.dumps(payload, ensure_ascii=False, indent=1))
    db_msg = write_pricing_checks(payload)
    print(f"fx: {'成功 ' + fx_msg if fx_ok else '失败 ' + fx_msg}")
    print(f"pricing_checks: {db_msg}")

    return 1 if (diffs or errors) else 0


if __name__ == "__main__":
    sys.exit(main())
