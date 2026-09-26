export function spawnSync(
  command: string,
  args: string[],
  options: { encoding: "utf8" },
): { status: number | null; stdout: string; stderr: string };
