export const PUBLISHED_ARTIFACT_MANIFEST_FILENAME = "published-artifacts.json";
export const PUBLISHED_ARTIFACT_MANIFEST_ENV =
  "SCIENCEEVOLVE_PUBLISHED_ARTIFACT_MANIFEST";
export const READ_PUBLISHED_ARTIFACT_TOOL =
  "scienceevolve_read_published_artifact";
export const MAX_PUBLISHED_ARTIFACT_CHUNK_BYTES = 64 * 1024;

export interface PublishedArtifactAccessEntry {
  id: string;
  agent: string;
  path: string;
  title: string;
  kind: string;
  description: string;
  size: number;
  mediaType: string;
  modifiedAt?: string;
  registeredAt?: string;
  sha256: string;
  /** Server-only invocation-snapshot paths consumed by the injected MCP. */
  workspaceRoot: string;
  sourcePath: string;
}

export interface PublishedArtifactAccessManifest {
  schemaVersion: 1;
  projectId: string;
  invocationId: string;
  createdAt: string;
  artifacts: PublishedArtifactAccessEntry[];
}
