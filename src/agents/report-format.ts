/** The assignment prompt and runtime decoder share this owned message identity. */
export const REPORT_MARKER = "PASSEUR_MESSAGE";
export const workerMessageInstructions = `Finish each turn with ${REPORT_MARKER} followed by exactly one JSON object. For a completed assignment use:
{"schema_version":2,"kind":"final","summary":"outcome","assessment":"met|partial|unmet|unknown","blockers":[],"questions":[],"checks":[],"no_changes_reason":"only when applicable"}.
For a factual question use {"schema_version":2,"kind":"input_required","question":"exact question"} and await the owner's reply in the same session.
For an assignment that cannot proceed use {"schema_version":2,"kind":"blocked","reason":"the actual terminal blocker"}.
A quiet period or completed conversational turn is not assignment completion. Use normal native human approvals for protected operations; a factual reply grants no permission.`;
