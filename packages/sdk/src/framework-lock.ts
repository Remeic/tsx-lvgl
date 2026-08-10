import { SDK_PACKAGE_NAME } from "./metadata.js";

export interface FrameworkArtifact {
  readonly file: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface FrameworkLock {
  readonly formatVersion: 1;
  readonly package: typeof SDK_PACKAGE_NAME;
  readonly version: string;
  readonly sourceSha: string;
  readonly artifact: FrameworkArtifact;
}
