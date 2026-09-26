// Authored 16px icon set for the app: one stroke weight (1.5), round caps,
// `currentColor`, so state color always comes from the parent text color.

import type { ReactNode, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 8.5l3 3 6-7" />
  </Svg>
);

export const IconCross = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
  </Svg>
);

export const IconMinus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 8h8" />
  </Svg>
);

export const IconCopy = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 5.5V3.75A1.25 1.25 0 009.25 2.5h-5.5A1.25 1.25 0 002.5 3.75v5.5a1.25 1.25 0 001.25 1.25H5.5" />
  </Svg>
);

export const IconArrowRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 8h9.5M8.5 4l4 4-4 4" />
  </Svg>
);

export const IconArrowLeft = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13 8H3.5M7.5 4l-4 4 4 4" />
  </Svg>
);

export const IconExternal = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 3.5h6.5V10M12.5 3.5L4 12" />
  </Svg>
);

export const IconPause = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 3.5v9M10 3.5v9" />
  </Svg>
);

export const IconPlay = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 3.5l7 4.5-7 4.5z" />
  </Svg>
);

export const IconChevronDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 6l4 4 4-4" />
  </Svg>
);

export const IconRefresh = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12.5 5.5A5 5 0 103 8.5" />
    <path d="M12.75 2.5v3.25H9.5" />
  </Svg>
);

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 3.5v9M3.5 8h9" />
  </Svg>
);

export const IconClock = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 5v3.25l2 1.25" />
  </Svg>
);

/** Round status mark used by checklists: pass / fail / pending / skipped. */
export function StatusMark({ kind }: { kind: "pass" | "fail" | "wait" | "skip" | "todo" }) {
  const ring =
    kind === "pass"
      ? "border-ink bg-ink text-surface"
      : kind === "fail"
        ? "border-refuse bg-refuse text-surface"
        : kind === "wait"
          ? "border-ask bg-ask-wash text-ask-ink"
          : "border-hairline-strong bg-surface text-stone";
  return (
    <span className={`inline-flex size-5 shrink-0 items-center justify-center rounded-full border ${ring}`}>
      {kind === "pass" && <IconCheck size={12} strokeWidth={2} />}
      {kind === "fail" && <IconCross size={12} strokeWidth={2} />}
      {kind === "wait" && <IconClock size={12} />}
      {kind === "skip" && <IconMinus size={12} />}
    </span>
  );
}
