import { strict as assert } from "node:assert";
export type Item = string;
export function take(value: Item): Item { return value; }
export const mapper = (x: number = 1): number => x + 1;
