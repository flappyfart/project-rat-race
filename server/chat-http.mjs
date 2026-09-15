import { timingSafeEqual } from "node:crypto";
const json = (res, status, body) => {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(body));
};
const reject = (res, status, code, message) =>
  json(res, status, { error: { code, message } });
export async function serveRatChat(req, res, { chat, chatGatewaySecret } = {}) {
  if (req.method === "GET") {
    if (!chat)
      return reject(res, 503, "unavailable", "chat is not configured.");
    try {
      return json(res, 200, await chat.status());
    } catch {
      return reject(
        res,
        503,
        "unavailable",
        "chat is temporarily unavailable.",
      );
    }
  }
  if (req.method !== "POST") {
    res.setHeader("allow", "GET, POST");
    return reject(
      res,
      405,
      "method_not_allowed",
      "this chat accepts get and post only.",
    );
  }
  const supplied = req.headers["x-rat-chat-gateway"];
  if (
    typeof chatGatewaySecret !== "string" ||
    !/^[a-f0-9]{64}$/.test(chatGatewaySecret) ||
    !chat
  )
    return reject(res, 503, "unavailable", "chat is not configured.");
  if (
    typeof supplied !== "string" ||
    !/^[a-f0-9]{64}$/.test(supplied) ||
    !timingSafeEqual(Buffer.from(supplied), Buffer.from(chatGatewaySecret))
  )
    return reject(
      res,
      403,
      "forbidden",
      "use the chat on the official website.",
    );
  const clientKey = req.headers["x-rat-chat-client"];
  if (typeof clientKey !== "string" || !/^[a-f0-9]{64}$/.test(clientKey))
    return reject(res, 403, "forbidden", "trusted client identity required.");
  if (
    (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase() !==
      "application/json" ||
    req.headers["content-encoding"]
  )
    return reject(
      res,
      415,
      "invalid_content_type",
      "send uncompressed application/json.",
    );
  const MAX = 18000,
    length = req.headers["content-length"];
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX))
    return reject(res, 413, "request_too_large", "chat request is too large.");
  let body, timer;
  try {
    let total = 0;
    const chunks = [];
    timer = setTimeout(() => req.destroy(), 6000);
    for await (const chunk of req) {
      total += chunk.length;
      if (total > MAX)
        return reject(
          res,
          413,
          "request_too_large",
          "chat request is too large.",
        );
      chunks.push(chunk);
    }
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return reject(res, 400, "invalid_payload", "send a valid chat request.");
  } finally {
    clearTimeout(timer);
  }
  try {
    return json(res, 200, await chat.respond(body, { clientKey }));
  } catch (e) {
    if (
      Number.isInteger(e?.status) &&
      e.status >= 400 &&
      e.status <= 599 &&
      typeof e.publicMessage === "string" &&
      typeof e.code === "string"
    ) {
      const retry = Number.isFinite(e.retryAfterSeconds)
        ? Math.max(1, Math.min(86400, Math.ceil(e.retryAfterSeconds)))
        : undefined;
      if (retry) res.setHeader("retry-after", String(retry));
      return json(res, e.status, {
        error: {
          code: e.code,
          message: e.publicMessage,
          ...(retry ? { retryAfterSeconds: retry } : {}),
        },
      });
    }
    return reject(res, 503, "unavailable", "chat is temporarily unavailable.");
  }
}
