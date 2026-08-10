import { useEffect, useRef, useState } from "react";

export function stableStreamingText(
  current: string,
  next: string,
  streaming: boolean,
): string {
  return streaming && current.length > next.length ? current : next;
}

/** Limits markdown re-rendering to OpenChamber's 100ms streaming cadence. */
export function useStreamingText(
  text: string,
  streaming: boolean,
  identity: string,
): string {
  const [shown, setShown] = useState(text);
  const shownRef = useRef(shown);
  const lastAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  shownRef.current = shown;

  // biome-ignore lint/correctness/useExhaustiveDependencies: identity alone resets the stream
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    lastAt.current = 0;
    shownRef.current = text;
    setShown(text);
  }, [identity]);

  useEffect(() => {
    const next = stableStreamingText(shownRef.current, text, streaming);
    if (!streaming) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      lastAt.current = Date.now();
      setShown(next);
      return;
    }
    const wait = Math.max(0, 100 - (Date.now() - lastAt.current));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      lastAt.current = Date.now();
      setShown((current) => stableStreamingText(current, text, true));
    }, wait);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [streaming, text]);

  return shown;
}
