# LUPI DRUPI COIN

LUPI DRUPI is a Telegram Mini App built around free skill-based arcade challenges, personal records, virtual coins, daily rewards, and cosmetic themes.

The redesigned app intentionally has no wagers, paid chances, random prize multipliers, cash-outs, or real-money payouts. Virtual coins are earned through the tap interaction and a fixed daily reward, and can only be used to unlock interface themes.

## What's included

- Telegram Web App sign-in verified by Firebase Cloud Functions.
- Server-authoritative virtual coin balance and energy.
- Energy regeneration at one point per second, up to 100.
- Fixed daily reward of 100 virtual coins, available once per 24 hours.
- Cosmetic theme shop: Midnight, Ocean, Orchid, and Ember.
- Four free skill challenges: reaction, memory sequence, mental arithmetic, and visual counting.
- Personal challenge records, XP, and level progress stored locally in the browser.
- Profile, leaderboard, and server-side admin actions.
- Responsive interface designed for Telegram on mobile and desktop.

Challenge XP and personal records are currently stored in the browser used to play. They do not yet sync between devices. The leaderboard ranks users by their virtual coin balance.

## Firebase setup

Requirements: Node.js 22, npm, and the Firebase CLI.

1. Select the Firebase project that owns the existing Realtime Database:

   firebase login
   firebase use --add

2. Configure the function's non-secret parameters. Copy functions/.env.example to functions/.env.<project-id> and set:
   - ADMIN_IDS: comma-separated Telegram user IDs allowed to use admin actions.
   - APP_ORIGINS: comma-separated exact HTTPS origins where the app is hosted.
   - DATABASE_URL: the Realtime Database URL for the selected project.

   Do not commit the project-specific environment file.

3. Add the Telegram bot token to Firebase Secret Manager:

   firebase functions:secrets:set TELEGRAM_BOT_TOKEN

   Never put the bot token in HTML, source control, or chat.

4. Install backend dependencies and deploy:

   npm --prefix functions install
   firebase deploy --only database,functions,hosting

5. Open the deployed Hosting URL from the Telegram bot. The app requires valid Telegram initData; opening the hosted page outside Telegram starts a local demonstration mode that does not change Firebase data.

## Deploy through GitHub Actions

The .github/workflows/firebase-deploy.yml workflow deploys only when changes are pushed to main or when manually started. It requires the following repository configuration:

- GitHub Actions secret FIREBASE_SERVICE_ACCOUNT: a Google Cloud service-account JSON key with Firebase deploy permissions.
- Repository variable FIREBASE_PROJECT_ID: the Firebase project ID.
- Repository variable ADMIN_IDS: comma-separated Telegram user IDs; may be empty.
- Repository variable APP_ORIGINS: exact HTTPS Hosting origin, without a trailing slash.
- Repository variable DATABASE_URL: Realtime Database URL for the same Firebase project.

The workflow adds the Firebase environment parameters at build time. Keep the service-account key and Telegram bot token private.

## Data and security notes

- Realtime Database rules deny direct client reads and writes. All persistent balance changes happen in Cloud Functions transactions.
- Every API request verifies Telegram's signed initData on the server.
- Existing coin balances are kept when a user record is migrated. Some historical balances were written by an older client and cannot be verified retroactively; review them before treating them as trusted.
- Coins are virtual points only. They are not money, cannot be withdrawn, transferred, or redeemed for anything outside the app.
- The old standalone chance-based game pages have been removed from the Hosting output.

## Local development

Run Firebase Hosting, Functions, and Database emulators with the Firebase CLI. For local Functions emulator use, create functions/.secret.local with TELEGRAM_BOT_TOKEN=<your-token> and add the emulator origin (for example, http://127.0.0.1:5000) to APP_ORIGINS. Keep that secret file private and untracked.

A normal browser tab can preview the interface and play the free skill challenges. Persistent account actions require a Telegram Web App launch so that Telegram authentication can be verified.
