import { LoaderCircle } from "lucide-react";
import { cx } from "./cx.ts";

/** 16px spinner; color follows the adjacent text unless overridden. */
export function Spinner({ className }: { className?: string }) {
  return (
    <LoaderCircle
      role="status"
      aria-label="Loading"
      className={cx("size-4 animate-spin", className)}
    />
  );
}
