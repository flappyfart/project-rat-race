export async function onRequest(context) {
  const incoming = new URL(context.request.url);
  if (!/^\/(api(?:\/|$)|work\/|work-content\/)/.test(incoming.pathname))
    return context.next();
  if (context.request.method !== "GET")
    return new Response("read only", {
      status: 405,
      headers: { allow: "GET", "cache-control": "no-store" },
    });
  const allowed =
    /^\/api\/(status|protocol|history|escape|workshop|internet|economy|browser-frame|work|market)$/.test(
      incoming.pathname,
    ) ||
    /^\/(work|work-content)\/[a-z0-9-]+(?:\/[a-zA-Z0-9_.\/-]*)?$/.test(
      incoming.pathname,
    );
  if (!allowed || incoming.pathname.includes(".."))
    return new Response("not found", { status: 404 });
  const configured = context.env?.PUBLIC_API_ORIGIN;
  if (!configured)
    return Response.json(
      { error: "operator API origin not configured" },
      { status: 503 },
    );
  const origin = new URL(configured);
  if (origin.protocol !== "https:" || origin.username || origin.password)
    throw Error("invalid public API origin");
  const upstream = new URL(incoming.pathname + incoming.search, origin);
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
