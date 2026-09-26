import type { ReactNode } from "react";

interface EmptyStateProps {
  /** One of `public/art/app/*.webp` (1-bit stipple, transparent). */
  art: string;
  title: string;
  body: ReactNode;
  children?: ReactNode;
}

/** An empty state that teaches the next step instead of saying "nothing here". */
export default function EmptyState({ art, title, body, children }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center md:py-16">
      <img src={art} alt="" width={1024} height={1024} loading="lazy" decoding="async" className="size-28 md:size-32" />
      <h2 className="mt-4 text-subheading font-medium text-ink">{title}</h2>
      <p className="mt-2 max-w-[46ch] text-body-sm text-graphite">{body}</p>
      {children && <div className="mt-6 flex w-full max-w-[560px] flex-col items-center gap-3">{children}</div>}
    </div>
  );
}
