// Shared Tailwind class strings for /app and /app/dashboard — one definition
// per control so every screen uses the same shape as the landing's world:
// black primary action, hairline borders, 6px radius, color only for state.

const focusable = "transition-colors duration-200 ease-out disabled:cursor-not-allowed";

export const primaryButton = `inline-flex items-center justify-center gap-2 rounded-btn bg-ink px-[18px] py-[10px] text-body-sm leading-[1.2] font-medium text-surface hover:bg-charcoal disabled:bg-hairline-strong disabled:text-graphite ${focusable}`;

export const outlinedButton = `inline-flex items-center justify-center gap-2 rounded-btn border border-ink px-[18px] py-[10px] text-body-sm leading-[1.2] font-medium text-ink hover:bg-fog disabled:border-hairline-strong disabled:text-stone ${focusable}`;

/** Compact action for rows and toolbars (Copy, Revoke, Retry). */
export const smallButton = `inline-flex items-center justify-center gap-1.5 rounded-btn border border-hairline-strong bg-surface px-3 py-1.5 text-body-sm leading-[1.2] font-medium text-ink hover:border-ink disabled:text-stone ${focusable}`;

export const dangerOutlinedButton = `inline-flex items-center justify-center gap-1.5 rounded-btn border border-refuse/50 bg-surface px-3 py-1.5 text-body-sm leading-[1.2] font-medium text-refuse-ink hover:border-refuse hover:bg-refuse-wash disabled:opacity-60 ${focusable}`;

export const dangerButton = `inline-flex items-center justify-center gap-1.5 rounded-btn bg-refuse-ink px-3 py-1.5 text-body-sm leading-[1.2] font-medium text-surface hover:opacity-90 disabled:opacity-60 ${focusable}`;

export const ghostButton = `inline-flex items-center justify-center gap-1.5 rounded-btn px-3 py-1.5 text-body-sm leading-[1.2] font-medium text-graphite hover:bg-fog hover:text-ink disabled:opacity-60 ${focusable}`;

export const textButton = `inline-flex items-center gap-1.5 text-body-sm font-medium text-ink underline decoration-hairline-strong underline-offset-4 hover:decoration-ink disabled:opacity-60 ${focusable}`;

export const card = "rounded-card border border-hairline bg-surface";

export const inputBase = `w-full rounded-btn border border-hairline-strong bg-surface px-3 py-2.5 text-body text-ink placeholder:text-graphite hover:border-graphite focus:border-ink ${focusable}`;

export const label = "block text-body-sm font-medium text-ink";

export const helpText = "mt-1.5 text-caption text-graphite";

export const errorText = "text-body-sm text-refuse-ink";

export function chipClass(selected: boolean): string {
  return `inline-flex items-center gap-1.5 rounded-sm border px-3 py-1.5 text-body-sm leading-[1.2] ${focusable} ${
    selected ? "border-ink bg-ink text-surface" : "border-hairline-strong bg-surface text-ink hover:border-ink"
  }`;
}
