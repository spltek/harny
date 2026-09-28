/** Metadata of an attached file, shared between the host and the webview. */
export interface AttachmentInfo {
  name: string;
  /** Filesystem path; empty for a clipboard image pasted straight into the chat. */
  path: string;
  size: number;
  isImage: boolean;
  /** Inline data URI for a clipboard image (no file on disk). */
  dataUri?: string;
  /** Inline text for a clipboard text file (no file on disk). */
  content?: string;
}

/** One user attachment resolved for forwarding to a sub-agent. The order in a
 * request's `AttachmentPart[]` matches the numbered `[User attachments]` list
 * the orchestrator sees, so it can pick per-sub-task. */
export interface AttachmentPart {
  name: string;
  isImage: boolean;
  /** Inline data URI (images). */
  dataUri?: string;
  /** Inline text (text files). */
  text?: string;
}
