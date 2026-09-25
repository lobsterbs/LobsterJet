/* Engine configuration. Overridable at build time via Vite defines so a
   deployment is single-config: set ZL_WISP_URL and rebuild. */

const g = globalThis as typeof globalThis & {
  ZL_WISP_URL?: string;
  location?: Location;
};

/** Wisp server WebSocket endpoint for this deployment. */
export const ZL_WISP_URL: string =
  g.ZL_WISP_URL ??
  ((g.location?.protocol === "https:" ? "wss://" : "ws://") +
    (g.location?.host ?? "localhost:6002") +
    "/wisp/");
