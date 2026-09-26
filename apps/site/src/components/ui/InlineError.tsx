import { smallButton } from "../../lib/ui";
import { IconRefresh } from "./Icons";

interface InlineErrorProps {
  title: string;
  detail?: string;
  onRetry?: () => void;
}

/** A load or action failure that names the problem and offers the way back. */
export default function InlineError({ title, detail, onRetry }: InlineErrorProps) {
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-refuse/30 bg-refuse-wash px-4 py-3">
      <div className="min-w-0">
        <p className="text-body-sm font-medium text-refuse-ink">{title}</p>
        {detail && <p className="mt-0.5 break-words text-caption text-refuse-ink">{detail}</p>}
      </div>
      {onRetry && (
        <button type="button" onClick={onRetry} className={smallButton}>
          <IconRefresh size={14} />
          Retry
        </button>
      )}
    </div>
  );
}
