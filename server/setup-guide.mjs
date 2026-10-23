// Machine-readable setup script for a non-technical user. No secrets. The human version is docs/SETUP-WITHINGS.md.
// Step order here is the order an assistant should say out loud. The default callback is DEFAULT_REDIRECT.
import { DEFAULT_REDIRECT, DASHBOARD, SETUP_HELP } from "./client.mjs";

export const TONE = "This is not super straightforward, but if you follow the steps exactly it should be fine. It is mostly copy-pasting. The first time takes about 10–15 minutes. Do one step, then stop and wait.";

export const GUIDE_PATH = "docs/SETUP-WITHINGS.md";

const PORTAL = ["withings_account", "create_app", "register_callback", "copy_credentials"];

function callbackInstruction(st) {
  const uri = st.redirect_uri || DEFAULT_REDIRECT;
  if (st.redirect_uri_defaulted) {
    return `Find the field for the callback (Withings' API docs call it the Callback URL; the form may say Registered URLs or Callback URI). Paste exactly this, alone, with no spaces and no slash added at the end:\n${uri}\nYou do not need a website. Leave WITHINGS_REDIRECT_URI empty so this server keeps using that default. Do not use someone else's website or a third-party redirect: the browser is sent there with a one-time code. If the form refuses localhost or http, register an https URL on a site you control instead, then set WITHINGS_REDIRECT_URI to that exact string. localhost and 127.0.0.1 are not the same.`;
  }
  return `Find the field for the callback (Withings' API docs call it the Callback URL; the form may say Registered URLs or Callback URI). This server is already set to the following URL. The field must be exactly that, character for character:\n${uri}\nIt came from ${st.redirect_uri_source === "env_file" ? "your env file" : "the WITHINGS_REDIRECT_URI environment variable"}. Do not use someone else's website. localhost and 127.0.0.1 are not the same.`;
}

export function setupSteps(st) {
  const uri = st.redirect_uri || DEFAULT_REDIRECT;
  return [
    {
      id: "withings_account",
      title: "Open the Withings developer site",
      observable: false,
      advance_when: "The user says they are signed in at the developer dashboard.",
      instruction: `Open ${DASHBOARD} and sign in with a Withings account. The same account you use in the Withings app is fine. If you have no account, create one on that site. This is Withings' website, not this plugin. This server cannot see it.`,
    },
    {
      id: "create_app",
      title: "Create an application",
      observable: false,
      advance_when: "The user says the application exists.",
      instruction: "Create an application for yourself. Choose the Public Cloud (EU, endpoint https://wbsapi.withings.net), not the US Medical Cloud. Choose a Public API integration. If the form asks for a target environment, choose development or integration: that is the mode that can allow a localhost callback, and Withings limits how many users it can have, which is fine because the only user is you. Application name and description in your own words, for example \"My health data\". Do not start the name with \"Withings\". A logo is optional. Withings' own guide does not list the form's button labels (they change); a widely used write-up describes fields for target environment, name, description, and registered URLs. Match by meaning. No screenshots here.",
    },
    {
      id: "register_callback",
      title: "Register the callback URL",
      observable: false,
      advance_when: "The user says the callback field was saved with the exact URL.",
      instruction: callbackInstruction(st),
    },
    {
      id: "copy_credentials",
      title: "Copy the client id and secret",
      observable: false,
      advance_when: "The user says they have copied both values and have not pasted the secret into chat.",
      instruction: "Save the application if you have not already. The page should then show a Client ID and a Secret (it may say Client Secret or Consumer Secret). Copy both into a note on your own computer. You can open the dashboard later to see them again. Do not paste the secret into the chat.",
    },
    {
      id: "save_credentials_locally",
      title: "Save the credentials where the server can read them",
      observable: true,
      advance_when: "auth_status shows client_id_set and client_secret_set, both true.",
      instruction: "Put the Client ID and Secret in the plugin's own settings, not in the conversation. In Cursor: Plugins → Personal Health Data (community) → Configure. Paste the Client ID into WITHINGS_CLIENT_ID and the Secret into WITHINGS_CLIENT_SECRET. " +
        (st.redirect_uri_defaulted
          ? `Leave WITHINGS_REDIRECT_URI empty. The server will use ${uri}, which must be the callback you registered.`
          : `Set WITHINGS_REDIRECT_URI to exactly ${uri} if it is not already.`) +
        " Then reload the window. Environment variables are read only when the server process starts; a reload starts a new one. " +
        "Other apps: put KEY=value lines in a file only you can read (mode 600) and set WITHINGS_ENV_FILE to that file's absolute path. The server re-reads the file on the next setup call, and the file does not override an environment variable of the same name. Never commit the secret.",
    },
    {
      id: "start_authorization",
      title: "Approve access on Withings",
      observable: false,
      advance_when: "The user has opened the link and approved. Then give them finish_authorization even if this step still shows done:false.",
      instruction: `Before anyone opens Withings, read this callback check out loud. ${st.redirect_warning || `redirect_uri=${uri}. It must match the Withings app character for character.`}` +
        (st.config_stale_warning ? ` ${st.config_stale_warning}` : "") +
        " If that URL is not the one saved on the Withings application, stop and fix it (dashboard, or WITHINGS_REDIRECT_URI, then restart if you changed the environment). " +
        "Then run start_authorization, or `node server/cli.mjs authorize`. Open the URL it returns, sign in to Withings, and approve. The plugin only asks to read data.",
    },
    {
      id: "finish_authorization",
      title: "Finish on this server within 30 seconds",
      observable: true,
      advance_when: "auth_status shows authorized:true, or exchange_code returns ok:true.",
      instruction: `If your browser is on the same computer as this plugin and the callback is ${DEFAULT_REDIRECT} (or another localhost URL this server is listening on), the page should say you are connected. You are done with this step. ` +
        "Often they are not on the same computer. A hosted assistant runs this plugin on the assistant's computer, and the user's browser is on their own computer. Withings then opens the localhost page on the user's computer, where nothing is waiting, so the page fails to load. That is expected. Ask them to copy the entire address from the address bar (it contains code= and state=) and paste it back to the assistant right away, within 30 seconds. Pass that paste to exchange_code on this same server. " +
        "The same paste is what to do when the plugin is on any other remote or headless computer, or when they are at the CLI prompt of the same authorize command. " +
        "If the callback is an https URL on their own site, the browser lands there; they copy that full address the same way, within 30 seconds. They should not send the address to anyone else or put it on a third-party site. If more than about 30 seconds pass, or the server was restarted, run start_authorization again. The old code is dead.",
    },
    {
      id: "confirm",
      title: "Confirm",
      observable: true,
      advance_when: "authorized is true and redirect_changed_since_authorization is false.",
      instruction: "Ask for auth_status, or run `node server/cli.mjs status`. authorized should be true, and redirect_uri should be the callback you registered. Then you can ask about weight, blood pressure, activity, sleep, or devices. Results come from Withings and are read-only.",
    },
  ];
}

function doneFor(id, st) {
  const creds = Boolean(st.client_id_set && st.client_secret_set);
  if (PORTAL.includes(id)) return creds ? true : null;
  if (id === "save_credentials_locally") return creds;
  if (id === "start_authorization" || id === "finish_authorization") return Boolean(st.authorized);
  if (id === "confirm") return Boolean(st.authorized) && !st.redirect_changed_since_authorization && !st.config_stale_warning;
  return null;
}

export function setupErrors(st) {
  const uri = st.redirect_uri || DEFAULT_REDIRECT;
  const source = st.redirect_uri_source || "default";
  const started = st.process_started_at || "the time this process started";
  return [
    {
      id: "redirect_uri_mismatch",
      symptom: "Withings shows a raw error redirect_uri_mismatch, or the text \"The redirect URI provided is missing or does not match partner callback url\". Or exchange_code / the CLI says the callback was rejected.",
      do_this: `The live redirect is ${uri} (source: ${source}). In the Withings dashboard, set the Callback URL to that exact string and save. Or set WITHINGS_REDIRECT_URI to the callback already saved there. Environment changes apply only after a restart (this process started at ${started}). An env-file change is re-read on the next auth call unless the environment variable is also set (it wins; config_stale_warning says so). Then run start_authorization again. Do not reuse the failed code.`,
    },
    {
      id: "invalid_or_expired_code",
      symptom: "exchange_code or the CLI says Withings rejected the authorization code, or Withings returns invalid code / status 304.",
      do_this: "The code lasted about 30 seconds, works once, and only works on the same server process that ran start_authorization. Run start_authorization again and pass the new address-bar URL to exchange_code immediately. Do not retry the old code. Restarting the server between the two steps also kills it.",
    },
    {
      id: "redirect_page_will_not_load",
      symptom: "After approving, the browser says it cannot connect, or the localhost page never appears.",
      do_this: `Expected when the browser is not on the same computer as this plugin. That includes a hosted assistant: the plugin runs on the assistant's computer and the browser is on the user's computer, so the localhost page fails to load. Copy the whole address within 30 seconds and paste it back to the assistant, which passes it to exchange_code on the same server that printed the authorization link (callback ${uri}). Or, before you approve, forward the port: ssh -L 8765:127.0.0.1:8765 you@server (use the port in your callback).`,
    },
    {
      id: "stale_process",
      symptom: "You changed the callback or the secret, but auth_status still shows the old redirect_uri.",
      do_this: "Read redirect_uri_source and process_started_at. If the source is environment, this process never saw the new value: reload the MCP client (Cursor: reload the window) so a new process starts. If config_stale_warning is set, the env file and the environment disagree and the environment is winning. If the source is env_file, the file was re-read at config_read_at; check you edited the file named by env_file, and that WITHINGS_REDIRECT_URI is not also set in the environment.",
    },
    {
      id: "port_in_use",
      symptom: "The server says it could not listen on port 8765.",
      do_this: `Free the port, or pick another localhost URL, register that exact URL in the Withings app, set WITHINGS_REDIRECT_URI to it, and restart if you set it in the environment. The default is ${DEFAULT_REDIRECT}.`,
    },
    {
      id: "not_set_up",
      symptom: "A tool says Withings is not set up yet, or the client id still looks like ${WITHINGS_CLIENT_ID}.",
      do_this: "The MCP client passed an unexpanded placeholder, or the credentials are not visible to this process. Use an absolute WITHINGS_ENV_FILE, or set the plugin settings and reload the window. auth_status shows env_file_problem if the file cannot be read. Never paste the secret into chat.",
    },
  ];
}

/** Progress fields shared by auth_status, setup_guide, and the CLI. `st` is Client.status() (no secrets). */
export function assessSetup(st) {
  const missing = [];
  if (!st.client_id_set) missing.push("client_id");
  if (!st.client_secret_set) missing.push("client_secret");
  if (!st.authorized) missing.push("token");
  const checks = {
    client_id: st.client_id_set ? "set" : "missing",
    client_secret: st.client_secret_set ? "set" : "missing",
    redirect_uri: st.redirect_uri_defaulted ? "default" : "explicit",
    token: st.authorized ? "present" : "missing",
  };
  const creds = Boolean(st.client_id_set && st.client_secret_set);
  let current_step;
  if (!creds && st.env_file_problem) current_step = "save_credentials_locally";
  else if (!creds) current_step = "withings_account";
  else if (st.config_stale_warning || st.redirect_changed_since_authorization) current_step = "redirect_attention";
  else if (!st.authorized) current_step = "start_authorization";
  else current_step = "confirm";

  const steps = setupSteps(st).map((s, i) => {
    const done = doneFor(s.id, st);
    return { step: i + 1, ...s, done, inferred: Boolean(done) && PORTAL.includes(s.id) };
  });

  let next_instruction;
  if (current_step === "redirect_attention") {
    next_instruction = st.config_stale_warning || st.redirect_changed_warning;
  } else if (current_step === "save_credentials_locally" && st.env_file_problem) {
    next_instruction = `${st.env_file_problem} ${steps.find((s) => s.id === "save_credentials_locally").instruction}`;
  } else {
    next_instruction = steps.find((s) => s.id === current_step).instruction;
  }

  const next_step = !st.client_configured
    ? (st.env_file_problem ? `${st.env_file_problem} ${SETUP_HELP}` : SETUP_HELP)
    : st.config_stale_warning ? st.config_stale_warning
    : !st.authorized ? `${st.redirect_warning} Next: run start_authorization only after the Withings app's Callback URL is exactly ${st.redirect_uri}. Then approve in the browser. Full script: setup_guide, or ${GUIDE_PATH}.`
    : st.redirect_changed_warning ? st.redirect_changed_warning
    : null;

  return {
    current_step, missing, checks, redirect_action: st.redirect_action ?? null,
    next_instruction, next_step, steps,
    assistant_note: "Tell the user only one step, then wait. This is not super straightforward, but if they follow the steps exactly it should be fine; it is mostly copy-pasting. The first time takes about 10–15 minutes. If a step's done is null, this server cannot see the Withings website: when the user says that step is done, give them the next step even if another setup_guide call still shows the same current_step. Call setup_guide again after they save credentials and after authorization. Before start_authorization, read redirect_warning to them. Never ask them to paste the client secret into chat. When the plugin runs on the assistant's computer and the browser is on the user's, the localhost page fails to load; that is expected, and they paste the full address back right away. The one-time code in that address is not the secret; it goes only to exchange_code on this server.",
  };
}
