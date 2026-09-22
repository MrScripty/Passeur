/** Internal values. A future helper/IPC boundary must decode its own complete wire contract. */
export type ObjectFormat = "sha1" | "sha256";
export type ByteRange = Readonly<{ start_byte: number; end_byte: number }>;
export type GitSource = Readonly<{
  kind: "commit";
  repository_id: string;
  object_format: ObjectFormat;
  commit_oid: string;
  tree_oid: string;
  path: string;
}>;
export type WorkingSource = Readonly<{
  kind: "working_capture";
  repository_id: string;
  object_format: ObjectFormat;
  workspace_id: string;
  workspace_generation: number;
  capture_id: string;
  capture_sequence: number;
  head_anchor: string;
  path: string;
}>;
export type SourceIdentity = GitSource | WorkingSource;
export type SourceFile =
  | Readonly<{ status: "present"; source: SourceIdentity; mode: string;
      content_sha256: string; byte_length: number; text: string;
      consistency: "immutable_git_blob" | "sampled_file_not_atomic"; blob_oid?: string }>
  | Readonly<{ status: "absent_in_commit"; source: GitSource }>
  | Readonly<{ status: "missing_during_capture"; source: WorkingSource }>
  | Readonly<{ status: "non_source"; source: SourceIdentity; entry_kind: "symlink" | "submodule" | "directory" | "special";
      mode?: string; object_oid?: string }>;
export type SourceReference = Readonly<{
  source: SourceIdentity;
  status: SourceFile["status"];
  content_sha256?: string;
  byte_length?: number;
  consistency?: "immutable_git_blob" | "sampled_file_not_atomic";
  mode?: string;
  entry_kind?: "symlink" | "submodule" | "directory" | "special";
  object_oid?: string;
}>;
export type Annotation =
  | Readonly<{ state: "declared"; syntax: string }>
  | Readonly<{ state: "not_declared" }>
  | Readonly<{ state: "unavailable" }>;
export type Declaration = Readonly<{
  key: string;
  kind: string;
  name: string | null;
  enclosing: readonly string[];
  range: ByteRange;
  /** Native declaration text with default/initializer values masked by the extraction owner. */
  signature: string;
  parameters: readonly string[];
  result: Annotation;
  header_complete: boolean;
  /** Direct-body evidence only; an enclosing node must exclude separately reported child edits. */
  body_digest?: string;
  default_digests: readonly string[];
}>;
export type Extraction = Readonly<{
  dialect: string;
  parser_identity: string;
  extractor_identity: string;
  source: SourceReference;
  coverage: "complete" | "incomplete" | "unavailable";
  declarations: readonly Declaration[];
  /** Exact evidence for regions outside the declarations; omitted means no completeness claim. */
  remainder_digest?: string;
  limitations: readonly string[];
}>;
export type DeclarationChange = Readonly<{
  kind: "modified" | "added" | "removed" | "ambiguous" | "unobserved";
  correspondence: "unique_syntax_correspondence" | "unmatched" | "ambiguous";
  input?: Declaration;
  observed?: Declaration;
  declaration_changed: boolean;
  body_changed: boolean;
  default_changed: boolean;
}>;
export type StructuralComparison = Readonly<{
  input: SourceReference;
  observed: SourceReference;
  dialect: string;
  parser_identity: string;
  extractor_identity: string;
  coverage: "complete" | "incomplete" | "unavailable";
  changes: readonly DeclarationChange[];
  region_changed: boolean;
  limitations: readonly string[];
}>;
export type AttributedComparison = Readonly<{
  work_id: string;
  parent_id: string;
  attribution: "observed_in_work_authorship_not_established";
  comparison: StructuralComparison;
}>;
