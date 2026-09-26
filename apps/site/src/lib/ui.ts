// Shared Tailwind class strings for the /app flow (P5) — one definition per
// component vocabulary (DESIGN.md "Components") so every screen uses the
// exact same button/card/input shape instead of drifting per-file.

export const primaryButton =
  "inline-flex items-center justify-center gap-1.5 rounded-btn bg-primary px-[15px] py-[7px] text-body-sm font-medium text-white transition-opacity duration-200 ease-out hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";

export const ghostButton =
  "inline-flex items-center justify-center gap-1.5 rounded-btn bg-sky-tint px-[15px] py-[7px] text-body-sm font-medium text-primary transition-opacity duration-200 ease-out hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50";

export const outlinedButton =
  "inline-flex items-center justify-center gap-1.5 rounded-sm border border-black/[0.16] px-[10px] py-[5px] text-body-sm font-medium text-ink/90 transition-colors duration-200 ease-out hover:border-black/30 disabled:cursor-not-allowed disabled:opacity-50";

export const dangerOutlinedButton =
  "inline-flex items-center justify-center gap-1.5 rounded-sm border border-vermillion/40 px-[10px] py-[5px] text-body-sm font-medium text-vermillion transition-colors duration-200 ease-out hover:border-vermillion disabled:cursor-not-allowed disabled:opacity-50";

export const textButton =
  "inline-flex items-center gap-1 text-body-sm font-medium text-ink/95 underline decoration-black/20 underline-offset-2 transition-colors duration-200 ease-out hover:text-primary disabled:cursor-not-allowed disabled:opacity-50";

export const card = "rounded-card border border-black/[0.08] bg-surface p-6 md:p-8";

export const inputBase =
  "w-full rounded-btn border border-black/[0.14] bg-canvas px-3 py-2 text-body text-ink placeholder:text-stone/70 transition-colors duration-200 ease-out focus:border-primary focus:outline-none";

export const label = "mb-1.5 block text-body-sm font-medium text-ink/90";

export const errorText = "text-body-sm text-vermillion";

export const chip =
  "inline-flex items-center gap-1 rounded-full border px-3 py-1 text-body-sm font-medium transition-colors duration-200 ease-out";

export function chipClass(selected: boolean): string {
  return `${chip} ${selected ? "border-primary bg-sky-tint text-primary" : "border-black/[0.14] bg-surface text-ink/70 hover:border-black/30"}`;
}
