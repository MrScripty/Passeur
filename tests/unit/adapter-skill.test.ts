import { readFile, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { expect, it } from "vitest";
for(const name of ["passeur-bridge","passeur-agent-adapter"])it(`${name} is structurally discoverable with valid local links`,async()=>{
  const path=resolve(".agents/skills",name,"SKILL.md"),text=await readFile(path,"utf8");
  expect(text.startsWith(`---\nname: ${name}\n`)).toBe(true);expect(text).toMatch(/description: .+/);
  for(const match of text.matchAll(/\]\(([^)]+)\)/g))if(!match[1]!.includes("://"))await access(resolve(dirname(path),match[1]!.split("#")[0]!));
  expect(text).toContain("Passeur");
});
// This structural test is deliberately not described as a fresh-session behavioral evaluation.
