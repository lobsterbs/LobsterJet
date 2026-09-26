/* Zeolite extension subsystem: downloads.

   downloads.download() hands the URL to the UI host as a
   zl:downloadOp broadcast; the UI owns the actual save. Download
   state queries and events are absent until the UI reports state
   back — nothing fakes them. */

import type { ExtensionRecord } from "./types";

export interface DownloadOptions {
  url: string;
  filename?: string;
  saveAs?: boolean;
}

export interface DownloadOp {
  op: "download";
  id: number;
  url: string;
  filename?: string;
  saveAs?: boolean;
}

export class DownloadsHost {
  private seq = 0;
  private dispatch: ((op: DownloadOp) => void) | null = null;

  setDispatch(fn: ((op: DownloadOp) => void) | null): void {
    this.dispatch = fn;
  }

  download(ext: ExtensionRecord, opts: DownloadOptions): Promise<number> {
    if (!ext.permissions.includes("downloads")) {
      return Promise.reject(
        new Error("zeolite: permission 'downloads' not granted to this extension"),
      );
    }
    if (!opts || typeof opts.url !== "string") {
      return Promise.reject(new Error("zeolite: downloads.download requires a url"));
    }
    if (!this.dispatch) {
      return Promise.reject(
        new Error("zeolite: no download host attached to this engine"),
      );
    }
    const id = ++this.seq;
    this.dispatch({
      op: "download",
      id,
      url: opts.url,
      filename: opts.filename,
      saveAs: opts.saveAs,
    });
    return Promise.resolve(id);
  }
}

export const DOWNLOADS = new DownloadsHost();
