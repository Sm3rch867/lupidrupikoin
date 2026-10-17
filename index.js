"use strict";

const { createHmac, randomInt, timingSafeEqual } = require("node:crypto");
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

function database() {
  const configuredUrl = databaseUrl.value();
  return configuredUrl ? getDatabase(undefined, configuredUrl) : getDatabase();
}

const MAX_INIT_DATA_AGE_SECONDS = 60 * 60 * 24;
const MAX_BET = 1_000_000;
const MIN_BET = 1;
const MINE_REWARDS = [1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000];
const PLINKO_MULTIPLIERS = [5, 2, 0.5, 0.2, 0.5, 2, 5];

function fail(code, message) {
  throw new HttpsError(code, message);
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
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expectedHash = createHmac("sha256", secretKey).update(checkString).digest();

  let actualHash;
  try {
    actualHash = Buffer.from(suppliedHash, "hex");
  } catch {
    fail("unauthenticated", "Invalid Telegram sign-in hash.");
  }
  if (actualHash.length !== expectedHash.length || !timingSafeEqual(actualHash, expectedHash)) {
    fail("unauthenticated", "Invalid Telegram sign-in hash.");
  }

  let user;
  try {
    user = JSON.parse(params.get("user") || "");
  } catch {
    fail("unauthenticated", "Invalid Telegram user data.");
  }
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) {
    fail("unauthenticated", "Invalid Telegram user ID.");
  }
  return user;
}

function newUser(profile, admins) {
  const user = {
    uid: String(profile.id),
    name: [profile.first_name, profile.last_name].filter(Boolean).join(" ").slice(0, 80) || "Игрок",
    username: typeof profile.username === "string" ? profile.username.slice(0, 32) : "none",
    coins: 0,
    totalTaps: 0,
    miniGamesWon: 0,
    miniGamesProfit: 0,
    rewardStreak: 0,
    wheelSpins: 0,
    energy: 100,
    lastEnergyAt: Date.now(),
    nextClaimAt: 0,
    lastClaimAt: 0,
    isAdmin: admins.has(String(profile.id)),
  };
  return user;
}

function getAdmins() {
  return new Set(adminIds.value().split(",").map((id) => id.trim()).filter(Boolean));
}

function refreshEnergy(user, now) {
  const energy = Number.isInteger(user.energy) ? Math.max(0, Math.min(100, user.energy)) : 100;
  const lastEnergyAt = Number.isFinite(user.lastEnergyAt) ? user.lastEnergyAt : now;
  const restored = Math.floor(Math.max(0, now - lastEnergyAt) / 1000);
  user.energy = Math.min(100, energy + restored);
  user.lastEnergyAt = user.energy === 100 ? now : lastEnergyAt + restored * 1000;
}

function publicGameState(activeGame) {
  if (!activeGame) return null;
  if (activeGame.type === "mines") {
    return {
      type: "mines",
      bet: activeGame.bet,
      mineCount: activeGame.mineCount,
      opened: activeGame.opened,
      multiplier: activeGame.multiplier,
    };
  }
  if (activeGame.type === "doors") {
    return {
      type: "doors",
      bet: activeGame.bet,
      room: activeGame.room,
      multiplier: activeGame.multiplier,
    };
  }
  return null;
}

function publicUser(user, admins) {
  return {
    uid: String(user.uid),
    name: String(user.name || "Игрок"),
    username: String(user.username || "none"),
    coins: Math.max(0, Number(user.coins) || 0),
    totalTaps: Math.max(0, Number(user.totalTaps) || 0),
    miniGamesWon: Math.max(0, Number(user.miniGamesWon) || 0),
    miniGamesProfit: Number(user.miniGamesProfit) || 0,
    rewardStreak: Math.max(0, Number(user.rewardStreak) || 0),
    wheelSpins: Math.max(0, Number(user.wheelSpins) || 0),
    energy: Math.max(0, Math.min(100, Number(user.energy) || 0)),
    nextClaimAt: Math.max(0, Number(user.nextClaimAt) || 0),
    revision: Math.max(0, Number(user.revision) || 0),
    isAdmin: admins.has(String(user.uid)),
    activeGame: publicGameState(user.activeGame),
  };
}

function validateBet(value) {
  const bet = Number(value);
  if (!Number.isSafeInteger(bet) || bet < MIN_BET || bet > MAX_BET) {
    fail("invalid-argument", `Bet must be an integer between ${MIN_BET} and ${MAX_BET}.`);
  }
  return bet;
}

function validateIndex(value, max) {
  if (!Number.isInteger(value) || value < 0 || value >= max) {
    fail("invalid-argument", "Invalid game selection.");
  }
  return value;
}

async function updateUser(uid, action, payload, profile, admins) {
  const ref = database().ref(`users/${uid}`);
  const now = Date.now();
  let result;
  let failure;

  const transaction = await ref.transaction((current) => {
    const user = current && typeof current === "object" ? current : newUser(profile, admins);
    user.uid = uid;
    user.name = [profile.first_name, profile.last_name].filter(Boolean).join(" ").slice(0, 80) || "Игрок";
    user.username = typeof profile.username === "string" ? profile.username.slice(0, 32) : "none";
    user.isAdmin = admins.has(uid);
    user.coins = Number.isSafeInteger(user.coins) && user.coins >= 0 ? user.coins : 0;
    user.totalTaps = Number.isSafeInteger(user.totalTaps) && user.totalTaps >= 0 ? user.totalTaps : 0;
    user.miniGamesWon = Number.isSafeInteger(user.miniGamesWon) && user.miniGamesWon >= 0 ? user.miniGamesWon : 0;
    user.miniGamesProfit = Number.isSafeInteger(user.miniGamesProfit) ? user.miniGamesProfit : 0;
    user.rewardStreak = Number.isSafeInteger(user.rewardStreak) && user.rewardStreak >= 0 ? user.rewardStreak : 0;
    user.wheelSpins = Number.isSafeInteger(user.wheelSpins) && user.wheelSpins >= 0 ? user.wheelSpins : 0;
    user.nextClaimAt = Number.isFinite(user.nextClaimAt) ? Math.max(0, user.nextClaimAt) : 0;
    user.lastClaimAt = Number.isFinite(user.lastClaimAt) ? Math.max(0, user.lastClaimAt) : 0;
    user.revision = Number.isSafeInteger(user.revision) && user.revision >= 0 ? user.revision : 0;
    refreshEnergy(user, now);

    const setResult = (data = {}) => {
      user.revision += 1;
      result = { ...data, user: publicUser(user, admins) };
    };
    const chargeBet = (bet) => {
      if (user.coins < bet) {
        failure = ["failed-precondition", "Недостаточно монет."];
        return false;
      }
      user.coins -= bet;
      user.miniGamesProfit -= bet;
      return true;
    };
    const payPrize = (amount) => {
      user.coins += amount;
      user.miniGamesWon += amount;
      user.miniGamesProfit += amount;
    };

    switch (action) {
      case "bootstrap":
        setResult();
        break;
      case "tap": {
        const requested = Number(payload.count);
        if (!Number.isInteger(requested) || requested < 1 || requested > 10) {
          failure = ["invalid-argument", "Invalid tap batch."];
          return;
        }
        const accepted = Math.min(requested, user.energy);
        user.energy -= accepted;
        user.coins += accepted;
        user.totalTaps += accepted;
        setResult({ accepted });
        break;
      }
      case "bonus": {
        if (now < user.nextClaimAt) {
          failure = ["failed-precondition", "Бонус пока недоступен."];
          return;
        }
        if (user.lastClaimAt && now - user.lastClaimAt > 2 * 24 * 60 * 60 * 1000) {
          user.rewardStreak = 0;
        }
        const reward = MINE_REWARDS[user.rewardStreak % MINE_REWARDS.length];
        user.coins += reward;
        user.rewardStreak += 1;
        user.lastClaimAt = now;
        user.nextClaimAt = now + 24 * 60 * 60 * 1000;
        setResult({ reward });
        break;
      }
      case "minesStart": {
        const bet = validateBet(payload.bet);
        const mineCount = Number(payload.mineCount);
        if (![2, 3, 5, 10].includes(mineCount)) {
          failure = ["invalid-argument", "Invalid mine count."];
          return;
        }
        if (user.activeGame) {
          failure = ["failed-precondition", "Заверши текущую игру перед началом новой."];
          return;
        }
        if (!chargeBet(bet)) return;
        const mines = new Set();
        while (mines.size < mineCount) mines.add(randomInt(25));
        user.activeGame = { type: "mines", bet, mineCount, mines: [...mines], opened: [], multiplier: 1 };
        setResult();
        break;
      }
      case "minesOpen": {
        const game = user.activeGame;
        if (!game || game.type !== "mines") {
          failure = ["failed-precondition", "Активная игра «Сапёр» не найдена."];
          return;
        }
        const index = validateIndex(Number(payload.index), 25);
        if (game.opened.includes(index)) {
          failure = ["failed-precondition", "Эта клетка уже открыта."];
          return;
        }
        if (game.mines.includes(index)) {
          user.activeGame = null;
          setResult({ hitMine: true, mines: game.mines });
          break;
        }
        game.opened.push(index);
        game.multiplier = Number((game.multiplier * (25 - game.opened.length + 1) / (25 - game.mineCount - game.opened.length + 1)).toFixed(8));
        setResult({ hitMine: false, index });
        break;
      }
      case "minesCashout": {
        const game = user.activeGame;
        if (!game || game.type !== "mines" || game.opened.length === 0) {
          failure = ["failed-precondition", "Сначала открой безопасную клетку."];
          return;
        }
        const prize = Math.floor(game.bet * game.multiplier);
        user.activeGame = null;
        payPrize(prize);
        setResult({ prize, mines: game.mines });
        break;
      }
      case "dice": {
        const bet = validateBet(payload.bet);
        const mode = payload.mode;
        const selected = Number(payload.number);
        if (!["gt", "lt", "eq"].includes(mode) || (mode === "eq" && (!Number.isInteger(selected) || selected < 1 || selected > 6))) {
          failure = ["invalid-argument", "Invalid dice selection."];
          return;
        }
        if (!chargeBet(bet)) return;
        const roll = randomInt(1, 7);
        const won = mode === "gt" ? roll > 3 : mode === "lt" ? roll < 4 : roll === selected;
        const multiplier = mode === "eq" ? 5 : 1.9;
        const prize = won ? Math.floor(bet * multiplier) : 0;
        if (prize) payPrize(prize);
        setResult({ roll, won, prize });
        break;
      }
      case "crypto": {
        const bet = validateBet(payload.bet);
        if (!["up", "down"].includes(payload.direction)) {
          failure = ["invalid-argument", "Invalid market direction."];
          return;
        }
        if (!chargeBet(bet)) return;
        const wentUp = randomInt(0, 2) === 1;
        const won = (payload.direction === "up") === wentUp;
        const prize = won ? Math.floor(bet * 1.9) : 0;
        if (prize) payPrize(prize);
        setResult({ wentUp, won, prize });
        break;
      }
      case "plinko": {
        const bet = validateBet(payload.bet);
        if (!chargeBet(bet)) return;
        let slot = 0;
        for (let row = 0; row < 6; row += 1) slot += randomInt(0, 2);
        const multiplier = PLINKO_MULTIPLIERS[slot];
        const prize = Math.floor(bet * multiplier);
        if (prize) payPrize(prize);
        setResult({ slot, multiplier, prize });
        break;
      }
      case "doorsStart": {
        const bet = validateBet(payload.bet);
        if (user.activeGame) {
          failure = ["failed-precondition", "Заверши текущую игру перед началом новой."];
          return;
        }
        if (!chargeBet(bet)) return;
        user.activeGame = { type: "doors", bet, room: 1, multiplier: 1, winningIndex: randomInt(3) };
        setResult();
        break;
      }
      case "doorsChoose": {
        const game = user.activeGame;
        if (!game || game.type !== "doors") {
          failure = ["failed-precondition", "Активная игра «Двери» не найдена."];
          return;
        }
        const index = validateIndex(Number(payload.index), 3);
        if (index !== game.winningIndex) {
          user.activeGame = null;
          setResult({ wonRoom: false, selected: index });
          break;
        }
        game.room += 1;
        game.multiplier = Number((1.4 * (game.room - 1)).toFixed(2));
        game.winningIndex = randomInt(3);
        setResult({ wonRoom: true, selected: index });
        break;
      }
      case "doorsCashout": {
        const game = user.activeGame;
        if (!game || game.type !== "doors" || game.room <= 1) {
          failure = ["failed-precondition", "Сначала пройди хотя бы одну комнату."];
          return;
        }
        const prize = Math.floor(game.bet * game.multiplier);
        user.activeGame = null;
        payPrize(prize);
        setResult({ prize });
        break;
      }
      case "adminGive": {
        if (!admins.has(uid)) {
          failure = ["permission-denied", "Недостаточно прав."];
          return;
        }
        const targetId = String(payload.targetId || "");
        const amount = Number(payload.amount);
        if (!/^\d+$/.test(targetId) || !Number.isSafeInteger(amount) || amount < 1 || amount > MAX_BET) {
          failure = ["invalid-argument", "Invalid player ID or amount."];
          return;
        }
        result = { targetId, amount };
        return current;
      }
      case "adminWipe": {
        if (!admins.has(uid)) {
          failure = ["permission-denied", "Недостаточно прав."];
          return;
        }
        const targetId = String(payload.targetId || "");
        if (!/^\d+$/.test(targetId)) {
          failure = ["invalid-argument", "Invalid player ID."];
          return;
        }
        result = { targetId };
        return current;
      }
      default:
        failure = ["invalid-argument", "Unknown operation."];
        return;
    }

    return user;
  });

  if (failure) fail(failure[0], failure[1]);
  if (!transaction.committed && !["adminGive", "adminWipe"].includes(action)) {
    fail("aborted", "The operation could not be saved. Please retry.");
  }

  if (action === "adminGive" || action === "adminWipe") {
    if (!admins.has(uid)) fail("permission-denied", "Недостаточно прав.");
    const targetRef = database().ref(`users/${result.targetId}`);
    if (action === "adminGive") {
      let updated = false;
      const targetTransaction = await targetRef.transaction((target) => {
        if (!target || !Number.isSafeInteger(target.coins) || target.coins < 0 || target.coins + result.amount > Number.MAX_SAFE_INTEGER) return;
        target.coins += result.amount;
        updated = true;
        return target;
      });
      if (!targetTransaction.committed || !updated) fail("not-found", "Игрок не найден или баланс нельзя обновить.");
    } else {
      let existed = false;
      const targetTransaction = await targetRef.transaction((target) => {
        if (!target) return;
        existed = true;
        target.coins = 0;
        target.totalTaps = 0;
        target.miniGamesWon = 0;
        target.miniGamesProfit = 0;
        target.rewardStreak = 0;
        target.wheelSpins = 0;
        target.activeGame = null;
        target.adminWipedAt = now;
        return target;
      });
      if (!targetTransaction.committed || !existed) fail("not-found", "Игрок не найден.");
    }
    const snapshot = await ref.once("value");
    return { user: publicUser(snapshot.val(), admins), targetId: result.targetId };
  }

  return result;
}

async function loadLeaderboard() {
  const snapshot = await database().ref("users").orderByChild("coins").limitToLast(50).once("value");
  const players = [];
  snapshot.forEach((child) => {
    const user = child.val();
    if (user && Number(user.totalTaps) > 0) {
      players.push({
        name: String(user.name || "Игрок").slice(0, 80),
        username: String(user.username || "none").slice(0, 32),
        uid: String(user.uid || child.key),
        coins: Number.isSafeInteger(user.coins) && user.coins >= 0 ? user.coins : 0,
      });
    }
  });
  return players.sort((a, b) => b.coins - a.coins).slice(0, 10);
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
      const body = request.body;
      if (Number(request.get("content-length") || 0) > 12_000) {
        fail("invalid-argument", "Request body is too large.");
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        fail("invalid-argument", "A JSON request body is required.");
      }
      const profile = parseInitData(body.initData, telegramBotToken.value());
      const uid = String(profile.id);
      if (body.action === "leaderboard") {
        const leaderboard = await loadLeaderboard();
        if (!getAdmins().has(uid)) {
          for (const player of leaderboard) delete player.uid;
        }
        response.json({ leaderboard, isAdmin: getAdmins().has(uid) });
        return;
      }

      const payload = body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)
        ? body.payload
        : {};
      const result = await updateUser(uid, body.action, payload, profile, getAdmins());
      response.json(result);
    } catch (error) {
      if (error instanceof HttpsError) {
        response.status(error.httpErrorCode.status).json({ error: error.message, code: error.code });
        return;
      }
      logger.error("Unhandled API failure", error);
      response.status(500).json({ error: "Сервис временно недоступен. Попробуй позже." });
    }
  },
);
