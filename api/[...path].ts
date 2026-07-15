import type { VercelRequest, VercelResponse } from "@vercel/node";

import { createApp } from "../src/app.js";

let app: ReturnType<typeof createApp> | undefined;
let ready: ReturnType<ReturnType<typeof createApp>["ready"]> | undefined;

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (!app) {
    app = createApp();
    ready = app.ready();
  }
  const initializedApp = app;
  await ready;
  const url = new URL(req.url ?? "/", "http://localhost");
  const prefix =
    url.searchParams.get("...path") === "documentation"
      ? "/documentation"
      : "/v1";
  const remainder = url.searchParams.get("path");
  url.searchParams.delete("...path");
  url.searchParams.delete("path");
  req.url = `${prefix}${remainder ? `/${remainder}` : ""}${url.search}`;
  initializedApp.server.emit("request", req, res);
}
