# Set up Withings (for the first time)

This is not super straightforward, but if you follow the steps exactly it should be fine. It is mostly copy-pasting. The first time takes about 10–15 minutes.

This is an unofficial community plugin, compatible with Withings and not affiliated with, endorsed or sponsored by Withings. It is for general wellness information, not medical advice. It runs on your computer (or your assistant's) and sends nothing to its author.

You do this once. After it works, you just ask about your weight, blood pressure, activity, sleep, or devices.

The plugin cannot see the Withings website, so it cannot click through this for you. An assistant can walk you through it one step at a time: ask it to set up Withings. It should call `setup_guide` and give you **one step, then wait**. The steps below are the same ones, in the same order.

There are no screenshots. Withings changes the wording on its forms. Where this guide names a label, that label comes from Withings' own developer docs or from a widely used write-up of the dashboard (Home Assistant's Withings integration, checked against those docs on 23 Oct 2026). If your screen uses different words, fill the field that means the same thing.

## The one address you will reuse

If you do not have a website, use this callback exactly. Nothing added, nothing removed:

```
http://localhost:8765/callback
```

That is the plugin's default. You do not need to host anything. When the plugin runs on the same computer as your browser, it answers that address itself. Often it does not: a hosted assistant runs the plugin on the assistant's computer, and your browser is on yours. The page then fails to load, and you copy the address bar back to the assistant (step 7). The one-time code in that address stays between you and that assistant. Do not send it to someone else's website.

`localhost` and `127.0.0.1` are not the same. A trailing slash is not the same. `http` and `https` are not the same.

## Before you start

- A Withings account, and the Withings app with your devices already synced.
- Node.js 18 or newer, only if you are running the commands yourself. Cursor's plugin uses the Node.js it already has.
- Withings' terms say that sharing data with a third-party service may require Withings+. If sign-in works but every data request fails, check that.

## 1. Open the Withings developer site

Open https://developer.withings.com/dashboard/ and sign in.

The same Withings account you use in the app is fine. Withings suggests a separate account if you are building something for other people. You are not. If you have no account, create one on that site.

## 2. Create an application

Create an application for yourself.

- Choose the **Public Cloud** (EU). Its API address is `https://wbsapi.withings.net`. Do not choose the US Medical Cloud.
- Choose a **Public API integration**.

Withings' own "Setup your environment" page says that creating an application gives you a client id and a client secret, and that the Public Cloud is free to access. It does not list the buttons. Home Assistant's write-up of the same dashboard describes the next screen as asking for:

- a target environment — choose **development** or **integration** if you see that. That is the mode that can allow a localhost callback. Withings limits how many users that kind of app can have (reports say 10). That is fine, because the only user is you.
- an application name and a short description, in your own words. For example name it "My health data". Do not start the name with "Withings".
- a logo — skip it.

## 3. Register the callback URL

Find the field for where Withings should send your browser after you approve. Withings' API docs call it the **Callback URL**. The form may say **Registered URLs** or **Callback URI**.

Paste exactly:

```
http://localhost:8765/callback
```

Leave `WITHINGS_REDIRECT_URI` empty later, so the plugin keeps using this default.

If the form refuses `localhost` or `http` (some accounts only allow an https address), register an https URL on a site **you** control instead. The page itself can be anything; it does not have to be a program. You will then set `WITHINGS_REDIRECT_URI` to that same string, character for character. Do not use a redirect service run by someone else. The browser is sent there with a one-time code.

## 4. Copy the client id and the secret

Save the application. The page should then show a **Client ID** and a **Secret** (it may say Client Secret or Consumer Secret). Copy both into a note on your own computer. You can open the dashboard later and see them again.

Do not paste the secret into the chat.

## 5. Save those values where the plugin can read them

The plugin has two places it looks. Use one.

**Cursor**

1. Plugins → Personal Health Data (community) → Configure.
2. Paste the Client ID into `WITHINGS_CLIENT_ID`.
3. Paste the Secret into `WITHINGS_CLIENT_SECRET`.
4. Leave `WITHINGS_REDIRECT_URI` empty if you used `http://localhost:8765/callback`. If you registered a different URL, paste that exact URL here.
5. Reload the window. Cursor only gives those values to the plugin when the server process starts. Changing them later does nothing until you reload.

**Anyone else (a file)**

Make a file only you can read and point the server at it with `WITHINGS_ENV_FILE` (an absolute path, no `~`):

```
WITHINGS_CLIENT_ID=the-id-you-copied
WITHINGS_CLIENT_SECRET=the-secret-you-copied
# leave the next line out to use http://localhost:8765/callback
# WITHINGS_REDIRECT_URI=https://your-site.example/callback
```

The server re-reads this file every time you check status or start authorization. You do not need to restart for a change **in the file**. If the same name is also set in the environment (Cursor's Configure box counts), the environment wins and the file is ignored until you clear it and reload. `auth_status` says which one is in use (`redirect_uri_source`) and warns when they disagree (`config_stale_warning`).

Never commit this file. Never put the secret in a chat, a project file, or a screenshot you share.

## 6. Approve access on Withings

Ask the assistant to set up Withings, or run:

```bash
WITHINGS_ENV_FILE=/absolute/path/to/withings.env node server/cli.mjs authorize
```

**Read the callback check before you open the link.** It names the redirect the running server will actually send. It must be the same text you saved in the Withings application. If it says the default `http://localhost:8765/callback`, that is expected when you left `WITHINGS_REDIRECT_URI` empty — as long as the Withings application has that exact callback.

Then open the link, sign in to Withings, and approve. The plugin only asks to read your data (`user.info`, `user.metrics`, `user.activity`).

## 7. Finish within 30 seconds

Withings' code lasts about 30 seconds and works once. It has to reach the **same** server that created the link. Restarting that server in between throws the code away.

**Browser on the same computer as the plugin, callback `http://localhost:8765/callback`.** The page should say you are connected. This step is done.

**Hosted assistant (the usual case).** The plugin runs on the assistant's computer. Your browser is on your own computer. Withings opens `http://localhost:8765/callback` on your computer, where nothing is waiting. The page fails to load. That is expected. Copy the **entire** address from the address bar (it contains `code=` and `state=`) and paste it back to the assistant right away, within 30 seconds. The assistant gives it to this same server.

The same thing happens if the plugin is on any other remote or headless computer (a container, an SSH session). Paste the address back the same way, or paste it at the CLI prompt of the same `authorize` command.

Or, before you approve, forward the port so the page can load: `ssh -L 8765:127.0.0.1:8765 you@server`.

**Your own https callback.** The browser lands on your site. Copy the full address the same way, within 30 seconds, and pass it to `exchange_code`. Your site does not have to understand it.

Do not send that address to anyone else.

## 8. Confirm

Ask the assistant for status, or run `node server/cli.mjs status`.

`authorized` should be true. `redirect_uri` should be the callback you registered. Then ask something like "How has my weight changed this month?"

## If you get this error, do this

**Withings shows `redirect_uri_mismatch`, or "The redirect URI provided is missing or does not match partner callback url".** The link was built with a callback your Withings app does not have. Look at `redirect_uri` in `auth_status` (or the callback check printed before the link). Put that exact string in the Withings callback field and save, **or** set `WITHINGS_REDIRECT_URI` to the string already in Withings. If you changed an environment variable, reload the window. If you only changed the env file, ask for `auth_status` again; it re-reads the file. Then start authorization again. The failed attempt did not give you a usable code.

**You changed the setting, but status still shows `http://localhost:8765/callback`.** Read `redirect_uri_source` and `process_started_at`.

- `default` — `WITHINGS_REDIRECT_URI` is still unset for this process. The env file either does not set it, or could not be read (`env_file_problem`), or an empty plugin setting is hiding it.
- `environment` — the value was copied in when this process started. Reloading the window starts a new process. Editing the env file will not override it. If `config_stale_warning` is set, the file and the environment disagree and the environment is the one in use. The same warning names `WITHINGS_CLIENT_ID` or `WITHINGS_CLIENT_SECRET` when those disagree. It does not print either value.
- `env_file` — the file was read at `config_read_at`. You are looking at the latest contents of the file named by `env_file`.

**`exchange_code` says the code was rejected, or Withings says `invalid code` (status 304).** The code expired, was already used, or went to a different server process. Run `start_authorization` again and paste the new address immediately. Do not retry the old one.

**`exchange_code` says the address you pasted is for a different callback, and the code was not sent.** Good: it was not used up. The message names both URLs. Make them the same (Withings app, or `WITHINGS_REDIRECT_URI`), restart if you changed the environment, then start authorization again.

**The redirect page will not load.** See step 7. That is normal when a hosted assistant runs the plugin and your browser is on your computer. Copy the address bar and paste it back to the assistant right away.

**"Could not listen" / port 8765 is in use.** Free the port, or pick another localhost URL, register that exact URL in Withings, set `WITHINGS_REDIRECT_URI` to it, and restart if you set it in the environment.

**"Not set up yet", or the client id still looks like `${WITHINGS_CLIENT_ID}`.** The app that launched the plugin did not fill in the variables (only Cursor fills `${WITHINGS_…}`). Use an absolute `WITHINGS_ENV_FILE`, or set the plugin fields and reload.

**It used to work, and now the token is rejected.** The refresh token rotates and lasts about a year. Run step 6 again. If two installs share one token file, see the README section "Sharing one token file".

## What the assistant is looking at

`auth_status` and `setup_guide` report, without any secrets:

| Field | Meaning |
|---|---|
| `missing` | Which of `client_id`, `client_secret`, and `token` the server does not have yet. A default callback is not "missing". |
| `checks.redirect_uri` | `default` (the built-in URL) or `explicit` (you set `WITHINGS_REDIRECT_URI`). |
| `redirect_uri` | The callback this process will send to Withings. |
| `redirect_uri_source` | `default`, `environment`, or `env_file`. |
| `redirect_warning` | The sentence to read before opening the Withings link. |
| `config_stale_warning` | Set when the env file has a different callback than the environment. The environment is winning until you restart. |
| `redirect_changed_warning` | Set when the saved token was obtained with a different callback than the one in use now. Existing data calls keep working. |
| `process_started_at` | When this process started. Environment variables are from that moment. |
| `current_step` / `setup_step` | The step the server can verify. Steps on the Withings website stay "unknown" until credentials are saved. |
