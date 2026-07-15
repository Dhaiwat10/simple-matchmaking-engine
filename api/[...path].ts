import type { VercelRequest, VercelResponse } from "@vercel/node";

import { createApp } from "../src/app.js";

const app = createApp();
const ready = app.ready();

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  await ready;
  const url = new URL(req.url ?? "/", "http://localhost");
  const prefix =
    url.pathname === "/api/documentation" ? "/documentation" : "/v1";
  const remainder = url.searchParams.get("path");
  url.searchParams.delete("path");
  req.url = `${prefix}${remainder ? `/${remainder}` : ""}${url.search}`;
  app.server.emit("request", req, res);
}
