import { strict as assert } from "node:assert";

export interface Store<T> { value?: T; set(value: T): void; }
export class Box<T> {
    constructor(public value: T) {}
    get(): T { return this.value; }
}
export type Key<T = string> = readonly T[];
export function convert<T>(value: T, flag?: boolean): T;
export function convert<T>(value: T, flag?: boolean): T { return value; }
export const pick = ({x}: {x: number} = {x: 1}, ...rest: number[]): number => x + rest.length;
