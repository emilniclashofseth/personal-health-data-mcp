# Withings terms and trademark notes (checked 23 Oct 2026)

Not legal advice. Every quote below was fetched on 23 Oct 2026 from the URL next to it.

## Verdict
- **Personal use of your own data through the Public API: allowed**, and each user brings their own developer app.
- **Publishing the code as a community plugin: not forbidden**, but because it is "an application intended for other
  users", Withings' partner/API terms apply to it (see 1 and 3).
- **Name: complies with Withings' brand rule.** Withings says "You must not use the Withings name in your application
  name" and asks for "Compatible with Withings" when referring to interoperability. The plugin is named
  "Personal Health Data (community)" (slug `personal-health-data-mcp`) with the tagline "Compatible with Withings";
  Withings appears only in descriptive and compatibility text (see "Naming decision").

## 1. Withings Terms of Use, §6.4 "Sharing Your Data with Third-Party Services" (version of 13 Oct 2026)
URL: https://www.withings.com/en-us/policies/terms-of-service (the old `/us/en/legal/api-terms-of-use` URL redirects here)
- "This article pertains to your use of your own data, whether you are connecting an existing service to your Account
  or developing a tool yourself for your own personal use. If you develop an application intended for other users, or
  if you use the data obtained for purposes other than your own needs, the terms applicable to partners apply and take
  precedence over this article; they are available on the Withings developer portal."
- §6.4.3: "Sharing via API uses a public API, which is configured either by the third-party service or by you; in the
  latter case, a developer account is required, and the associated documentation is available at withings.com."
- §6.4.1: "Sharing with third-party services requires that you have a valid Withings+ subscription. As an exception,
  certain types of sharing with third-party services may be carried out without a Withings+ subscription."
  → The README tells users this.
- §2.12 forbids "data scraping" of the App or Product. This plugin uses only the official Public API, so it is not
  affected.

## 2. Withings developer portal: the Public API is meant for individuals too
- https://developer.withings.com/ : "Start integrating Withings devices into your application with our Public API,
  designed for individuals and partners without a formal contract."
- https://developer.withings.com/developer-guide/v3/integration-guide/public-health-data-api/public-health-data-api-overview :
  "This guide also applies if you: … Want to access your own Withings data through your API."
- https://developer.withings.com/developer-guide/v3/integration-guide/public-health-data-api/developer-account/create-your-accesses-no-medical-cloud :
  "While you can use your personal Withings account, we recommend creating a new account specifically for your
  organization" and the EU Public Cloud has "no prerequisites, and free access is provided."

## 3. Withings Developer Software Agreement / API Terms of Use (English version of 12 Sep 2018, the latest English one listed)
PDF: https://media.withings.com/web/legal/legal-pdf/api-terms-of-use/wo-en-api-terms-of-use-20180912.pdf
(a French version of 24 Apr 2023 also exists: https://media.withings.com/web/legal/legal-pdf/api-terms-of-use/wo-fr-api-terms-of-use-20230424.pdf)
- Definition: "'Application' means one or more software programs developed by You … under Your own trademark or
  brand". → The app each user registers should carry their own name; the README says "Don't call it 'Withings …'".
- §4(i): no Application "(b) which has the primary purpose of capturing or collecting User Content without providing
  the user with additional functionality". → The plugin answers the user's own questions through their agent; it does
  not collect or forward data anywhere.
- §4(v): do not "use the Withings API(s) to issue queries that are not in response to end user actions". → The server
  only calls the API when a tool is called; there is no background polling. (A user's own scheduled routine that asks
  questions is the user's action; keep it to a few calls per run.)
- §4(iii): do not "remove, obscure, modify or omit, any copyright or trademark notices … or branding requirements".
- §5 Privacy: if an Application gives access to user information, "You must provide users with notice about what
  Information is accessible and how such Information will be used". → The README's Tools and Privacy sections do this.
- The restrictions on distributing "the Software" apply to Withings' own SDK/docs/libraries. This plugin contains no
  Withings code or assets; it is an independent MIT-licensed HTTP client.

## 4. Withings name and logo rules (developer portal "Legal Notice")
URL: https://developer.withings.com/sdk/v2/tree/legal-notice/ (it is on the SDK pages but refers to "these guidelines
or the Withings API Agreement", so it is reasonable to treat it as covering API apps too)
- "You may make truthful, factual references to Withings in the plain-text descriptions of your application's features
  and benefits. You must not use the Withings name in your application name or make any other suggestion that your
  application is an official Withings app or is otherwise endorsed by Withings."
- "When referring to interoperability with Withings, you must use one of the following: 'Powered by Withings'
  'Compatible with Withings'"
- "Never use any part of a Withings logo as the icon for your application." → The icon is a neutral scale outline,
  no Withings artwork.
- "In the event of a breach of these rules, Withings reserves the right to terminate the service without notice."

## 5. Technical terms the plugin follows
- Scopes (https://developer.withings.com/developer-guide/v3/integration-guide/public-health-data-api/get-access/oauth-authorization-url):
  `user.info`, `user.metrics`, `user.activity` (read). `user.sleepevents` is only for notifications, so it is not requested.
- Tokens (…/get-access/access-and-refresh-tokens-no-recover): "access_token: Expires after 3 hours", "refresh_token:
  Expires after 1 year", "Old refresh_token: Expires 8 hours after new issuance or once the new access_token is used",
  "Always replace the previous refresh_token with the new one."
- Authorization code: "the authorization code is only valid for 30 seconds."
- Rate (https://developer.withings.com/llms.md): "Do not poll more than once every 10 minutes per user"; status 601 =
  "Too Many Requests".
- Callback URLs: Withings' dashboard message, as quoted by an independent developer
  (https://github.com/Stephaela/PyWithingsAPI): "HTTP URLs, localhost and ports other than 80 or 443 are not supported
  for applications running in production. You may use them during your integration phase but your application will be
  restricted to 10 users." Not verified first-hand (needs a dashboard login). Another project reports localhost being
  refused (https://traceapps.github.io/docs/nutritrace/withings/), so the README offers an HTTPS fallback.

## Naming decision (owner decided 23 Oct 2026)
- Name: **"Personal Health Data (community)"**, slug `personal-health-data-mcp`, tagline **"Compatible with Withings"**
  (Withings' own approved interoperability wording, section 4). "Withings" is not part of the name, slug, MCP server
  id or skill id; it appears only in plain-text descriptions of what the plugin works with.
- Every surface keeps the disclaimer "not made or endorsed by Withings" and the trademark line. No Withings logo.
- If Withings ever objects, contact them via https://support.withings.com/hc and adjust the descriptive text.
