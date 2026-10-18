import { inflateRawSync } from "node:zlib";

const MAX_XML_ENTRY_BYTES = 1_000_000;
const MAX_XML_TOTAL_BYTES = 2_000_000;

function decodeEntities(value: string): string {
  return value.replace(/&(#(?:x[0-9a-f]+|[0-9]+)|amp|lt|gt|quot|apos);/gi, (match, entity: string) => {
    if (entity === "amp") return "&";
    if (entity === "lt") return "<";
    if (entity === "gt") return ">";
    if (entity === "quot") return '"';
    if (entity === "apos") return "'";
    if (entity.startsWith("#")) {
      const point = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isInteger(point) && point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point) : "";
    }
    return match;
  });
}

function plainXml(xml: string): string {
  return decodeEntities(xml
    .replace(/<\/(?:w:p|a:p|row|c)>/g, "\n")
    .replace(/<w:tab\b[^>]*\/?\s*>/g, "\t")
    .replace(/<[^>]*>/g, "")
    .replace(/\n{3,}/g, "\n\n")).trim();
}

function xmlParts(zip: Buffer): Map<string, string> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > zip.length) throw new Error("ZIP 中央目录缺失");
  const count = zip.readUInt16LE(end + 10);
  let position = zip.readUInt32LE(end + 16);
  if (count > 10_000 || position >= zip.length) throw new Error("Office 文件目录无效");
  const parts = new Map<string, string>();
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (position + 46 > zip.length || zip.readUInt32LE(position) !== 0x02014b50) throw new Error("Office 文件目录损坏");
    const method = zip.readUInt16LE(position + 10);
    const compressedSize = zip.readUInt32LE(position + 20);
    const uncompressedSize = zip.readUInt32LE(position + 24);
    const nameLength = zip.readUInt16LE(position + 28);
    const extraLength = zip.readUInt16LE(position + 30);
    const commentLength = zip.readUInt16LE(position + 32);
    const localOffset = zip.readUInt32LE(position + 42);
    const next = position + 46 + nameLength + extraLength + commentLength;
    if (next > zip.length) throw new Error("Office 文件目录越界");
    const name = zip.subarray(position + 46, position + 46 + nameLength).toString("utf8");
    position = next;
    if (!/^(?:word\/(?:document|header\d+|footer\d+)\.xml|ppt\/slides\/slide\d+\.xml|xl\/(?:sharedStrings|worksheets\/sheet\d+)\.xml)$/.test(name)) continue;
    if (uncompressedSize > MAX_XML_ENTRY_BYTES || total + uncompressedSize > MAX_XML_TOTAL_BYTES) throw new Error("Office 文本内容过大");
    if (localOffset + 30 > zip.length || zip.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("Office 内容缺失");
    const dataStart = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
    if (dataStart + compressedSize > zip.length) throw new Error("Office 内容越界");
    const compressed = zip.subarray(dataStart, dataStart + compressedSize);
    const raw = method === 0 ? compressed : method === 8
      ? inflateRawSync(compressed, { maxOutputLength: MAX_XML_ENTRY_BYTES })
      : (() => { throw new Error("Office 压缩格式不受支持"); })();
    if (raw.length !== uncompressedSize) throw new Error("Office 内容长度不符");
    total += raw.length;
    parts.set(name, new TextDecoder("utf-8", { fatal: true }).decode(raw));
  }
  return parts;
}

function spreadsheetText(parts: Map<string, string>): string {
  const shared = [...(parts.get("xl/sharedStrings.xml") ?? "").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)]
    .map((match) => [...match[1]!.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((value) => decodeEntities(value[1]!)).join(""));
  const sheets = [...parts.entries()].filter(([name]) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort(([a], [b]) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]));
  return sheets.map(([name, xml]) => {
    const cells = [...xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)].map((match) => {
      const type = /\bt="([^"]+)"/.exec(match[1]!)?.[1];
      const coordinate = /\br="([^"]+)"/.exec(match[1]!)?.[1] ?? "";
      const body = match[2]!;
      const value = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1];
      const text = type === "s" && value !== undefined ? shared[Number(value)] ?? ""
        : type === "inlineStr" ? plainXml(body) : decodeEntities(value ?? "");
      return text ? `${coordinate}: ${text}` : "";
    }).filter(Boolean);
    return `${name}\n${cells.join("\n")}`;
  }).join("\n\n");
}

export function extractOfficeText(buffer: Buffer, extension: ".docx" | ".pptx" | ".xlsx"): string {
  const parts = xmlParts(buffer);
  let result = extension === ".xlsx" ? spreadsheetText(parts)
    : [...parts.entries()].filter(([name]) => extension === ".docx" ? name.startsWith("word/") : name.startsWith("ppt/slides/"))
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
      .map(([name, xml]) => `${name}\n${plainXml(xml)}`).join("\n\n");
  result = result.trim();
  if (!result) throw new Error("Office 文件中没有可读取的文字");
  return result;
}
