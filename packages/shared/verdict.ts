import { z } from "zod";

/**
 * The firewall's only three possible outputs (plan-tecnico.md §2.4 "Nunca":
 * any doubt falls to the safe side — `refuse` or `ask_human`, never `pay`).
 */
export const VERDICTS = ["pay", "refuse", "ask_human"] as const;
export type Verdict = (typeof VERDICTS)[number];
export const verdictSchema = z.enum(VERDICTS);
