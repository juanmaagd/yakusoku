import { useEffect, useRef, useState } from "react";
import { smallButton } from "../../lib/ui";
import { IconCheck, IconCopy } from "./Icons";

interface CopyButtonProps {
  value: string;
  label?: string;
  /** Names what gets copied when several copy buttons share one screen. */
  ariaLabel?: string;
}

/** Copies `value`. Clipboard access can be unavailable (insecure context,
 * permission denied), so a failure says how to recover instead of failing
 * silently. */
export default function CopyButton({ value, label = "Copy", ariaLabel }: CopyButtonProps) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 2000);
  }

  return (
    <button type="button" onClick={() => void handleCopy()} aria-label={ariaLabel} className={smallButton}>
      {state === "copied" ? <IconCheck size={14} /> : <IconCopy size={14} />}
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Select to copy" : label}</span>
    </button>
  );
}
