import type { VercelRequest, VercelResponse } from "@vercel/node";

import { createApp } from "../src/app.js";

const app = createApp();
const ready = app.ready();

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  await ready;
  req.url = (req.url ?? "/").replace(/^\/api(?=\/|$)/, "") || "/";
  app.server.emit("request", req, res);
}
