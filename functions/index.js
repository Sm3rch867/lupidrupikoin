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

function database() {
  const configuredUrl = databaseUrl.value();
  return configuredUrl ? getDatabase(undefined, configuredUrl) : getDatabase();
}

const MAX_INIT_DATA_AGE_SECONDS = 60 * 60 * 24;
const MAX_ADMIN_GRANT = 1_000_000;
const MINE_REWARDS = [1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000];
const ARCADE_REWARDS = { mines: 25, crypto: 30, dice: 20, plinko: 35, doors: 25 };
const TASK_REWARDS = { tap50: 50, game1: 50, game3: 100 };

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
    arcadeDaily: {},
    taskClaims: {},
    dailyTaps: {},
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

function todayKey(now = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Kyiv",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(now));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return values.year + "-" + values.month + "-" + values.day;
}

function publicUser(user, admins) {
  const dayKey = todayKey();
  const arcadeToday = user.arcadeDaily && user.arcadeDaily[dayKey] && typeof user.arcadeDaily[dayKey] === "object"
    ? user.arcadeDaily[dayKey] : {};
  const tasksToday = user.taskClaims && user.taskClaims[dayKey] && typeof user.taskClaims[dayKey] === "object"
    ? user.taskClaims[dayKey] : {};
  return {
    uid: String(user.uid),
    name: String(user.name || "Игрок"),
    username: String(user.username || "none"),
    coins: Math.max(0, Number(user.coins) || 0),
    totalTaps: Math.max(0, Number(user.totalTaps) || 0),
    miniGamesWon: Math.max(0, Number(user.miniGamesWon) || 0),
    miniGamesProfit: Math.max(0, Number(user.miniGamesProfit) || 0),
    rewardStreak: Math.max(0, Number(user.rewardStreak) || 0),
    wheelSpins: Math.max(0, Number(user.wheelSpins) || 0),
    energy: Math.max(0, Math.min(100, Number(user.energy) || 0)),
    nextClaimAt: Math.max(0, Number(user.nextClaimAt) || 0),
    revision: Math.max(0, Number(user.revision) || 0),
    isAdmin: admins.has(String(user.uid)),
    arcadeCompletedToday: Object.keys(arcadeToday),
    taskClaimsToday: Object.keys(tasksToday),
    tapsToday: Math.max(0, Number(user.dailyTaps && user.dailyTaps[dayKey]) || 0),
  };
}

function stableSeed(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function buildArcadeChallenge(uid, game, dayKey) {
  const seed = stableSeed(uid + ":" + dayKey + ":" + game);
  if (game === "mines") {
    return {
      type: "grid",
      prompt: "Отметь все числа, кратные 4.",
      cells: Array.from({ length: 25 }, (_, index) => index + 1),
      required: 6,
      answer: [4, 8, 12, 16, 20, 24],
    };
  }
  if (game === "crypto") {
    const rising = seed % 2 === 0;
    const start = 100 + (seed % 7);
    const values = rising
      ? [start, start + 2, start + 1, start + 4, start + 3, start + 8]
      : [start + 8, start + 6, start + 7, start + 3, start + 4, start];
    return {
      type: "trend",
      prompt: "Посмотри на график. Значение в конце выше или ниже начального?",
      values,
      answer: values[values.length - 1] > values[0] ? "up" : "down",
    };
  }
  if (game === "dice") {
    const first = 3 + (seed % 8);
    const second = 2 + (Math.floor(seed / 11) % 9);
    const answer = first + second;
    return {
      type: "choice",
      prompt: "Реши пример: " + first + " + " + second + " = ?",
      options: [answer - 2, answer - 1, answer, answer + 2],
      answer,
    };
  }
  if (game === "plinko") {
    const base = 2 + (seed % 3);
    const answer = base * 16;
    return {
      type: "choice",
      prompt: "Продолжи цепочку: " + [base, base * 2, base * 4, base * 8].join(", ") + ", ...",
      options: [base * 12, base * 14, answer, base * 18],
      answer,
    };
  }
  if (game === "doors") {
    return {
      type: "riddle",
      prompt: "Выбери правильный ответ: что становится мокрым, пока сушит?",
      options: ["Зонт", "Полотенце", "Книга"],
      answer: 1,
    };
  }
  fail("invalid-argument", "Неизвестная мини-игра.");
}

function isCorrectArcadeAnswer(challenge, answer) {
  if (challenge.type === "grid") {
    if (!Array.isArray(answer) || answer.length !== challenge.answer.length) return false;
    const selected = answer.map(Number);
    if (selected.some((value) => !Number.isInteger(value))) return false;
    const sorted = [...new Set(selected)].sort((a, b) => a - b);
    return sorted.length === challenge.answer.length &&
      sorted.every((value, index) => value === challenge.answer[index]);
  }
  if (challenge.type === "trend") return answer === challenge.answer;
  return Number(answer) === challenge.answer;
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
    user.miniGamesProfit = Number.isSafeInteger(user.miniGamesProfit) ? Math.max(0, user.miniGamesProfit) : 0;
    user.arcadeDaily = user.arcadeDaily && typeof user.arcadeDaily === "object" ? user.arcadeDaily : {};
    user.taskClaims = user.taskClaims && typeof user.taskClaims === "object" ? user.taskClaims : {};
    user.dailyTaps = user.dailyTaps && typeof user.dailyTaps === "object" ? user.dailyTaps : {};
    if (user.activeGame && Number.isSafeInteger(user.activeGame.bet) && user.activeGame.bet > 0) {
      user.coins += user.activeGame.bet;
    }
    user.activeGame = null;
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
        const dayKey = todayKey(now);
        user.dailyTaps[dayKey] = (Number(user.dailyTaps[dayKey]) || 0) + accepted;
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
      case "arcadeChallenge": {
        const game = String(payload.game || "");
        if (!Object.prototype.hasOwnProperty.call(ARCADE_REWARDS, game)) {
          failure = ["invalid-argument", "Неизвестная мини-игра."];
          return;
        }
        const dayKey = todayKey(now);
        const completed = Boolean(user.arcadeDaily[dayKey] && user.arcadeDaily[dayKey][game]);
        const fullChallenge = buildArcadeChallenge(uid, game, dayKey);
        const { answer, ...challenge } = fullChallenge;
        setResult({ challenge, completed });
        break;
      }
      case "arcadeComplete": {
        const game = String(payload.game || "");
        if (!Object.prototype.hasOwnProperty.call(ARCADE_REWARDS, game)) {
          failure = ["invalid-argument", "Неизвестная мини-игра."];
          return;
        }
        const dayKey = todayKey(now);
        user.arcadeDaily[dayKey] = user.arcadeDaily[dayKey] && typeof user.arcadeDaily[dayKey] === "object"
          ? user.arcadeDaily[dayKey] : {};
        if (user.arcadeDaily[dayKey][game]) {
          failure = ["already-exists", "Награда за эту мини-игру уже получена сегодня."];
          return;
        }
        const challenge = buildArcadeChallenge(uid, game, dayKey);
        if (!isCorrectArcadeAnswer(challenge, payload.answer)) {
          setResult({ correct: false, game });
          break;
        }
        const reward = ARCADE_REWARDS[game];
        user.arcadeDaily[dayKey][game] = now;
        user.coins += reward;
        user.miniGamesWon += reward;
        user.miniGamesProfit += reward;
        setResult({ correct: true, game, reward });
        break;
      }
      case "claimTask": {
        const task = String(payload.task || "");
        if (!Object.prototype.hasOwnProperty.call(TASK_REWARDS, task)) {
          failure = ["invalid-argument", "Неизвестное задание."];
          return;
        }
        const dayKey = todayKey(now);
        user.arcadeDaily[dayKey] = user.arcadeDaily[dayKey] && typeof user.arcadeDaily[dayKey] === "object"
          ? user.arcadeDaily[dayKey] : {};
        user.taskClaims[dayKey] = user.taskClaims[dayKey] && typeof user.taskClaims[dayKey] === "object"
          ? user.taskClaims[dayKey] : {};
        if (user.taskClaims[dayKey][task]) {
          failure = ["already-exists", "Награда за это задание уже получена сегодня."];
          return;
        }
        const completedGames = Object.keys(user.arcadeDaily[dayKey]).length;
        const eligible = task === "tap50" ? (Number(user.dailyTaps[dayKey]) || 0) >= 50
          : task === "game1" ? completedGames >= 1
            : completedGames >= 3;
        if (!eligible) {
          failure = ["failed-precondition", "Сначала выполни условие задания."];
          return;
        }
        const reward = TASK_REWARDS[task];
        user.taskClaims[dayKey][task] = now;
        user.coins += reward;
        setResult({ task, reward });
        break;
      }
      case "adminGive": {
        if (!admins.has(uid)) {
          failure = ["permission-denied", "Недостаточно прав."];
          return;
        }
        const targetId = String(payload.targetId || "");
        const amount = Number(payload.amount);
        if (!/^\d+$/.test(targetId) || !Number.isSafeInteger(amount) || amount < 1 || amount > MAX_ADMIN_GRANT) {
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
        // A statistics reset must never remove saved coins. Refund a legacy active round once before clearing it.
        if (target.activeGame && Number.isSafeInteger(target.activeGame.bet) && target.activeGame.bet > 0) {
          target.coins += target.activeGame.bet;
        }
        target.totalTaps = 0;
        target.miniGamesWon = 0;
        target.miniGamesProfit = 0;
        target.rewardStreak = 0;
        target.wheelSpins = 0;
        target.activeGame = null;
        target.arcadeDaily = {};
        target.taskClaims = {};
        target.dailyTaps = {};
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
