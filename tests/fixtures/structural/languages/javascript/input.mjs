// café 😀
import metadata from "./data.json" with { type: "json" };
export { value } from "./other.mjs";
export async function* stream({limit = 2}, ...rest) { yield limit; }
export const twice = (n = 1) => n * 2;
class Box { field = "secret"; #private = 2; open(x = 3) { return x; } }
