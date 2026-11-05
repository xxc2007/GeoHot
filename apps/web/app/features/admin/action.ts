// Client-side admin commands: same-origin fetch to /api/admin/* with the session's CSRF token, a
// stable Idempotency-Key per submitted command, and a revalidation of the page's loaders on success.
import { useCallback, useRef, useState } from "react";
import { useRevalidator, useRouteLoaderData } from "react-router";
import { appPath, publicPath } from "../../lib/public-path";
import { toast } from "./toast";

export interface AdminMe {
  name: string;
  csrf: string;
  dev: boolean;
}

export class AdminError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function useAdminMe(): AdminMe {
  return (useRouteLoaderData("admin-layout") as { me: AdminMe } | undefined)?.me ?? { name: "", csrf: "", dev: false };
}

function newKey() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function useAdminAction() {
  const me = useAdminMe();
  const revalidator = useRevalidator();
  const [pending, setPending] = useState<string | null>(null);
  const keys = useRef(new Map<string, string>());

  const run = useCallback(
    async <T = unknown>(
      method: "POST" | "PATCH" | "PUT" | "DELETE",
      path: string,
      body?: unknown,
      opts: { success?: string; label?: string; revalidate?: boolean } = {},
    ): Promise<T | null> => {
      const label = opts.label ?? `${method} ${path}`;
      // The same command retried after a failure keeps its key, so paid work is not repeated.
      const key = keys.current.get(label) ?? newKey();
      keys.current.set(label, key);
      setPending(label);
      try {
        const res = await fetch(publicPath(path), {
          method,
          credentials: "same-origin",
          headers: { "content-type": "application/json", "x-csrf-token": me.csrf, "idempotency-key": key },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (res.status === 401) {
          // `return` stays an app-root path: the api answers with a root-relative Location, and the proxy
          // in front re-applies the prefix the browser needs.
          toast("登录已过期，正在回到登录页", "error");
          window.location.href = publicPath(`/api/auth/login?return=${encodeURIComponent(appPath(window.location.pathname))}`);
          return null;
        }
        if (res.status === 403) {
          // 403 大多是 CSRF 令牌过期（后台开了很久没动）而不是没权限：把英文 detail 直接 toast 出去，
          // 操作者只看到 "forbidden" 不知道下一步做什么。刷新一次凭据、请人再点一次，比跳登录页温和。
          toast("这次操作被拒绝了（403）：校验可能已过期，已刷新，请再试一次", "error");
          revalidator.revalidate();
          return null;
        }
        const text = await res.text();
        const json = text ? JSON.parse(text) : null;
        if (!res.ok) throw new AdminError(res.status, json?.detail ?? `请求失败（${res.status}）`);
        keys.current.delete(label);
        if (opts.success) toast(opts.success, "ok");
        if (opts.revalidate !== false) revalidator.revalidate();
        // null means failure to callers; an empty success (204) is an empty object.
        return (json ?? {}) as T;
      } catch (error) {
        const message = error instanceof AdminError ? error.message : "网络错误，请稍后再试";
        toast(error instanceof AdminError && error.status === 409 ? `${message}` : message, "error");
        return null;
      } finally {
        setPending(null);
      }
    },
    [me.csrf, revalidator],
  );

  return { run, pending, busy: pending !== null || revalidator.state === "loading" };
}
