import { strict as assert } from "node:assert";

export interface Store<T> { value?: readonly T[]; set(value: T): void; }
export class Box<T> {
    constructor(public value: T) {}
    get(): T { return this.value; }
}
export type Key<T = number> = readonly T[];
export function convert<T>(value: T, flag?: boolean, mode?: "fast"): T;
export function convert<T>(value: T, flag?: boolean, mode?: "fast"): T { return value; }
export const pick = ({x}: {x: number} = {x: 2}, ...rest: number[]): number => x + rest.length + 1;
