import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { assertBrowserDependencies, browserServerEntries } from "./helpers/browser-dependencies.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

async function fixture(files: Record<string, string>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "science-browser-boundary-")); roots.push(root);
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text);
  }
  const options: ts.CompilerOptions = { moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext, baseUrl: root, paths: { "@shared/*": ["server/src/shared/*"] } };
  return { root, options, file: (relative: string) => path.join(root, relative) };
}

describe("browser-reachable Server dependencies", () => {
  it("checks every actual production Web entry rather than trusting a shared directory name", () => {
    const web = path.resolve(process.cwd(), "../web");
    const config = ts.readConfigFile(path.join(web, "tsconfig.app.json"), ts.sys.readFile);
    expect(config.error).toBeUndefined();
    const options = ts.parseJsonConfigFileContent(config.config, ts.sys, web).options;
    const server = path.resolve(process.cwd(), "src");
    const entries = browserServerEntries(path.join(web, "src"), server, options);
    expect(entries.map(file => path.relative(server, file).split(path.sep).join("/"))).toEqual([
      "internal/shared/agent-permission-metadata.ts", "internal/shared/project-runtime-status.ts", "internal/shared/workflow-loop-validation.ts"
    ]);
    expect(assertBrowserDependencies(entries, options).size).toBeGreaterThanOrEqual(entries.length);
    expect(() => assertBrowserDependencies([path.join(server, "internal/shared/project-explainer.ts")], options)).toThrow(/Node module node:crypto/);
  });

  it.each(["main.ts", "main.mjs", "main.cts"])("follows aliases and re-exports with erased type-only Node references (%s)", async entry => {
    const typeExport = entry.endsWith(".mjs") ? "" : 'export type { Stats } from "./test/types.js";';
    const f = await fixture({
      [`web/src/${entry}`]: `${typeExport} export { value } from "@shared/barrel";`,
      "web/src/test/types.ts": 'export type { Stats } from "node:fs";',
      "server/src/shared/barrel.ts": 'export { value } from "./pure.js";',
      "server/src/shared/pure.ts": 'import type { Stats } from "node:fs"; export type { Stats } from "node:fs"; export type Info = typeof import("node:fs"); export const value = "import(\'node:fs\')";'
    });
    const entries = browserServerEntries(f.file("web/src"), f.file("server/src"), f.options);
    expect(entries).toEqual([f.file("server/src/shared/barrel.ts")]);
    expect(assertBrowserDependencies(entries, f.options).size).toBe(2);
  });

  it("rejects a declaration-only initial runtime entry", async () => {
    const f = await fixture({
      "web/src/main.ts": 'export { value } from "@shared/only";',
      "server/src/shared/only.d.ts": 'export declare const value: string;'
    });
    const entries = browserServerEntries(f.file("web/src"), f.file("server/src"), f.options);
    expect(entries).toEqual([f.file("server/src/shared/only.d.ts")]);
    expect(() => assertBrowserDependencies(entries, f.options)).toThrow(/only\.d\.ts: declaration-only runtime entry/);
  });

  it.each(["test/bridge.ts", "__tests__/bridge.ts", "bridge.test.ts"])("rejects production runtime imports through excluded Web test modules (%s)", async bridge => {
    const f = await fixture({
      "web/src/main.ts": `export { value } from "./${bridge.replace(/\.ts$/, ".js")}";`,
      [`web/src/${bridge}`]: 'export { value } from "@shared/unsafe";',
      "server/src/shared/unsafe.ts": 'import fs from "node:fs"; export const value = fs;'
    });
    expect(() => browserServerEntries(f.file("web/src"), f.file("server/src"), f.options))
      .toThrow(/main\.ts:1: production runtime imports excluded Web test module/);
  });

  it("discovers Server entries through aliased local bridges outside web/src, including cycles", async () => {
    const f = await fixture({
      "web/src/main.ts": 'export { value } from "@bridge/start";',
      "bridge/start.ts": 'export { value } from "./next.js";',
      "bridge/next.ts": 'import "./start.js"; export { value } from "../server/src/shared/pure.js";',
      "server/src/shared/pure.ts": 'export const value = 1;'
    });
    const options = { ...f.options, paths: { ...f.options.paths, "@bridge/*": ["bridge/*"] } };
    const entries = browserServerEntries(f.file("web/src"), f.file("server/src"), options);
    expect(entries).toEqual([f.file("server/src/shared/pure.ts")]);
    expect(assertBrowserDependencies(entries, options)).toEqual(new Set(entries));
  });

  it.each([
    'export { value } from "./server/src/shared/unsafe.js";',
    'export const value = import("./server/src/shared/unsafe.js");',
    'export const value = require("./server/src/shared/unsafe.js");'
  ])("rejects Node through a local runtime bridge outside web/src: %s", async bridge => {
    const f = await fixture({
      "web/src/main.ts": 'export { value } from "../../bridge.js";',
      "bridge.ts": bridge,
      "server/src/shared/unsafe.ts": 'export { readFileSync as value } from "node:fs";'
    });
    const entries = browserServerEntries(f.file("web/src"), f.file("server/src"), f.options);
    expect(entries).toEqual([f.file("server/src/shared/unsafe.ts")]);
    expect(() => assertBrowserDependencies(entries, f.options)).toThrow(/unsafe\.ts:1: browser runtime imports Node module/);
  });

  it("refuses declaration-only local bridges while permitting their erased type references", async () => {
    const f = await fixture({
      "web/src/main.ts": 'export { value } from "../../bridge.js";',
      "bridge.d.ts": 'export declare const value: number; export type Value = number;'
    });
    expect(() => browserServerEntries(f.file("web/src"), f.file("server/src"), f.options))
      .toThrow(/main\.ts:1: declaration-only local runtime dependency/);
    await fs.writeFile(f.file("web/src/main.ts"), 'import type { Value } from "../../bridge.js"; export const value: Value = 1;');
    expect(browserServerEntries(f.file("web/src"), f.file("server/src"), f.options)).toEqual([]);
  });

  it.each([
    'import { readFile } from "node:fs"; export { readFile };',
    'export { readFile } from "fs";',
    'export const load = () => import("node:fs");',
    'export const load = () => require("node:fs");',
    'import fs = require("node:fs"); export { fs };',
    'export { Router } from "express";',
    'export const load = (name: string) => import(name);',
    'export const load = (name: string) => require(name);'
  ])("rejects direct or transitive unsafe runtime syntax: %s", async source => {
    const f = await fixture({
      "web/src/main.ts": 'export * from "@shared/barrel";',
      "server/src/shared/barrel.ts": 'export * from "./unsafe.js";',
      "server/src/shared/unsafe.ts": source
    });
    const entries = browserServerEntries(f.file("web/src"), f.file("server/src"), f.options);
    expect(() => assertBrowserDependencies(entries, f.options)).toThrow(/unsafe\.ts:1/);
  });
});
