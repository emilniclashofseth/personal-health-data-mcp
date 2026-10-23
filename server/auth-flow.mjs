// One-time OAuth helper. If the callback URL is http://localhost:<port>/..., listen there (127.0.0.1 only) for up to
// 10 minutes, check `state`, exchange the code at once (Withings codes live 30 s) and save the tokens. Never logs them.
import { createServer } from "node:http";
import { WithingsError } from "./client.mjs";

let pending = null;   // { state, server, timer }
export const pendingState = () => pending?.state ?? null;

function page(title, text) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;margin:3em;max-width:40em"><h2>${title}</h2><p>${text}</p></body>`;
}

export function stopListener() {
  if (!pending) return;
  clearTimeout(pending.timer); pending.server?.close(); pending = null;
}

export async function startAuthorization(client, { timeoutMs = 10 * 60e3, onDone } = {}) {
  stopListener();
  const auth = client.authorizationUrl();
  const cb = new URL(auth.redirect_uri);
  const local = cb.protocol === "http:" && ["localhost", "127.0.0.1"].includes(cb.hostname);
  pending = { state: auth.state, server: null, timer: null };
  if (!local) {
    return {
      authorization_url: auth.url, redirect_uri: auth.redirect_uri, scopes: auth.scopes, listening: false,
      next_step: "Open the URL, approve, then within 30 seconds pass the full URL you land on to exchange_code (or run `node server/cli.mjs authorize`, which asks for it).",
    };
  }
  const port = Number(cb.port) || 80;
  const result = new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const u = new URL(req.url, auth.redirect_uri);
      if (u.pathname !== cb.pathname) { res.writeHead(404).end(); return; }
      const send = (code, title, text) => res.writeHead(code, { "Content-Type": "text/html; charset=utf-8" }).end(page(title, text));
      if (u.searchParams.get("state") !== auth.state) return send(400, "State mismatch", "This response does not belong to the current authorization request. Start again.");
      if (!u.searchParams.get("code")) return send(400, "No code", "Withings did not return a code (access may have been declined).");
      try {
        const r = await client.exchangeCode(u.searchParams.get("code"));
        send(200, "Connected", "Withings access is set up. You can close this tab.");
        stopListener(); resolve({ ok: true, ...r }); onDone?.(null, r);
      } catch (e) {
        send(500, "Setup failed", client.redact(e.message));
        onDone?.(e);
      }
    });
    server.on("error", (e) => { onDone?.(new WithingsError(`Could not listen on ${cb.host}: ${e.code}. Free the port or change WITHINGS_REDIRECT_URI.`, 0)); resolve({ ok: false }); });
    server.listen(port, "127.0.0.1");
    pending.server = server;
    pending.timer = setTimeout(() => { stopListener(); resolve({ ok: false, timeout: true }); }, timeoutMs);
    pending.timer.unref?.();
  });
  return {
    authorization_url: auth.url, redirect_uri: auth.redirect_uri, scopes: auth.scopes, listening: true, listen_minutes: Math.round(timeoutMs / 60e3),
    next_step: "Open the URL in a browser on this computer and approve. The page you land on confirms the setup; then call auth_status.",
    _result: result,
  };
}
