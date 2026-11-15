// Admin loaders read /api/admin/* with the visitor's own cookie; the web process holds no session.
import { data, redirect } from "react-router";
import { appPath } from "./public-path.ts";
import { deployBase } from "@aihot/contracts/http-policy";

const API_BASE = process.env.API_BASE_URL || "http://127.0.0.1:3001";

/** 后台写操作：把 JSON 交给 API，401 跳登录页，其余错误原样抛出给 action。 */
export async function adminPost<T>(request: Request, path: string, payload: unknown, timeoutMs = 30_000): Promise<T> {
  const API_BASE = process.env.API_BASE_URL || "http://127.0.0.1:3001";
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", cookie: request.headers.get("cookie") ?? "" },
      body: JSON.stringify(payload),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]),
    });
  } catch (error) {
    if (request.signal.aborted) throw error;
    throw data({ message: "后台暂时写不进去，请稍后重试。" }, { status: 503 });
  }
  if (res.status === 401) {
    const url = new URL(request.url);
    throw redirect(`/admin/login?${new URLSearchParams({ return: appPath(url.pathname) + url.search })}`);
  }
  if (!res.ok) {
    let detail = `api ${res.status}`;
    try {
      detail = ((await res.json()) as { detail?: string }).detail ?? detail;
    } catch {
      // not JSON
    }
    throw data({ message: detail }, { status: res.status === 409 ? 409 : res.status >= 500 ? 503 : res.status });
  }
  try {
    return (await res.json()) as T;
  } catch {
    return {} as T;
  }
}

export async function adminGet<T>(request: Request, path: string, timeoutMs = 30_000): Promise<T> {
  let res: Response;
  try {
    const controlRead = path === "/api/admin/me" || path === "/api/admin/server";
    const base = process.env.ADMIN_CONTROL_BASE_URL || `http://127.0.0.1:${process.env.WEB_PORT || process.env.PORT || 3000}`;
    res = await fetch(controlRead ? `${base}${deployBase(process.env.SITE_URL)}${path}` : `${API_BASE}${path}`, {
    headers: { accept: "application/json", cookie: request.headers.get("cookie") ?? "", "user-agent": request.headers.get("user-agent") ?? "" },
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]),
    });
  } catch (error) {
    if (request.signal.aborted) throw error;
    console.warn(JSON.stringify({ level: "warn", msg: "admin read failed", path: path.split("?")[0], phase: "connect", error: error instanceof Error ? error.name : "unknown" }));
    throw data({ message: "后台请求暂时超时，请稍后重试。" }, { status: 503 });
  }
  if (res.status === 401) {
    const url = new URL(request.url);
    throw redirect(`/admin/login?${new URLSearchParams({ return: appPath(url.pathname) + url.search })}`);
  }
  if (res.status === 404) throw data({ message: "not_found" }, { status: 404 });
  if (!res.ok) {
    console.warn(JSON.stringify({ level: "warn", msg: "admin read failed", path: path.split("?")[0], phase: "response", status: res.status }));
    let detail = `api ${res.status}`;
    try {
      detail = ((await res.json()) as { detail?: string }).detail ?? detail;
    } catch {
      // not JSON
    }
    throw data({ message: detail }, { status: res.status >= 500 ? 503 : res.status });
  }
  try {
    // The deadline also covers the response body, which can reset after headers arrived.
    return (await res.json()) as T;
  } catch (error) {
    if (request.signal.aborted) throw error;
    console.warn(JSON.stringify({ level: "warn", msg: "admin read failed", path: path.split("?")[0], phase: "body", error: error instanceof Error ? error.name : "unknown" }));
    throw data({ message: "后台响应暂时中断，请稍后重试。" }, { status: 503 });
  }
}
