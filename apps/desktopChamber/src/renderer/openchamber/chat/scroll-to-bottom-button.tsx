import { ArrowDown } from "lucide-react";

export function ScrollToBottomButton({
  visible,
  onClick,
}: {
  visible: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label="Scroll to latest message"
      onClick={onClick}
      className={`absolute bottom-3 left-1/2 z-30 flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-background text-foreground shadow-md transition-all duration-200 ${visible ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-2 opacity-0"}`}
    >
      <ArrowDown className="size-4" />
    </button>
  );
}
