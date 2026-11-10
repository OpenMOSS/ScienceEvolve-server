import { getArtifactHtmlPreviewUrl, getArtifactViewUrl } from "./api";
import type { Artifact } from "./types";

export function artifactRelativeResourceUrl(projectId: string, artifact: Artifact, reference: string): string {
  const original = reference.trim();
  if (!original || original.startsWith("#") || original.startsWith("/") || /^[a-z][a-z\d+.-]*:/i.test(original)) return reference;
  if (!artifact.agent && !artifact.workspaceId) throw new Error("Artifact relative resource requires an Agent or workspace source");
  const source = new URL(artifact.path.split("/").map(encodeURIComponent).join("/"), "https://project-artifact.invalid/");
  const target = new URL(original, source);
  if (target.origin !== source.origin) return reference;
  const dependency = { ...artifact, path: decodeURIComponent(target.pathname.slice(1)), id: undefined };
  const resource = /\.(?:html?|xhtml)$/i.test(dependency.path)
    ? getArtifactHtmlPreviewUrl(projectId, dependency) : getArtifactViewUrl(projectId, dependency);
  const url = new URL(resource, document.baseURI);
  url.hash = target.hash;
  return url.href;
}
