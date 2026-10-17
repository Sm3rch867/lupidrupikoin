# LUPI DRUPI COIN

The main app is served through Firebase Hosting. Coin balances, tap rewards, bonuses, game outcomes, and admin actions are handled by the `api` Cloud Function; the browser is not allowed to write Realtime Database data.

## Firebase setup

Requirements: Node.js 22, npm, and the Firebase CLI.

1. Select the Firebase project that owns the existing Realtime Database:

   ```powershell
   firebase login
   firebase use --add
   ```

2. Configure the function's non-secret parameters. Copy `functions/.env.example` to `functions/.env.<project-id>` and set:
   - `ADMIN_IDS`: comma-separated Telegram user IDs allowed to use admin actions.
   - `APP_ORIGINS`: comma-separated exact HTTPS origins where the app is hosted.
   - `DATABASE_URL`: the Realtime Database URL for the selected project.

   Do not commit the project-specific environment file.

3. Add the Telegram bot token to Firebase Secret Manager. Do not put it in HTML, source control, or chat:

   ```powershell
   firebase functions:secrets:set TELEGRAM_BOT_TOKEN
   ```

4. Install backend dependencies and deploy:

   ```powershell
   npm --prefix functions install
   firebase deploy --only database,functions,hosting
   ```

5. Open the deployed Hosting URL from the Telegram bot. The app requires valid Telegram `initData`; opening the HTML directly is intentionally unsupported.

The database rules deny all direct client reads and writes. Cloud Functions use the Admin SDK, verify Telegram's signed `initData`, and perform balance changes with Realtime Database transactions. The app's allowed browser origins must be configured before deployment.

Existing balances are preserved during migration, but historical values were written by the old client and cannot be verified retroactively. Review them before treating them as trusted. These coins are still virtual; do not use this setup for real-money gambling or payouts.

## Local development

Run the Firebase Hosting, Functions, and Database emulators with the Firebase CLI. For local Functions emulator use, create `functions/.secret.local` with `TELEGRAM_BOT_TOKEN=<your-token>` and add the emulator origin (for example, `http://127.0.0.1:5000`) to `APP_ORIGINS`. Keep that secret file private and untracked. Use a Telegram Web App launch to exercise authentication; a normal browser tab has no trusted Telegram `initData`.

`crypto.html`, `dice.html`, `doors.html`, `mines.html`, and `plinko.html` are standalone prototype pages. The protected, persistent game implementation is the one embedded in `index.html`.
