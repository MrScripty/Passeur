import { BridgeError } from "../core/errors.js";
import type { ByteRange } from "./model.js";

/** Map native Node Tree-sitter string indices to offsets in the captured UTF-8 source. */
export class Utf8SourceRanges {
  readonly #offsets: Uint32Array;

  constructor(source: string) {
    this.#offsets = new Uint32Array(source.length + 1);
    let byteOffset = 0;
    for (let index = 0; index < source.length;) {
      this.#offsets[index] = byteOffset;
      const codePoint = source.codePointAt(index)!;
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
        throw new BridgeError("SOURCE_ENCODING_UNSUPPORTED", "Captured source contains an unpaired surrogate");
      }
      const units = codePoint > 0xffff ? 2 : 1;
      if (units === 2) this.#offsets[index + 1] = 0xffffffff;
      byteOffset += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
      index += units;
    }
    this.#offsets[source.length] = byteOffset;
  }

  byteOffset(index: number): number {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.#offsets.length || this.#offsets[index] === 0xffffffff) {
      throw new BridgeError("SOURCE_RANGE_INVALID", "Parser index is outside a UTF-8 codepoint boundary");
    }
    return this.#offsets[index]!;
  }

  byteRange(startIndex: number, endIndex: number): ByteRange {
    const start_byte = this.byteOffset(startIndex), end_byte = this.byteOffset(endIndex);
    if (end_byte < start_byte) throw new BridgeError("SOURCE_RANGE_INVALID", "Parser range ends before it starts");
    return { start_byte, end_byte };
  }
}
