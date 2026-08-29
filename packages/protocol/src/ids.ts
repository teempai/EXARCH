import { randomUUID } from "node:crypto";

export type IdPrefix =
  | "project"
  | "conv"
  | "turn"
  | "evt"
  | "snapshot"
  | "decision"
  | "task"
  | "approval"
  | "device"
  | "request"
  | "invitation"
  | "lease"
  | "audit"
  | "history";

export function createId(prefix: IdPrefix): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}
