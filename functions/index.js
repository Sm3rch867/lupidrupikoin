"use strict";

const { createHmac, timingSafeEqual } = require("node:crypto");
const { initializeApp } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const { defineSecret, defineString } = require("firebase-functions/params");
const { HttpsError, onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");

const telegramBotToken = defineSecret("TELEGRAM_BOT_TOKEN");
const adminIds = defineString("ADMIN_IDS", { default: "" });
const allowedOrigins = defineString("APP_ORIGINS", { default: "" });
const databaseUrl = defineString("DATABASE_URL", { default: "" });

initializeApp();

const MAX_INIT_DATA_AGE_SECONDS = 24 * 60 * 60;
const MAX_ADMIN_GRANT = 1_000_000;
const DAILY_REWARD = 100;
const THEMES = Object.freeze({
  midnight: { price: 0 },
  ocean: { price: 250 },
  orchid: { price: 500 },
  ember: { price: 750 },
});

function database() {
  const configuredUrl = databaseUrl.value();
  return configuredUrl ? getDatabase(undefined, configuredUrl) : getDatabase();
}

function fail(code, message) {
  throw new HttpsError(code, message);
}

function getAdmins() {
  return new Set(adminIds.value().split(",").map((id) => id.trim()).filter(Boolean));
}

function parseInitData(raw, botToken) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 10_000) {
    fail("unauthenticated", "Open the app from Telegram to sign in.");
  }

  const params = new URLSearchParams(raw);
  const entries = [...params.entries()];
  const suppliedHash = params.get("hash");
  if (!suppliedHash || entries.filter(([key]) => key === "hash").length !== 1) {
    fail("unauthenticated", "Invalid Telegram sign-in data.");
  }

  const authDate = Number(params.get("auth_date"));
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(authDate) || authDate > now + 60 || now - authDate > MAX_INIT_DATA_AGE_SECONDS) {
    fail("unauthenticated", "Telegram sign-in data has expired. Reopen the app.");
  }

  const checkString = entries
    .filter(([key]) => key !== "hash")
    .map(([key, value]) => key + "=" + value)
    .sort()
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expectedHash = createHmac("sha256", secretKey).update(checkString).digest();

  const actualHash = Buffer.from(suppliedHash, "hex");
  if (actualHash.length !== expectedHash.length || !timingSafeEqual(actualHash, expectedHash)) {
    fail("unauthenticated", "Invalid Telegram sign-in hash.");
  }

  let profile;
  try {
    profile = JSON.parse(params.get("user") || "");
  } catch {
    fail("unauthenticated", "Invalid Telegram user data.");
  }
  if (!profile || !Number.isSafeInteger(profile.id) || profile.id <= 0) {
    fail("unauthenticated", "Invalid Telegram user ID.");
  }
  return profile;
}

function safeProfileName(profile) {
  return [profile.first_name, profile.last_name]
    .filter((part) => typeof part === "string")
    .join(" ")
    .trim()
    .slice(0, 80) || "Игрок";
}

function newUser(profile, admins) {
  return {
    uid: String(profile.id),
    name: safeProfileName(profile),
    username: typeof profile.username === "string" ? profile.username.slice(0, 32) : "",
    coins: 0,
    totalTaps: 0,
    energy: 100,
    lastEnergyAt: Date.now(),
    nextClaimAt: 0,
    revision: 0,
    isAdmin: admins.has(String(profile.id)),
    ownedThemes: ["midnight"],
    activeTheme: "midnight",
  };
}

function nonNegativeInteger(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function refreshEnergy(user, now) {
  const energy = Number.isInteger(user.energy) ? Math.max(0, Math.min(100, user.energy)) : 100;
  const lastEnergyAt = Number.isFinite(user.lastEnergyAt) ? user.lastEnergyAt : now;
  const restored = Math.floor(Math.max(0, now - lastEnergyAt) / 1000);
  user.energy = Math.min(100, energy + restored);
  user.lastEnergyAt = user.energy === 100 ? now : lastEnergyAt + restored * 1000;
}

function normalizeUser(user, uid, profile, admins, now) {
  user.uid = uid;
  user.name = safeProfileName(profile);
  user.username = typeof profile.username === "string" ? profile.username.slice(0, 32) : "";
  user.coins = nonNegativeInteger(user.coins);
  user.totalTaps = nonNegativeInteger(user.totalTaps);
  user.energy = Number.isInteger(user.energy) ? Math.max(0, Math.min(100, user.energy)) : 100;
  user.lastEnergyAt = Number.isFinite(user.lastEnergyAt) ? Math.max(0, user.lastEnergyAt) : now;
  user.nextClaimAt = Number.isFinite(user.nextClaimAt) ? Math.max(0, user.nextClaimAt) : 0;
  user.revision = nonNegativeInteger(user.revision);
  user.ownedThemes = Array.isArray(user.ownedThemes)
    ? [...new Set(user.ownedThemes.filter((theme) => Object.prototype.hasOwnProperty.call(THEMES, theme)))]
    : ["midnight"];
  if (!user.ownedThemes.includes("midnight")) user.ownedThemes.unshift("midnight");
  if (!user.ownedThemes.includes(user.activeTheme)) user.activeTheme = "midnight";
  if (!Object.prototype.hasOwnProperty.call(THEMES, user.activeTheme)) user.activeTheme = "midnight";
  user.isAdmin = admins.has(uid);
  refreshEnergy(user, now);
  return user;
}

function publicUser(user, admins) {
  return {
    uid: String(user.uid),
    name: String(user.name || "Игрок"),
    username: String(user.username || ""),
    coins: nonNegativeInteger(user.coins),
    totalTaps: nonNegativeInteger(user.totalTaps),
    energy: Math.max(0, Math.min(100, Number(user.energy) || 0)),
    nextClaimAt: Math.max(0, Number(user.nextClaimAt) || 0),
    revision: nonNegativeInteger(user.revision),
    isAdmin: admins.has(String(user.uid)),
    ownedThemes: Array.isArray(user.ownedThemes) ? user.ownedThemes : ["midnight"],
    activeTheme: Object.prototype.hasOwnProperty.call(THEMES, user.activeTheme) ? user.activeTheme : "midnight",
  };
}

async function loadLeaderboard() {
  const snapshot = await database().ref("users").orderByChild("coins").limitToLast(50).once("value");
  const players = [];
  snapshot.forEach((child) => {
    const player = child.val();
    if (player && nonNegativeInteger(player.totalTaps) > 0) {
      players.push({
        name: String(player.name || "Игрок").slice(0, 80),
        coins: nonNegativeInteger(player.coins),
      });
    }
  });
  return players.sort((a, b) => b.coins - a.coins).slice(0, 10);
}

async function adminAction(action, payload, uid, admins) {
  if (!admins.has(uid)) fail("permission-denied", "Недостаточно прав.");
  const targetId = String(payload.targetId || "");
  if (!/^\d+$/.test(targetId)) fail("invalid-argument", "Invalid player ID.");
  const targetRef = database().ref("users/" + targetId);

  if (action === "adminGive") {
    const amount = Number(payload.amount);
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > MAX_ADMIN_GRANT) {
      fail("invalid-argument", "Invalid amount.");
    }
    let updated = false;
    const result = await targetRef.transaction((target) => {
      if (!target || !Number.isSafeInteger(target.coins) || target.coins < 0
        || target.coins + amount > Number.MAX_SAFE_INTEGER) return;
      target.coins += amount;
      target.revision = nonNegativeInteger(target.revision) + 1;
      updated = true;
      return target;
    });
    if (!result.committed || !updated) fail("not-found", "Игрок не найден или баланс нельзя обновить.");
    return { targetId: targetId, amount: amount };
  }

  if (action === "adminWipe") {
    let existed = false;
    const result = await targetRef.transaction((target) => {
      if (!target) return;
      existed = true;
      target.coins = 0;
      target.totalTaps = 0;
      target.energy = 100;
      target.lastEnergyAt = Date.now();
      target.nextClaimAt = 0;
      target.ownedThemes = ["midnight"];
      target.activeTheme = "midnight";
      target.revision = nonNegativeInteger(target.revision) + 1;
      return target;
    });
    if (!result.committed || !existed) fail("not-found", "Игрок не найден.");
    return { targetId: targetId };
  }

  fail("invalid-argument", "Unknown admin operation.");
}

async function updateUser(uid, action, payload, profile, admins) {
  const ref = database().ref("users/" + uid);
  const now = Date.now();
  let output;
  let failure;

  const transaction = await ref.transaction((current) => {
    const user = normalizeUser(
      current && typeof current === "object" ? current : newUser(profile, admins),
      uid, profile, admins, now
    );

    const setResult = (extra) => {
      user.revision += 1;
      output = Object.assign({}, extra || {}, { user: publicUser(user, admins) });
      return user;
    };

    switch (action) {
      case "bootstrap":
        return setResult({});
      case "tap": {
        const requested = Number(payload.count);
        if (!Number.isInteger(requested) || requested < 1 || requested > 10) {
          failure = ["invalid-argument", "Invalid tap batch."];
          return;
        }
        const accepted = Math.min(requested, user.energy);
        if (user.coins > Number.MAX_SAFE_INTEGER - accepted || user.totalTaps > Number.MAX_SAFE_INTEGER - accepted) {
          failure = ["resource-exhausted", "Достигнут максимальный лимит." ];
          return;
        }
        user.energy -= accepted;
        user.coins += accepted;
        user.totalTaps += accepted;
        output = { accepted: accepted };
        return setResult(output);
      }
      case "bonus": {
        if (now < user.nextClaimAt) {
          failure = ["failed-precondition", "Бонус пока недоступен."];
          return;
        }
        if (user.coins > Number.MAX_SAFE_INTEGER - DAILY_REWARD) {
          failure = ["resource-exhausted", "Достигнут максимальный баланс."];
          return;
        }
        user.coins += DAILY_REWARD;
        user.nextClaimAt = now + 24 * 60 * 60 * 1000;
        return setResult({ reward: DAILY_REWARD });
      }
      case "shopBuy": {
        const themeId = String(payload.themeId || "");
        const theme = THEMES[themeId];
        if (!theme) {
          failure = ["invalid-argument", "Неизвестная тема."];
          return;
        }
        if (user.ownedThemes.includes(themeId)) {
          failure = ["already-exists", "Эта тема уже открыта."];
          return;
        }
        if (user.coins < theme.price) {
          failure = ["failed-precondition", "Недостаточно виртуальных монет."];
          return;
        }
        user.coins -= theme.price;
        user.ownedThemes.push(themeId);
        user.activeTheme = themeId;
        return setResult({});
      }
      case "setTheme": {
        const themeId = String(payload.themeId || "");
        if (!Object.prototype.hasOwnProperty.call(THEMES, themeId)) {
          failure = ["invalid-argument", "Неизвестная тема."];
          return;
        }
        if (!user.ownedThemes.includes(themeId)) {
          failure = ["permission-denied", "Сначала открой эту тему."];
          return;
        }
        user.activeTheme = themeId;
        return setResult({});
      }
      default:
        failure = ["invalid-argument", "Unknown operation."];
        return;
    }
  });

  if (failure) fail(failure[0], failure[1]);
  if (!transaction.committed) fail("aborted", "Операцию не удалось сохранить. Попробуй ещё раз.");
  return output;
}

exports.api = onRequest(
  { region: "us-central1", secrets: [telegramBotToken], cors: false, maxInstances: 20 },
  async (request, response) => {
    const origin = request.get("origin");
    const origins = allowedOrigins.value().split(",").map((item) => item.trim()).filter(Boolean);

    if (origin) {
      if (!origins.includes(origin)) {
        response.status(403).json({ error: "Origin is not allowed." });
        return;
      }
      response.set("Access-Control-Allow-Origin", origin);
      response.set("Vary", "Origin");
    }
    response.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    response.set("Access-Control-Allow-Headers", "Content-Type");
    response.set("Cache-Control", "no-store");

    if (request.method === "OPTIONS") {
      response.status(204).send("");
      return;
    }
    if (request.method !== "POST") {
      response.status(405).json({ error: "Method not allowed." });
      return;
    }

    try {
      if (Number(request.get("content-length") || 0) > 12_000) {
        fail("invalid-argument", "Request body is too large.");
      }
      const body = request.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        fail("invalid-argument", "A JSON request body is required.");
      }
      const profile = parseInitData(body.initData, telegramBotToken.value());
      const uid = String(profile.id);
      const admins = getAdmins();

      if (body.action === "leaderboard") {
        response.json({ leaderboard: await loadLeaderboard(), isAdmin: admins.has(uid) });
        return;
      }

      const payload = body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)
        ? body.payload : {};

      if (body.action === "adminGive" || body.action === "adminWipe") {
        response.json(await adminAction(body.action, payload, uid, admins));
        return;
      }

      response.json(await updateUser(uid, body.action, payload, profile, admins));
    } catch (error) {
      if (error instanceof HttpsError) {
        response.status(error.httpErrorCode.status).json({ error: error.message, code: error.code });
        return;
      }
      logger.error("Unhandled API failure", error);
      response.status(500).json({ error: "Сервис временно недоступен. Попробуй позже." });
    }
  }
);