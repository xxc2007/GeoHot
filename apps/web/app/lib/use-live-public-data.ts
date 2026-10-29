import { useEffect, useRef, useState } from "react";
import { useNavigation } from "react-router";
import { atQuietPageHead, refreshPublicData } from "./live-refresh";
import { publicPath } from "./public-path";

/** Silent, bounded refresh of the existing public endpoint; never runs a model or adds an entrance. */
export function useLivePublicData<T>(initial: T, endpoint: string | readonly string[] | null): T {
  const navigation = useNavigation();
  const idle = useRef(true);
  idle.current = navigation.state === "idle";
  const [live, setLive] = useState({ initial, data: initial });
  const endpointKey = JSON.stringify(endpoint);
  useEffect(() => {
    const paths = JSON.parse(endpointKey) as string | string[] | null;
    if (!paths) return;
    const url = typeof paths === "string" ? publicPath(paths) : paths.map(publicPath);
    const controller = new AbortController();
    let inFlight = false;
    let lastAttempt = Date.now();
    const refresh = async () => {
      if (inFlight || Date.now() - lastAttempt < 60_000 || !idle.current || !atQuietPageHead()) return;
      lastAttempt = Date.now();
      inFlight = true;
      try {
        await refreshPublicData<T>(url, controller.signal,
          () => idle.current && atQuietPageHead(), data => setLive({ initial, data }));
      } finally { inFlight = false; }
    };
    const timer = window.setInterval(() => { void refresh(); }, 60_000);
    const focus = () => { void refresh(); };
    document.addEventListener("visibilitychange", focus);
    window.addEventListener("focus", focus);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", focus);
      window.removeEventListener("focus", focus);
    };
  }, [initial, endpointKey]);
  return live.initial === initial ? live.data : initial;
}
