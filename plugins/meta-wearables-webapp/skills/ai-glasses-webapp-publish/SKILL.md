---
name: ai-glasses-webapp-publish
description: Validate and publish a finished Meta Ray-Ban Display glasses web app directly to Vercel production, confirm anonymous HTTPS access, and generate the Meta AI add-to-glasses QR code. No staging or passcode flow.
argument-hint: "[app-directory]"
---

# Publish a Meta glasses web app

Publishing changes external state. Confirm the user requested it, then run:

```sh
node <this-skill>/scripts/publish-to-vercel.mjs <app-directory>
```

The script runs the complete `ai-glasses-webapp-test` gate, verifies Vercel CLI
authentication, deploys with `vercel --prod --yes`, confirms the returned HTTPS
URL is anonymously accessible, and writes `qr-publish.png` with the Meta AI deep
link. It requires Node/npm, Python 3, and an authenticated Vercel CLI.

Before invoking it, complete `ai-glasses-webapp-optimize-performance` against
the production build candidate and retain the cold, warm, A/B, and null-control
results. The deterministic publish gate is not a substitute for the throttled
device-profile measurement.

Do not create `server.js`, preview/staging deployments, `stage-*` aliases,
passcode screens, deployment-protection workarounds, or GitHub deployment
plumbing. If production access is protected, report the exact Vercel setting;
do not weaken unrelated account/team security automatically.

After success show the production URL and QR image, plus phone setup steps.
Existing glasses installations continue using the same URL only when the
deployment reuses the previously linked Vercel project and production domain.
