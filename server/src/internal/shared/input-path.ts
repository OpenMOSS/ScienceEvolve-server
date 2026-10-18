/** Portable relative-path safety with the host filesystem's filename rules. */
export function isValidInputPath(value: unknown, platform: NodeJS.Platform = process.platform): value is string {
  if (typeof value !== "string" || !value || value.length > 1024 || value.includes("\0") ||
    (platform === "win32" && value.includes("\\"))) return false;
  return !value.split("/").some((part) =>
    !part || part === "." || part === ".." || part.length > 255 ||
    (platform === "win32" && (/[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) ||
      /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(part)))
  );
}
