import { strict as assert } from "node:assert";
export type Item = number;
export function take(value: Item): Item { return value; }
export const mapper = (x: number = 2): number => x + 2;
