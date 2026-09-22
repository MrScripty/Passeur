import { git } from "./project.js";

export type WorktreeEntry = { path: string; head?: string; branch?: string; locked?: boolean; prunable?: boolean };
export async function worktreeEntries(root: string, signal?: AbortSignal): Promise<WorktreeEntry[]> {
  const tokens = (await git(root, ["worktree", "list", "--porcelain", "-z"], signal)).split("\0");
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;
  for (const token of tokens) {
    if (token.startsWith("worktree ")) { current = { path: token.slice(9) }; entries.push(current); }
    else if (current && token.startsWith("HEAD ")) current.head = token.slice(5);
    else if (current && token.startsWith("branch ")) current.branch = token.slice(7);
    else if (current && (token === "locked" || token.startsWith("locked "))) current.locked = true;
    else if (current && (token === "prunable" || token.startsWith("prunable "))) current.prunable = true;
  }
  return entries;
}
