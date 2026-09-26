import { useEffect, useRef, useState } from "react";
import { smallButton } from "../../lib/ui";
import { IconCheck, IconCopy } from "./Icons";

interface CopyButtonProps {
  value: string;
  label?: string;
  /** `dark` sits on an ink code panel. */
  tone?: "light" | "dark";
}

const darkButton =
  "inline-flex items-center justify-center gap-1.5 rounded-btn border border-white/20 px-2.5 py-1 text-caption font-medium text-white/90 transition-colors duration-200 ease-out hover:border-white/50 hover:text-white";

/** Copies `value`. Clipboard access can be unavailable (insecure context,
 * permission denied), so a failure says how to recover instead of failing
 * silently. */
export default function CopyButton({ value, label = "Copy", tone = "light" }: CopyButtonProps) {
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
    <button type="button" onClick={() => void handleCopy()} className={tone === "dark" ? darkButton : smallButton}>
      {state === "copied" ? <IconCheck size={14} /> : <IconCopy size={14} />}
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Select to copy" : label}</span>
    </button>
  );
}
