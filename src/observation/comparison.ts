import type { AttributedComparison, Extraction, SourceFile } from "./model.js";
import { compareExtractions } from "./match.js";
import { renderComparison, renderInspection } from "./report.js";
import { emptyNativeExtraction } from "./native-extraction.js";
import type { NativeDialect } from "./native-parser.js";
import type { NativeAnalysisHelper } from "./helper.js";

export type CapturedWorkPair = Readonly<{
  work_id: string; parent_id: string; dialect: NativeDialect;
  input: SourceFile; observed: SourceFile;
}>;

/** Inspect one already-captured source without assigning comparison or work attribution. */
export async function inspectCapturedSource(file: SourceFile, dialect: NativeDialect, helper: NativeAnalysisHelper,
  signal?: AbortSignal): Promise<Readonly<{ extraction: Extraction; text: string }>> {
  const extraction = file.status === "present"
    ? await helper.extract(file, dialect, signal)
    : emptyNativeExtraction(file, dialect);
  return Object.freeze({ extraction, text: renderInspection(extraction) });
}

/** Compose already-authorized, immutable capture identities into a bounded syntax-only report. */
export async function compareCapturedWork(pair: CapturedWorkPair, helper: NativeAnalysisHelper, signal?: AbortSignal): Promise<Readonly<{
  report: AttributedComparison; text: string;
}>> {
  const extract = (file: SourceFile): Promise<Extraction> => file.status === "present"
    ? helper.extract(file, pair.dialect, signal)
    : Promise.resolve(emptyNativeExtraction(file, pair.dialect));
  const [input, observed] = await Promise.all([extract(pair.input), extract(pair.observed)]);
  const report: AttributedComparison = Object.freeze({ work_id: pair.work_id, parent_id: pair.parent_id,
    attribution: "observed_in_work_authorship_not_established", comparison: compareExtractions(input, observed) });
  return Object.freeze({ report, text: renderComparison(report) });
}
