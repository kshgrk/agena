import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  type AutoFollowState,
  bottomZone,
  distanceFromBottom,
  followStateAfterScroll,
} from "./auto-follow-logic.ts";

export type ContentChangeReason =
  | "text"
  | "structural"
  | "permission"
  | "animation";

export type AnimationHandlers = {
  onChunk: () => void;
  onComplete: () => void;
  onAnimatedHeightChange: () => void;
};

export type UseChatAutoFollowOptions = {
  sessionKey: string;
  messageCount: number;
  working: boolean;
  mobile: boolean;
  onActiveTurnChange?: (turnId: string | null) => void;
};

export type UseChatAutoFollowResult = {
  scrollRef: RefObject<HTMLDivElement | null>;
  state: AutoFollowState;
  showScrollButton: boolean;
  isFollowingProgrammatically: boolean;
  goToBottom: (mode?: "instant" | "smooth") => void;
  scrollToBottomOnSend: () => void;
  releaseAutoFollow: () => void;
  restoreAtLatest: () => void;
  notifyContentChange: (reason?: ContentChangeReason) => void;
  getAnimationHandlers: (id: string) => AnimationHandlers;
};

/** Fired by the shell whenever the dock layout changes (splits, tab moves).
 * Dock containers reparent panel DOM on those operations, which silently
 * resets scrollTop with no resize tick — listeners re-apply scroll state. */
export const DOCK_RELAYOUT_EVENT = "oc:dock-relayout";

const AUTO_TTL_MS = 1500;
const ANIMATION_GUARD_MS = 350;
const SETTLE_MS = 300;
const ENTRY_QUIET_MS = 600;
const ENTRY_MAX_MS = 8000;

const now = () => performance.now();
const canScroll = (el: HTMLElement) => el.scrollHeight - el.clientHeight > 1;

/**
 * OpenChamber's scroll contract: only genuine user intent releases following;
 * passive following is pre-paint and active only while work settles.
 */
export function useChatAutoFollow({
  sessionKey,
  messageCount,
  working,
  mobile,
  onActiveTurnChange,
}: UseChatAutoFollowOptions): UseChatAutoFollowResult {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [state, setState] = useState<AutoFollowState>("following");
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [isFollowingProgrammatically, setFollowingProgrammatically] =
    useState(false);
  const stateRef = useRef<AutoFollowState>("following");
  const workingRef = useRef(working);
  const settlingRef = useRef(false);
  const mobileRef = useRef(mobile);
  const previousTopRef = useRef(0);
  // dockview hides inactive tabs with display:none, which zeroes the scroll
  // element and resets scrollTop; remember the last visible offset so reshow
  // restores the reader's place instead of landing at the top.
  const lastVisibleTopRef = useRef(0);
  const hiddenRef = useRef(false);
  const autoRef = useRef<{ top: number; at: number } | null>(null);
  const animationGuardUntil = useRef(0);
  const keyboardAnimating = useRef(false);
  const entryStick = useRef(false);
  const entryHeight = useRef(0);
  const entryQuietTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const entryCapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handlers = useRef(new Map<string, AnimationHandlers>());
  workingRef.current = working;
  mobileRef.current = mobile;

  // Ref attachment can change behind hydration/empty-state branches.
  useLayoutEffect(() => {
    if (scrollRef.current !== container) setContainer(scrollRef.current);
  });

  const setFollowState = useCallback((next: AutoFollowState) => {
    if (stateRef.current === next) return;
    stateRef.current = next;
    setState(next);
  }, []);

  const updateButton = useCallback(() => {
    const el = scrollRef.current;
    setShowScrollButton(
      Boolean(
        el &&
          canScroll(el) &&
          stateRef.current === "released" &&
          distanceFromBottom(el) >
            bottomZone(mobileRef.current, el.clientHeight),
      ),
    );
  }, []);

  const pinNow = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current;
    if (!el) return;
    const top = Math.max(0, el.scrollHeight - el.clientHeight);
    autoRef.current = { top, at: now() };
    const target = el.scrollHeight + 4096;
    if (behavior === "smooth") el.scrollTo({ top: target, behavior });
    else el.scrollTop = target;
  }, []);

  const isActive = useCallback(
    () => workingRef.current || settlingRef.current,
    [],
  );

  const pin = useCallback(
    (force: boolean, behavior: ScrollBehavior = "auto") => {
      if (!force && (!isActive() || stateRef.current !== "following")) return;
      if (force) setFollowState("following");
      pinNow(force ? behavior : "auto");
    },
    [isActive, pinNow, setFollowState],
  );

  const endEntryStick = useCallback(() => {
    entryStick.current = false;
    if (entryQuietTimer.current) clearTimeout(entryQuietTimer.current);
    if (entryCapTimer.current) clearTimeout(entryCapTimer.current);
    entryQuietTimer.current = null;
    entryCapTimer.current = null;
  }, []);

  const armEntryQuiet = useCallback(() => {
    if (entryQuietTimer.current) clearTimeout(entryQuietTimer.current);
    entryQuietTimer.current = setTimeout(endEntryStick, ENTRY_QUIET_MS);
  }, [endEntryStick]);

  const beginEntryStick = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    endEntryStick();
    entryStick.current = true;
    entryHeight.current = el.scrollHeight;
    armEntryQuiet();
    entryCapTimer.current = setTimeout(endEntryStick, ENTRY_MAX_MS);
  }, [armEntryQuiet, endEntryStick]);

  const releaseAutoFollow = useCallback(() => {
    endEntryStick();
    if (!scrollRef.current || !canScroll(scrollRef.current)) return;
    setFollowState("released");
    updateButton();
  }, [endEntryStick, setFollowState, updateButton]);

  const goToBottom = useCallback(
    (mode: "instant" | "smooth" = "instant") => {
      pin(true, mode === "smooth" ? "smooth" : "auto");
      updateButton();
    },
    [pin, updateButton],
  );

  const restoreAtLatest = useCallback(() => {
    pin(true);
    beginEntryStick();
    updateButton();
  }, [beginEntryStick, pin, updateButton]);

  // Pin before first paint — a rAF pin paints one frame at the top first,
  // which reads as a flash-then-jump on every session open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionKey is the restore trigger
  useLayoutEffect(() => {
    handlers.current.clear();
    restoreAtLatest();
  }, [sessionKey, restoreAtLatest]);

  useEffect(() => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settlingRef.current = false;
    if (working) {
      if (stateRef.current === "following") pin(true);
      return;
    }
    settlingRef.current = true;
    settleTimer.current = setTimeout(() => {
      settlingRef.current = false;
      settleTimer.current = null;
    }, SETTLE_MS);
  }, [pin, working]);

  useEffect(() => {
    setFollowingProgrammatically(state === "following" && working);
  }, [state, working]);

  useEffect(() => {
    if (!container) return;
    previousTopRef.current = container.scrollTop;
    let lastTouchY: number | null = null;

    const nestedCanConsume = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return false;
      const nested = target.closest<HTMLElement>("[data-scrollable]");
      return Boolean(nested && nested !== container && nested.scrollTop > 0);
    };
    const release = (target?: EventTarget | null) => {
      if (nestedCanConsume(target ?? null)) return;
      releaseAutoFollow();
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) release(event.target);
    };
    const onTouchStart = (event: TouchEvent) => {
      lastTouchY = event.touches.item(0)?.clientY ?? null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches.item(0)?.clientY ?? null;
      if (y !== null && lastTouchY !== null && y > lastTouchY + 2) {
        release(event.target);
      }
      lastTouchY = y;
    };
    const onKey = (event: KeyboardEvent) => {
      if (
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        ["ArrowUp", "PageUp", "Home"].includes(event.key)
      ) {
        release();
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest("[data-overlay-scrollbar-thumb]")
      ) {
        release();
      }
    };
    const onScroll = () => {
      // The browser zeroes scrollTop while display:none and delivers the
      // stray scroll event around reshow, BEFORE ResizeObserver callbacks.
      // Acting on it would save top=0 and flip following → released, landing
      // the reader at the top. Ignore everything until the reshow restore
      // (below, in the ResizeObserver) has run.
      if (hiddenRef.current || container.clientHeight === 0) return;
      lastVisibleTopRef.current = container.scrollTop;
      const previousTop = previousTopRef.current;
      const auto = autoRef.current;
      const programmatic = Boolean(
        auto &&
          now() - auto.at <= AUTO_TTL_MS &&
          Math.abs(container.scrollTop - auto.top) <= 2,
      );
      const next = followStateAfterScroll({
        state: stateRef.current,
        scrollingDown: container.scrollTop > previousTop + 0.5,
        distance: distanceFromBottom(container),
        threshold: bottomZone(mobileRef.current, container.clientHeight),
        programmatic,
        animationGuarded: now() < animationGuardUntil.current,
      });
      previousTopRef.current = container.scrollTop;
      setFollowState(next);
      if (next === "following" && programmatic) pin(false);
      updateButton();
    };

    container.addEventListener("scroll", onScroll, { passive: true });
    container.addEventListener("wheel", onWheel, { passive: true });
    container.addEventListener("touchstart", onTouchStart, { passive: true });
    container.addEventListener("touchmove", onTouchMove, { passive: true });
    container.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      container.removeEventListener("scroll", onScroll);
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
      container.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  }, [container, pin, releaseAutoFollow, setFollowState, updateButton]);

  useEffect(() => {
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      // display:none tab (dockview): freeze all follow logic while hidden,
      // then restore deterministically on reshow — pin if following, else
      // put the reader back where they were.
      if (container.clientHeight === 0) {
        hiddenRef.current = true;
        return;
      }
      if (hiddenRef.current) {
        hiddenRef.current = false;
        if (stateRef.current === "following") pinNow();
        else container.scrollTop = lastVisibleTopRef.current;
        // Resync so the restore write itself never reads as user scrolling.
        previousTopRef.current = container.scrollTop;
        lastVisibleTopRef.current = container.scrollTop;
        updateButton();
        return;
      }
      updateButton();
      if (keyboardAnimating.current) return;
      if (!canScroll(container)) {
        setFollowState("following");
        return;
      }
      if (entryStick.current) {
        const grew = container.scrollHeight > entryHeight.current + 1;
        entryHeight.current = container.scrollHeight;
        pin(true);
        if (grew) armEntryQuiet();
        return;
      }
      if (isActive() && stateRef.current === "following") pin(false);
    });
    observer.observe(container);
    if (container.firstElementChild)
      observer.observe(container.firstElementChild);
    return () => observer.disconnect();
  }, [
    armEntryQuiet,
    container,
    isActive,
    pin,
    pinNow,
    setFollowState,
    updateButton,
  ]);

  // Dockview reparents panel DOM when splits are created or tabs move between
  // groups. A same-frame detach+reattach resets scrollTop to 0 with no
  // ResizeObserver tick and dispatches the stray scroll event before rAF
  // callbacks run. Freeze scroll handling synchronously, then re-apply the
  // remembered state before the frame paints.
  useEffect(() => {
    let frame = 0;
    const onRelayout = () => {
      hiddenRef.current = true;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const el = scrollRef.current;
        // still hidden (tab switched away): the ResizeObserver reshow path
        // finishes the restore when the pane becomes visible again
        if (!el || el.clientHeight === 0) return;
        hiddenRef.current = false;
        if (stateRef.current === "following") pinNow();
        else el.scrollTop = lastVisibleTopRef.current;
        previousTopRef.current = el.scrollTop;
        lastVisibleTopRef.current = el.scrollTop;
        updateButton();
      });
    };
    window.addEventListener(DOCK_RELAYOUT_EVENT, onRelayout);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener(DOCK_RELAYOUT_EVENT, onRelayout);
    };
  }, [pinNow, updateButton]);

  // Capacitor emits these around its visual-viewport keyboard choreography.
  // Stand down during the animation, then perform one deterministic re-pin.
  useEffect(() => {
    const onKeyboardAnimation = (event: Event) => {
      const detail = (event as CustomEvent<{ durationMs?: number }>).detail;
      keyboardAnimating.current = true;
      animationGuardUntil.current =
        now() + (detail?.durationMs ?? 250) + ANIMATION_GUARD_MS;
    };
    const onKeyboardSettled = () => {
      keyboardAnimating.current = false;
      if (stateRef.current === "following") pinNow();
      updateButton();
    };
    window.addEventListener("oc:keyboard-anim", onKeyboardAnimation);
    window.addEventListener("oc:keyboard-settled", onKeyboardSettled);
    return () => {
      window.removeEventListener("oc:keyboard-anim", onKeyboardAnimation);
      window.removeEventListener("oc:keyboard-settled", onKeyboardSettled);
      keyboardAnimating.current = false;
    };
  }, [pinNow, updateButton]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: messageCount is the geometry trigger
  useEffect(() => {
    updateButton();
  }, [messageCount, updateButton]);

  useEffect(() => {
    if (!container || !onActiveTurnChange) return;
    let current: string | null = null;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const top = container.getBoundingClientRect().top + 8;
      const nodes = Array.from(
        container.querySelectorAll<HTMLElement>("[data-turn-id]"),
      );
      const active =
        nodes.find((node) => node.getBoundingClientRect().bottom > top)?.dataset
          .turnId ?? null;
      if (active !== current) {
        current = active;
        onActiveTurnChange(active);
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const mutation = new MutationObserver(schedule);
    mutation.observe(container, { subtree: true, childList: true });
    container.addEventListener("scroll", schedule, { passive: true });
    schedule();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      mutation.disconnect();
      container.removeEventListener("scroll", schedule);
    };
  }, [container, onActiveTurnChange]);

  const notifyContentChange = useCallback(
    (reason?: ContentChangeReason) => {
      if (reason === "animation") {
        animationGuardUntil.current = now() + ANIMATION_GUARD_MS;
      }
      if (entryStick.current) {
        pin(true);
        armEntryQuiet();
      } else if (stateRef.current === "following") {
        pin(false);
      }
      updateButton();
    },
    [armEntryQuiet, pin, updateButton],
  );

  const getAnimationHandlers = useCallback(
    (id: string) => {
      const cached = handlers.current.get(id);
      if (cached) return cached;
      const value = {
        onChunk: () => notifyContentChange("text"),
        onComplete: () => updateButton(),
        onAnimatedHeightChange: () => notifyContentChange("animation"),
      };
      handlers.current.set(id, value);
      return value;
    },
    [notifyContentChange, updateButton],
  );

  useEffect(
    () => () => {
      endEntryStick();
      if (settleTimer.current) clearTimeout(settleTimer.current);
    },
    [endEntryStick],
  );

  return {
    scrollRef,
    state,
    showScrollButton,
    isFollowingProgrammatically,
    goToBottom,
    scrollToBottomOnSend: () => pin(true),
    releaseAutoFollow,
    restoreAtLatest,
    notifyContentChange,
    getAnimationHandlers,
  };
}
