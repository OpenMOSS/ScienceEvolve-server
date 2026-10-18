import path from "node:path";
import { fileURLToPath } from "node:url";
import { armFault, runArmCli } from "./arm-fault.mjs";
export const armR12 = (options) => armFault({ ...options, code: "R12" });
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runArmCli("R12");
