#!/usr/bin/env node
// Setup CLI:  node server/cli.mjs authorize | status
// Reads WITHINGS_CLIENT_ID / WITHINGS_CLIENT_SECRET (and optional WITHINGS_REDIRECT_URI, WITHINGS_TOKEN_FILE) from the
// environment, or from the file named by WITHINGS_ENV_FILE. Never prints the secret, the code or the tokens.
import { createInterface } from "node:readline/promises";
import { Client } from "./client.mjs";
import { startAuthorization, stopListener } from "./auth-flow.mjs";

const client = new Client();
const cmd = process.argv[2] || "help";
try {
  if (cmd === "status") {
    console.log(JSON.stringify(await client.status(), null, 2));
  } else if (cmd === "authorize") {
    const r = await startAuthorization(client, { timeoutMs: 10 * 60e3 });
    console.log(`\n1) Open this URL in your browser and approve read-only access:\n\n${r.authorization_url}\n`);
    const expectedState = new URL(r.authorization_url).searchParams.get("state");
    if (r.listening) {
      // Browser on this computer: the listener finishes by itself. Browser elsewhere (headless/remote server): the
      // localhost redirect fails to load there, but its address bar still holds the code, so accept a paste as well.
      console.log(`2) Waiting for Withings to redirect to ${r.redirect_uri} (up to ${r.listen_minutes} min)...`);
      console.log(`   Browser on another computer? The redirect page will not load there. Copy the full address from the\n   address bar and paste it here within 30 seconds, then press Enter.`);
      const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
      const pasted = rl ? rl.question("   Redirect URL (or wait): ").then((answer) => ({ answer })) : new Promise(() => {});
      const first = await Promise.race([r._result.then((out) => ({ out })), pasted]);
      rl?.close();
      let out = first.out;
      if (!out && !String(first.answer || "").trim()) out = await r._result;   // empty Enter: keep waiting for the listener
      else if (!out) { out = await client.exchangeCode(first.answer, { expectedState }); stopListener(); }
      if (!out.ok) { console.error(out.timeout ? "Timed out. Run authorize again." : "Authorization failed (see the browser tab)."); process.exit(1); }
      console.log(`Done. Tokens saved to ${out.token_file} (mode 600). Scopes: ${out.scope}.`);
    } else {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question("2) Paste the full URL you were redirected to (do it within 30 seconds): ");
      rl.close();
      const out = await client.exchangeCode(answer, { expectedState });
      console.log(`Done. Tokens saved to ${out.token_file} (mode 600). Scopes: ${out.scope}.`);
    }
    process.exit(0);
  } else {
    console.log("Personal Health Data (community) setup. Compatible with Withings; not made or endorsed by Withings.\nUsage: node server/cli.mjs authorize   one-time browser authorization (re-run to re-authorize)\n       node server/cli.mjs status      show setup status (no secrets)");
  }
} catch (e) {
  console.error(client.redact(e.message)); process.exit(1);
}
