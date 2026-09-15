const jsonError = (status, code, message) =>
  Response.json(
    { error: { code, message } },
    { status, headers: { "cache-control": "no-store" } },
  );
async function clientDigest(secret, ip) {
  const enc = new TextEncoder(),
    key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    ),
    bytes = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, enc.encode(ip.toLowerCase())),
    );
  return [...bytes].map((n) => n.toString(16).padStart(2, "0")).join("");
}
async function chatPost(context, incoming) {
  const req = context.request,
    secret = context.env?.RAT_CHAT_GATEWAY_SECRET;
  if (typeof secret !== "string" || !/^[a-f0-9]{64}$/.test(secret))
    return jsonError(503, "unavailable", "chat is not configured.");
  if (req.headers.get("origin") !== incoming.origin)
    return jsonError(403, "forbidden", "use the chat on this website.");
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin")
    return jsonError(403, "forbidden", "same origin chat requests only.");
  if (
    (req.headers.get("content-type") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase() !== "application/json" ||
    req.headers.get("content-encoding")
  )
    return jsonError(415, "invalid_content_type", "send application/json.");
  const ip = req.headers.get("cf-connecting-ip");
  if (!ip || !/^[0-9a-f:.]{3,64}$/i.test(ip))
    return jsonError(403, "forbidden", "client identity unavailable.");
  const max = 18000,
    length = req.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > max))
    return jsonError(413, "request_too_large", "chat request is too large.");
  let body;
  try {
    const reader = req.body?.getReader();
    if (!reader)
      return jsonError(400, "invalid_payload", "send a chat request.");
    const chunks = [];
    let size = 0,
      expired = false;
    const deadline = setTimeout(() => {
      expired = true;
      void reader.cancel();
    }, 6000);
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > max)
          return jsonError(
            413,
            "request_too_large",
            "chat request is too large.",
          );
        chunks.push(value);
      }
    } finally {
      clearTimeout(deadline);
      await reader.cancel();
    }
    if (expired)
      return jsonError(408, "request_timeout", "chat request timed out.");
    body = new Uint8Array(size);
    let offset = 0;
    for (const c of chunks) {
      body.set(c, offset);
      offset += c.byteLength;
    }
  } catch {
    return jsonError(400, "invalid_payload", "send a valid chat request.");
  }
  try {
    const r = await fetch("https://api.projectratrace.org/api/rat-chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-rat-chat-gateway": secret,
        "x-rat-chat-client": await clientDigest(secret, ip),
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(35000),
    });
    if (r.status >= 300 && r.status < 400)
      return jsonError(502, "unavailable", "chat gateway unavailable.");
    const headers = new Headers({
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    const retry = r.headers.get("retry-after");
    if (retry && /^\d{1,5}$/.test(retry)) headers.set("retry-after", retry);
    return new Response(r.body, { status: r.status, headers });
  } catch {
    return jsonError(
      503,
      "unavailable",
      "chat reply unavailable. retry the same message without editing to check its result.",
    );
  }
}
export async function onRequest(context) {
  const incoming = new URL(context.request.url);
  if (!/^\/(api(?:\/|$)|work\/|work-content\/)/.test(incoming.pathname))
    return context.next();
  if (
    incoming.pathname === "/api/rat-chat" &&
    !/^[a-f0-9]{64}$/.test(context.env?.RAT_CHAT_GATEWAY_SECRET ?? "")
  )
    return jsonError(503, "unavailable", "chat is not configured.");
  if (
    incoming.pathname === "/api/rat-chat" &&
    context.request.method === "POST"
  )
    return chatPost(context, incoming);
  if (context.request.method !== "GET")
    return new Response("only chat accepts posts", {
      status: 405,
      headers: { allow: "GET", "cache-control": "no-store" },
    });
  const allowed =
    /^\/api\/(status|protocol|history|escape|workshop|internet|economy|browser-frame|work|market|rat-chat)$/.test(
      incoming.pathname,
    ) ||
    /^\/(work|work-content)\/[a-z0-9-]+(?:\/[a-zA-Z0-9_.\/-]*)?$/.test(
      incoming.pathname,
    );
  if (!allowed || incoming.pathname.includes(".."))
    return new Response("not found", { status: 404 });
  const upstream = new URL(
    incoming.pathname + incoming.search,
    "https://api.projectratrace.org",
  );
  try {
    const r = await fetch(upstream, {
      method: "GET",
      headers: { accept: context.request.headers.get("accept") ?? "*/*" },
      redirect: "manual",
      signal: AbortSignal.timeout(12000),
    });
    const headers = new Headers(r.headers);
    headers.set("cache-control", "no-store");
    headers.delete("set-cookie");
    return new Response(r.body, { status: r.status, headers });
  } catch {
    return Response.json(
      {
        error:
          "experiment worker unavailable. no synthetic state is substituted.",
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
