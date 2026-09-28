/** Metadata of an attached file, shared between the host and the webview. */
export interface AttachmentInfo {
  name: string;
  /** Filesystem path; empty for a clipboard image pasted straight into the chat. */
  path: string;
  size: number;
  isImage: boolean;
  /** Inline data URI for a clipboard image (no file on disk). */
  dataUri?: string;
}
