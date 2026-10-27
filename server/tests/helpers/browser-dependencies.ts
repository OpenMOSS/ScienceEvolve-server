import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";
import ts from "typescript";

interface ModuleReference { specifier?: string; location: string }
const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, "")));

/** Inspect syntax, not text in comments/strings. Type-only edges are erased.
 * This covers direct imports/exports/require, not arbitrary loader factories.
 */
function runtimeReferences(file: string): ModuleReference[] {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const references: ModuleReference[] = [];
  const add = (node: ts.Node, value?: ts.Expression) => references.push({
    specifier: value && ts.isStringLiteralLike(value) ? value.text : undefined,
    location: `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`
  });
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const names = clause?.namedBindings;
      const onlyTypes = clause?.isTypeOnly || (!clause?.name && names && ts.isNamedImports(names) &&
        names.elements.length > 0 && names.elements.every(name => name.isTypeOnly));
      if (!onlyTypes) add(node, node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const names = node.exportClause;
      const onlyTypes = node.isTypeOnly || (names && ts.isNamedExports(names) &&
        names.elements.length > 0 && names.elements.every(name => name.isTypeOnly));
      if (!onlyTypes) add(node, node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
      add(node, node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      add(node, node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return references;
}

function checkedSpecifier(reference: ModuleReference): string {
  const specifier = reference.specifier;
  if (specifier === undefined) throw new Error(`${reference.location}: computed module loading cannot establish the browser dependency graph; use a static path`);
  if (specifier.startsWith("node:") || builtins.has(specifier)) {
    throw new Error(`${reference.location}: browser runtime imports Node module ${specifier}; keep it on the host or use an explicit type-only import`);
  }
  return specifier;
}

/** Check local implementation bytes, never follow npm .d.ts as runtime proof. */
export function assertBrowserDependencies(entries: readonly string[], options: ts.CompilerOptions): Set<string> {
  const visited = new Set<string>();
  const visit = (file: string, chain: string[]) => {
    file = path.resolve(file);
    if (/\.d\.[cm]?ts$/.test(file)) {
      throw new Error(`${file}: declaration-only runtime entry cannot prove browser dependencies; use a local implementation or an explicit type-only import`);
    }
    if (visited.has(file)) return;
    visited.add(file);
    for (const reference of runtimeReferences(file)) {
      const specifier = checkedSpecifier(reference);
      const resolution = ts.resolveModuleName(specifier, file, options, ts.sys).resolvedModule;
      if (!resolution || resolution.isExternalLibraryImport || /\.d\.[cm]?ts$/.test(resolution.resolvedFileName)) {
        throw new Error(`${reference.location}: cannot prove browser runtime dependency ${specifier} from local implementation; add a concrete browser check before introducing a package or declaration-only edge (via ${[...chain, file].join(" -> ")})`);
      }
      visit(resolution.resolvedFileName, [...chain, file]);
    }
  };
  entries.forEach(file => visit(file, []));
  return visited;
}

function isWebTestSource(relative: string): boolean {
  return relative.split(path.sep).some(part => part === "test" || part === "__tests__") || /\.test\.[cm]?[jt]sx?$/.test(relative);
}

/** Discover production Web edges, including local bridges outside web/src. */
export function browserServerEntries(webSource: string, serverSource: string, options: ts.CompilerOptions): string[] {
  const entries = new Set<string>();
  const inspected = new Set<string>();
  const webRoot = path.resolve(webSource);
  const webPrefix = webRoot + path.sep;
  const serverPrefix = path.resolve(serverSource) + path.sep;
  const inspect = (file: string) => {
    file = path.resolve(file);
    if (inspected.has(file)) return;
    inspected.add(file);
    for (const reference of runtimeReferences(file)) {
      const specifier = checkedSpecifier(reference);
      const resolution = ts.resolveModuleName(specifier, file, options, ts.sys).resolvedModule;
      const resolved = resolution?.resolvedFileName;
      if (resolved && path.resolve(resolved).startsWith(webPrefix) && isWebTestSource(path.relative(webRoot, resolved))) {
        throw new Error(`${reference.location}: production runtime imports excluded Web test module ${specifier}; move runtime code into production source or use an explicit type-only import`);
      }
      if (resolved && path.resolve(resolved).startsWith(serverPrefix)) entries.add(path.resolve(resolved));
      else if (resolution && !resolution.isExternalLibraryImport) {
        if (/\.d\.[cm]?ts$/.test(resolution.resolvedFileName)) {
          throw new Error(`${reference.location}: declaration-only local runtime dependency ${specifier} cannot prove browser dependencies; use a local implementation or an explicit type-only import`);
        }
        if (/\.[cm]?[jt]sx?$/.test(resolution.resolvedFileName)) inspect(resolution.resolvedFileName);
      } else if (!resolved && specifier.startsWith(".") && path.resolve(path.dirname(file), specifier).startsWith(serverPrefix)) {
        throw new Error(`${reference.location}: unresolved Server dependency ${specifier}`);
      }
    }
  };
  const scan = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!isWebTestSource(path.relative(webRoot, file))) scan(file);
      } else if (/\.[cm]?[jt]sx?$/.test(file) && !isWebTestSource(path.relative(webRoot, file)) && !/\.d\.[cm]?ts$/.test(file)) {
        inspect(file);
      }
    }
  };
  scan(webSource);
  return [...entries].sort();
}
