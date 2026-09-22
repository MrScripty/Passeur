// Evidence-only transpilation, not a typecheck or production fallback.
const fs = require('node:fs');
const path = require('node:path');
const ts = require(process.env.EVIDENCE_TYPESCRIPT || 'typescript');
const root = process.argv[2];
const out = path.join(root, '.passeur-core');
function walk(dir) {
  for (const entry of fs.readdirSync(dir, {withFileTypes:true})) {
    const file=path.join(dir,entry.name);
    if(entry.isDirectory())walk(file);
    else if(entry.name.endsWith('.ts')) {
      const result=ts.transpileModule(fs.readFileSync(file,'utf8'), {fileName:file, reportDiagnostics:true,
        compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022,verbatimModuleSyntax:true}});
      const errors=(result.diagnostics||[]).filter(x=>x.category===ts.DiagnosticCategory.Error);
      if(errors.length)throw new Error(ts.formatDiagnosticsWithColorAndContext(errors,{getCurrentDirectory:()=>root,getNewLine:()=> '\n',getCanonicalFileName:x=>x}));
      const target=path.join(out,path.relative(root,file)).replace(/\.ts$/,'.js');
      fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,result.outputText);
    }
  }
}
walk(path.join(root,'src'));
fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'package.json'),'{"type":"module"}\n');
console.log('Transpiled selected source files using TypeScript '+ts.version+'; not an application typecheck.');
