import { List, LoaderCircle, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PromptNavigatorPrompt } from "./prompt-navigator-rail.tsx";

export function MobilePromptNavigator({
  prompts,
  activeTurnId,
  loadingPromptId,
  onSelectTurn,
}: {
  prompts: readonly PromptNavigatorPrompt[];
  activeTurnId: string | null;
  loadingPromptId: string | null;
  onSelectTurn: (messageId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const activeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) activeRef.current?.scrollIntoView({ block: "center" });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const back = (event: Event) => {
      event.preventDefault();
      setOpen(false);
    };
    window.addEventListener("agena:native-back", back);
    return () => window.removeEventListener("agena:native-back", back);
  }, [open]);

  if (prompts.length < 2) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="absolute right-3 top-3 z-20 flex min-h-11 items-center gap-2 rounded-full border border-border bg-raised/95 px-3 text-xs font-medium text-muted-foreground shadow-lg backdrop-blur"
        aria-label={`Browse all ${prompts.length} prompts`}
      >
        <List className="size-4" />
        {prompts.length}
      </button>
      {open ? (
        <div className="absolute inset-0 z-40 flex flex-col bg-background/98 pt-[env(safe-area-inset-top,0px)]">
          <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border px-4">
            <strong className="min-w-0 flex-1 text-sm">
              All prompts · {prompts.length}
            </strong>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="flex size-11 items-center justify-center rounded-full text-muted-foreground active:bg-interactive-active"
              aria-label="Close prompt navigator"
            >
              <X className="size-5" />
            </button>
          </header>
          <nav
            className="min-h-0 flex-1 overflow-y-auto p-3"
            aria-label="All prompts"
          >
            {prompts.map((prompt, index) => {
              const active = prompt.messageId === activeTurnId;
              const loading = prompt.messageId === loadingPromptId;
              return (
                <button
                  ref={active ? activeRef : undefined}
                  key={prompt.messageId}
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onSelectTurn(prompt.messageId);
                  }}
                  className={`mb-2 flex min-h-14 w-full items-center gap-3 rounded-xl border px-3 py-2 text-left ${active ? "border-primary/50 bg-interactive-active" : "border-border bg-raised active:bg-interactive-hover"}`}
                  aria-current={active ? "true" : undefined}
                >
                  <span className="w-7 shrink-0 text-center text-xs tabular-nums text-fg-faint">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 line-clamp-2 text-sm leading-5 text-muted-foreground">
                    {prompt.preview.trim() || "No text content"}
                  </span>
                  {loading ? (
                    <LoaderCircle className="size-4 shrink-0 animate-spin text-primary" />
                  ) : prompt.loaded === false ? (
                    <span className="shrink-0 text-[10px] text-fg-faint">
                      Load
                    </span>
                  ) : null}
                </button>
              );
            })}
          </nav>
        </div>
      ) : null}
    </>
  );
}
