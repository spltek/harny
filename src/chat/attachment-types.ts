/** Metadata of an attached file, shared between the host and the webview. */
export interface AttachmentInfo {
  name: string;
  path: string;
  size: number;
  isImage: boolean;
}
