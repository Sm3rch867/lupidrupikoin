# LUPI DRUPI COIN

The main app is served through Firebase Hosting. Coin balances, tap rewards, daily bonuses, skill-puzzle rewards, daily task rewards, and admin actions are handled by the `api` Cloud Function; the browser is not allowed to write Realtime Database data.

## Firebase setup

Requirements for command-line deployment: Node.js 22, npm, and the Firebase CLI.

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

5. Set the Telegram Web App/menu button URL to the deployed Firebase Hosting URL (`https://<project-id>.web.app`). The app requires valid Telegram `initData`. GitHub Pages is suitable only for a static preview: it has no `/api` Cloud Function route, so account loading, coin taps, and daily rewards will not work there.

The five mini-games are skill puzzles with fixed rewards. They never ask for coins, never deduct balances, and never use random payouts. Daily tasks award additional coins for taps and solved puzzles. The server checks puzzle answers and limits each puzzle and task reward to once per day.

The database rules deny all direct client reads and writes. Cloud Functions use the Admin SDK, verify Telegram's signed `initData`, and perform balance changes with Realtime Database transactions. The app's allowed browser origins must be configured before deployment.

Existing balances are preserved during migration, but historical values were written by the old client and cannot be verified retroactively. Review them before treating them as trusted. These coins are virtual arcade points. They cannot be withdrawn or exchanged for money.

## Deploy through GitHub Actions (no local CLI)

The `.github/workflows/firebase-deploy.yml` workflow can install the Firebase CLI and deploy from GitHub, so Node.js and the Firebase CLI are not required on your computer. This still requires access to the Firebase project and the GitHub repository settings.

1. In Firebase Console, use the same project that owns the existing Realtime Database. Enable billing if Firebase requires it for Cloud Functions, and add `TELEGRAM_BOT_TOKEN` under **Build → Functions → Secrets**. The value must be the token for this bot; never put it in the repository.
2. Create a Google Cloud service account for deployments, grant it the permissions needed to deploy Firebase Hosting, Realtime Database rules, and Cloud Functions, and create a JSON key. In the GitHub repository, open **Settings → Secrets and variables → Actions → Secrets** and add the complete JSON key as `FIREBASE_SERVICE_ACCOUNT`. Keep this key private and revoke it if exposed.
3. In the same **Actions** settings, add these repository variables:
   - `FIREBASE_PROJECT_ID`: the Firebase project ID.
   - `ADMIN_IDS`: comma-separated Telegram user IDs for administrators (may be empty).
   - `APP_ORIGINS`: the exact Hosting origin, for example `https://<project-id>.web.app` (no trailing slash).
   - `DATABASE_URL`: the Realtime Database URL for that same project.
4. Ensure this workflow file and the app are in the repository's `main` branch. A push to `main` starts the deployment; you can follow its status under the repository's **Actions** tab.
5. In BotFather, change the Web App/menu button URL from GitHub Pages to `https://<project-id>.web.app`. The app must be opened through that Telegram bot to authenticate.

Do not make the Realtime Database publicly writable to avoid deployment setup: that would let clients change their own or other users' balances.

## Local development

Run the Firebase Hosting, Functions, and Database emulators with the Firebase CLI. For local Functions emulator use, create `functions/.secret.local` with `TELEGRAM_BOT_TOKEN=<your-token>` and add the emulator origin (for example, `http://127.0.0.1:5000`) to `APP_ORIGINS`. Keep that secret file private and untracked. Use a Telegram Web App launch to exercise authentication; a normal browser tab has no trusted Telegram `initData`.

## Repository layout

- `index.html` — Telegram Web App entry point. Keep it in the repository root for Firebase Hosting.
- `assets/css/app.css` — application styles.
- `assets/js/app.js` — Telegram integration and client logic.
- `assets/images/coin.png` — coin artwork.
- `functions/` — Firebase Cloud Function and its dependencies.
- `archive/` — old standalone prototypes and the duplicate legacy copy, kept for reference and excluded from Hosting.

The standalone HTML files in `archive/prototypes/` are old experiments; the current app uses the embedded screens in the root `index.html`.
