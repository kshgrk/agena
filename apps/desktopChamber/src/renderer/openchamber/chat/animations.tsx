import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

const RevealDisabled = createContext(false);

export function RevealDisabledProvider({
  disabled,
  children,
}: {
  disabled: boolean;
  children: ReactNode;
}) {
  return (
    <RevealDisabled.Provider value={disabled}>
      {children}
    </RevealDisabled.Provider>
  );
}

export function UserSendReveal({
  animate,
  children,
}: {
  animate: boolean;
  children: ReactNode;
}) {
  const disabled = useContext(RevealDisabled);
  const shouldAnimate = useRef<boolean | null>(null);
  shouldAnimate.current ??=
    animate &&
    !disabled &&
    !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const [visible, setVisible] = useState(!shouldAnimate.current);

  useEffect(() => {
    if (!shouldAnimate.current) return;
    const frame = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  if (!shouldAnimate.current) return children;
  return (
    <div
      className={`w-full transition-all duration-300 ease-out ${visible ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"}`}
    >
      {children}
    </div>
  );
}

const WIPE_MASK =
  "linear-gradient(to right, rgba(0,0,0,1) 0%, rgba(0,0,0,1) 45%, rgba(0,0,0,0) 60%, rgba(0,0,0,0) 100%)";

/** OpenChamber's one-shot tool/activity wipe. */
export function ActivityReveal({
  animate,
  delayMs = 0,
  children,
}: {
  animate: boolean;
  delayMs?: number;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const clear = useCallback((node: HTMLElement | null) => {
    if (!node) return;
    node.style.opacity = "";
    node.style.transform = "";
    node.style.maskImage = "";
    node.style.webkitMaskImage = "";
    node.style.maskSize = "";
    node.style.webkitMaskSize = "";
    node.style.maskPosition = "";
    node.style.webkitMaskPosition = "";
  }, []);

  useLayoutEffect(() => {
    const node = rootRef.current;
    if (
      !node ||
      !animate ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      clear(node);
      return;
    }
    const masked =
      CSS.supports?.(
        "mask-image",
        "linear-gradient(to right, black, transparent)",
      ) ||
      CSS.supports?.(
        "-webkit-mask-image",
        "linear-gradient(to right, black, transparent)",
      );
    node.style.opacity = "0";
    node.style.transform = "translateX(-0.06em)";
    if (masked) {
      node.style.maskImage = WIPE_MASK;
      node.style.webkitMaskImage = WIPE_MASK;
      node.style.maskSize = "240% 100%";
      node.style.webkitMaskSize = "240% 100%";
      node.style.maskPosition = "100% 0%";
      node.style.webkitMaskPosition = "100% 0%";
    }
    let animation: Animation | null = null;
    const frame = requestAnimationFrame(() => {
      animation = node.animate(
        masked
          ? [
              {
                opacity: 0,
                transform: "translateX(-0.06em)",
                maskPosition: "100% 0%",
              },
              { opacity: 1, transform: "translateX(0)", maskPosition: "0% 0%" },
            ]
          : [
              { opacity: 0, transform: "translateX(-0.06em)" },
              { opacity: 1, transform: "translateX(0)" },
            ],
        {
          duration: 500,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
          delay: delayMs,
          fill: "forwards",
        },
      );
      void animation.finished.catch(() => undefined).finally(() => clear(node));
    });
    return () => {
      cancelAnimationFrame(frame);
      animation?.cancel();
      clear(node);
    };
  }, [animate, clear, delayMs]);

  return <div ref={rootRef}>{children}</div>;
}

export function BusyDots() {
  return (
    <span className="inline-flex" aria-hidden="true">
      {[0, 200, 400].map((delay) => (
        <span
          key={delay}
          className="animate-pulse-soft"
          style={{ animationDelay: `${delay}ms` }}
        >
          .
        </span>
      ))}
    </span>
  );
}
