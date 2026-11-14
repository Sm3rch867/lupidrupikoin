(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const telegram = window.Telegram && window.Telegram.WebApp;
  const initData = telegram ? telegram.initData : "";
  const USER_KEY = "lupi-drupi-safe-user-v1";
  const PROGRESS_KEY = "lupi-drupi-challenges-v1";
  const DAILY_REWARD = 100;
  const THEMES = [
    { id: "midnight", name: "Midnight", description: "Синяя классика", price: 0, colors: ["#0b1220", "#1d2b43", "#5d91ff"] },
    { id: "ocean", name: "Ocean", description: "Морские оттенки", price: 250, colors: ["#071821", "#1b4052", "#38b7c9"] },
    { id: "orchid", name: "Orchid", description: "Фиолетовые акценты", price: 500, colors: ["#171124", "#3b2a55", "#ba8cff"] },
    { id: "ember", name: "Ember", description: "Тёплая палитра", price: 750, colors: ["#1b1512", "#4b372b", "#e99b65"] }
  ];
  let user = null;
  let ready = false;
  let tapBusy = false;
  let challengeRuntime = null;
  let progress = loadProgress();

  function today() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  function loadLocalUser() {
    try {
      const v = JSON.parse(localStorage.getItem(USER_KEY) || "{}");
      return {
        uid: "demo", name: "Гость", username: "", coins: Math.max(0, Number(v.coins) || 0),
        totalTaps: Math.max(0, Number(v.totalTaps) || 0), energy: Math.max(0, Math.min(100, Number(v.energy ?? 100))),
        lastEnergyAt: Number(v.lastEnergyAt) || Date.now(), nextClaimAt: Number(v.nextClaimAt) || 0,
        revision: 0, isAdmin: false, ownedThemes: Array.isArray(v.ownedThemes) ? v.ownedThemes : ["midnight"],
        activeTheme: THEMES.some((t) => t.id === v.activeTheme) ? v.activeTheme : "midnight"
      };
    } catch {
      return { uid: "demo", name: "Гость", username: "", coins: 0, totalTaps: 0, energy: 100, lastEnergyAt: Date.now(), nextClaimAt: 0, revision: 0, isAdmin: false, ownedThemes: ["midnight"], activeTheme: "midnight" };
    }
  }

  function saveLocalUser() {
    if (!user || initData) return;
    localStorage.setItem(USER_KEY, JSON.stringify({
      coins: user.coins, totalTaps: user.totalTaps, energy: user.energy, lastEnergyAt: user.lastEnergyAt,
      nextClaimAt: user.nextClaimAt, ownedThemes: user.ownedThemes, activeTheme: user.activeTheme
    }));
  }

  function loadProgress() {
    try {
      const v = JSON.parse(localStorage.getItem(PROGRESS_KEY) || "{}");
      return {
        xp: Math.max(0, Number(v.xp) || 0), completed: Math.max(0, Number(v.completed) || 0),
        bests: v.bests && typeof v.bests === "object" ? v.bests : {},
        daily: v.daily && typeof v.daily === "object" ? v.daily : { date: today(), ids: [] }
      };
    } catch {
      return { xp: 0, completed: 0, bests: {}, daily: { date: today(), ids: [] } };
    }
  }

  function saveProgress() {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
  }

  function ensureDaily() {
    if (progress.daily.date !== today()) progress.daily = { date: today(), ids: [] };
  }

  function demoAction(action, payload) {
    const now = Date.now();
    if (action === "bootstrap") {
      const elapsed = Math.max(0, Math.floor((now - user.lastEnergyAt) / 1000));
      user.energy = Math.min(100, user.energy + elapsed);
      user.lastEnergyAt = user.energy === 100 ? now : user.lastEnergyAt + elapsed * 1000;
      return { user: Object.assign({}, user) };
    }
    if (action === "tap") {
      const count = Math.min(10, Math.max(0, Number(payload.count) || 0), user.energy);
      user.energy -= count; user.coins += count; user.totalTaps += count; user.revision += 1;
      return { accepted: count, user: Object.assign({}, user) };
    }
    if (action === "bonus") {
      if (now < user.nextClaimAt) throw new Error("Ежедневная награда пока недоступна.");
      user.coins += DAILY_REWARD; user.nextClaimAt = now + 86400000; user.revision += 1;
      return { reward: DAILY_REWARD, user: Object.assign({}, user) };
    }
    if (action === "shopBuy" || action === "setTheme") {
      const theme = THEMES.find((t) => t.id === payload.themeId);
      if (!theme) throw new Error("Неизвестная тема.");
      if (action === "shopBuy") {
        if (user.ownedThemes.includes(theme.id)) throw new Error("Эта тема уже открыта.");
        if (user.coins < theme.price) throw new Error("Недостаточно виртуальных монет.");
        user.coins -= theme.price; user.ownedThemes.push(theme.id);
      } else if (!user.ownedThemes.includes(theme.id)) {
        throw new Error("Сначала открой эту тему.");
      }
      user.activeTheme = theme.id; user.revision += 1;
      return { user: Object.assign({}, user) };
    }
    if (action === "leaderboard") return { leaderboard: [{ name: "Гость", coins: user.coins }] };
    throw new Error("Действие недоступно в демонстрационном режиме.");
  }

  async function apiRequest(action, payload) {
    payload = payload || {};
    if (!initData) return demoAction(action, payload);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch("/api", {
        method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
        signal: controller.signal, body: JSON.stringify({ action: action, payload: payload, initData: initData })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Не удалось выполнить запрос.");
      return data;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("Сервер не ответил вовремя. Проверь подключение.");
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function initials(name) {
    return String(name || "L").trim().split(/\s+/).slice(0, 2).map((p) => p[0] || "").join("").toUpperCase() || "L";
  }

  function applyUser(next) {
    if (!next || !Number.isSafeInteger(next.revision) || next.revision < (user ? user.revision : -1)) return;
    user = Object.assign({}, next);
    if (!Array.isArray(user.ownedThemes)) user.ownedThemes = ["midnight"];
    if (!THEMES.some((t) => t.id === user.activeTheme)) user.activeTheme = "midnight";
    ready = true;
    saveLocalUser();
    render();
  }

  function render() {
    if (!user) return;
    const name = user.name || "Игрок";
    $("#coin-balance").textContent = Number(user.coins).toLocaleString("ru-RU");
    $("#shop-coins").textContent = Number(user.coins).toLocaleString("ru-RU");
    $("#energy-text").textContent = user.energy + " / 100";
    $("#energy-fill").style.width = user.energy + "%";
    $("#tap-energy").textContent = user.energy + " энергии";
    $("#coin-tap").disabled = !ready || user.energy <= 0 || tapBusy;
    $("#chip-name").textContent = name;
    $("#user-avatar").textContent = initials(name);
    $("#profile-avatar").textContent = initials(name);
    $("#profile-name").textContent = name;
    $("#profile-id").textContent = user.uid === "demo" ? "Демонстрационный режим" : "Telegram ID: " + user.uid;
    $("#profile-level").textContent = String(1 + Math.floor(progress.xp / 100));
    $("#xp-total").textContent = progress.xp + " XP";
    $("#stat-coins").textContent = Number(user.coins).toLocaleString("ru-RU");
    $("#stat-taps").textContent = Number(user.totalTaps).toLocaleString("ru-RU");
    $("#stat-challenges").textContent = progress.completed.toLocaleString("ru-RU");
    $("#stat-xp").textContent = progress.xp + " XP";
    $("#best-reaction").textContent = progress.bests.reaction ? progress.bests.reaction + " ms" : "— ms";
    $("#best-memory").textContent = "Уровень " + (progress.bests.memory || 0);
    $("#best-math").textContent = (progress.bests.math || 0) + " очков";
    $("#best-count").textContent = (progress.bests.count || 0) + " очков";
    ensureDaily();
    const dailyCount = progress.daily.ids.length;
    $("#daily-progress-label").textContent = dailyCount + " из 3";
    $("#daily-progress-fill").style.width = Math.min(100, dailyCount / 3 * 100) + "%";
    $("#admin-panel").hidden = !user.isAdmin;
    document.documentElement.dataset.theme = user.activeTheme || "midnight";
    $("#bonus-dot").hidden = Date.now() < user.nextClaimAt;
    renderShop();
  }

  function toast(message) {
    const item = document.createElement("div");
    item.className = "toast"; item.textContent = message; $("#toast-region").append(item);
    window.setTimeout(() => item.remove(), 2600);
  }

  const headings = {
    home: ["ТВОЁ ИГРОВОЕ ПРОСТРАНСТВО", "С возвращением!", "Небольшие испытания. Большие рекорды."],
    challenges: ["АРКАДА НАВЫКОВ", "Время испытаний", "Тренируй навыки и улучшай личные результаты."],
    shop: ["ПЕРСОНАЛИЗАЦИЯ", "Сделай по-своему", "Выбирай оформление, которое тебе нравится."],
    profile: ["ТВОЙ ПРОГРЕСС", "Твой профиль", "Результаты и достижения в одном месте."]
  };

  function showScreen(name) {
    if (!headings[name]) return;
    $$("[data-screen]").forEach((node) => node.classList.toggle("is-active", node.dataset.screen === name));
    $$(".nav-item").forEach((node) => node.classList.toggle("is-active", node.dataset.go === name));
    $("#page-eyebrow").textContent = headings[name][0];
    $("#page-title").textContent = headings[name][1];
    $("#page-subtitle").textContent = headings[name][2];
    if (name === "profile") loadLeaderboard();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function tapCoin() {
    if (!ready || tapBusy || user.energy <= 0) return;
    tapBusy = true; render();
    try {
      const result = await apiRequest("tap", { count: 1 });
      applyUser(result.user);
      $("#coin-tap").animate([{ transform: "scale(1)" }, { transform: "scale(.93)" }, { transform: "scale(1)" }], { duration: 170 });
    } catch (error) {
      toast(error.message);
    } finally {
      tapBusy = false; render();
    }
  }

  function openBonus() {
    if (!user) return;
    $("#bonus-amount").innerHTML = DAILY_REWARD + " <small>COINS</small>";
    updateBonusDialog(); $("#bonus-dialog").showModal();
  }

  function remaining(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return String(Math.floor(s / 3600)).padStart(2, "0") + ":" + String(Math.floor((s % 3600) / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  }

  function updateBonusDialog() {
    const available = Date.now() >= user.nextClaimAt;
    $("#bonus-claim").disabled = !available;
    $("#bonus-claim").textContent = available ? "Получить награду" : "Уже получено";
    $("#bonus-timer").textContent = available ? "Награда доступна. Возвращайся завтра!" : "Следующая награда: " + remaining(user.nextClaimAt - Date.now());
    $("#bonus-dot").hidden = !available;
  }

  async function claimBonus() {
    if (!user || Date.now() < user.nextClaimAt) return;
    $("#bonus-claim").disabled = true;
    try {
      const result = await apiRequest("bonus", {});
      applyUser(result.user); updateBonusDialog(); toast("Получено " + result.reward + " виртуальных монет");
    } catch (error) {
      toast(error.message); updateBonusDialog();
    }
  }

  function renderShop() {
    const root = $("#shop-grid");
    if (!root || !user) return;
    root.replaceChildren();
    THEMES.forEach((theme) => {
      const owned = user.ownedThemes.includes(theme.id);
      const active = user.activeTheme === theme.id;
      const card = document.createElement("article"); card.className = "theme-card";
      const preview = document.createElement("div"); preview.className = "theme-preview";
      preview.style.background = "linear-gradient(130deg," + theme.colors[0] + "," + theme.colors[1] + ")";
      preview.style.setProperty("--preview-accent", theme.colors[2]);
      preview.innerHTML = '<span class="preview-side"></span><span class="preview-main"></span>';
      const meta = document.createElement("div"); meta.className = "theme-meta";
      const title = document.createElement("strong"); title.textContent = theme.name;
      const price = document.createElement("small"); price.textContent = theme.price ? theme.price.toLocaleString("ru-RU") + " coins" : "Бесплатно";
      meta.append(title, price);
      const button = document.createElement("button"); button.type = "button";
      button.className = "theme-button" + ((!owned && !active) ? " primary" : "");
      button.textContent = active ? "Используется" : (owned ? "Применить" : "Открыть за " + theme.price);
      button.disabled = active || (!owned && user.coins < theme.price);
      button.addEventListener("click", () => changeTheme(theme, owned));
      card.append(preview, meta, button); root.append(card);
    });
  }

  async function changeTheme(theme, owned) {
    try {
      const action = owned ? "setTheme" : "shopBuy";
      const result = await apiRequest(action, { themeId: theme.id });
      applyUser(result.user); toast(owned ? "Тема " + theme.name + " применена" : "Тема " + theme.name + " открыта");
    } catch (error) { toast(error.message); }
  }

  async function loadLeaderboard() {
    const root = $("#leaderboard");
    root.innerHTML = '<div class="loading-row">Загружаем список игроков…</div>';
    try {
      const result = await apiRequest("leaderboard", {});
      const list = Array.isArray(result.leaderboard) ? result.leaderboard : [];
      root.replaceChildren();
      if (!list.length) {
        const empty = document.createElement("div"); empty.className = "loading-row";
        empty.textContent = "Пока нет результатов. Стань первым!"; root.append(empty); return;
      }
      list.forEach((player, index) => {
        const row = document.createElement("div"); row.className = "leaderboard-row";
        const rank = document.createElement("span"); rank.className = "leaderboard-rank" + (index < 3 ? " top" : ""); rank.textContent = String(index + 1);
        const name = document.createElement("span"); name.className = "leaderboard-name"; name.textContent = player.name || "Игрок";
        const score = document.createElement("span"); score.className = "leaderboard-score"; score.textContent = Number(player.coins || 0).toLocaleString("ru-RU") + " coins";
        row.append(rank, name, score); root.append(row);
      });
    } catch (error) {
      root.replaceChildren(); const empty = document.createElement("div"); empty.className = "loading-row"; empty.textContent = error.message; root.append(empty);
    }
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function completeChallenge(id, score, xp, label) {
    ensureDaily();
    const previous = Number(progress.bests[id]) || 0;
    const improved = previous === 0 || score > previous;
    if (improved) progress.bests[id] = score;
    if (!progress.daily.ids.includes(id)) progress.daily.ids.push(id);
    progress.completed += 1; progress.xp += xp; saveProgress(); render();
    $("#challenge-content").innerHTML = '<div class="challenge-center"><span class="eyebrow">ИСПЫТАНИЕ ЗАВЕРШЕНО</span><div class="result-score">' + escapeHtml(label) + '</div><h3>' + (improved ? "Новый личный рекорд!" : "Хорошая работа!") + '</h3><p>Получено ' + xp + ' XP. Опыт помогает повышать твой уровень.</p><button class="game-action" id="challenge-done" type="button">Продолжить</button></div>';
    $("#challenge-done").addEventListener("click", closeChallenge);
    toast("+" + xp + " XP");
  }

  function showIntro(title, help, buttonText, onStart) {
    $("#challenge-content").innerHTML = '<p class="eyebrow">АРКАДА НАВЫКОВ</p><h2 class="challenge-title">' + escapeHtml(title) + '</h2><p class="challenge-help">' + escapeHtml(help) + '</p><div class="challenge-panel"><div class="challenge-center"><h3>Готов попробовать?</h3><p>Бесплатное испытание. Результат влияет только на личный рекорд и опыт.</p><button class="game-action" id="challenge-start" type="button">' + buttonText + '</button></div></div>';
    $("#challenge-start").addEventListener("click", onStart);
  }

  function clearChallenge() {
    if (!challengeRuntime) return;
    if (challengeRuntime.timer) window.clearInterval(challengeRuntime.timer);
    if (challengeRuntime.timeout) window.clearTimeout(challengeRuntime.timeout);
    if (challengeRuntime.cancel) challengeRuntime.cancel();
    challengeRuntime = null;
  }

  function closeChallenge() {
    clearChallenge();
    $("#challenge-dialog").close();
    render();
  }

  function startChallenge(id) {
    clearChallenge();
    $("#challenge-dialog").showModal();
    if (id === "reaction") startReaction();
    else if (id === "memory") startMemory();
    else if (id === "math") startMath();
    else if (id === "count") startCount();
  }

  function startReaction() {
    showIntro("Тест реакции", "Нажми на кнопку сразу после того, как она станет зелёной. Не торопись нажимать раньше времени.", "Начать тест", () => {
      $("#challenge-content").innerHTML = '<p class="eyebrow">ТЕСТ РЕАКЦИИ</p><h2 class="challenge-title">Будь внимателен</h2><p class="challenge-help">Нажимать нужно только после смены цвета.</p><div class="challenge-panel"><button class="reaction-pad is-waiting" id="reaction-pad" type="button">Жди зелёного сигнала…</button></div>';
      const pad = $("#reaction-pad"); let readyToTap = false; let startedAt = 0;
      challengeRuntime = { id: "reaction" };
      challengeRuntime.timeout = window.setTimeout(() => {
        if (!pad.isConnected) return;
        readyToTap = true; startedAt = performance.now();
        pad.classList.remove("is-waiting"); pad.classList.add("is-ready"); pad.textContent = "НАЖМИ СЕЙЧАС!";
      }, 1300 + Math.floor(Math.random() * 2300));
      pad.addEventListener("click", () => {
        if (!readyToTap) {
          window.clearTimeout(challengeRuntime.timeout); pad.disabled = true;
          $("#challenge-content").innerHTML = '<div class="challenge-center"><h3>Чуть раньше времени</h3><p>Дождись зелёного сигнала и попробуй снова.</p><button class="game-action" id="reaction-retry" type="button">Повторить</button></div>';
          $("#reaction-retry").addEventListener("click", startReaction); return;
        }
        const ms = Math.max(1, Math.round(performance.now() - startedAt));
        completeChallenge("reaction", ms, 10, ms + " ms");
      }, { once: true });
    });
  }

  function startMemory() {
    showIntro("Последовательность", "Смотри, какие цветные кнопки загораются, и повторяй порядок. С каждым уровнем цепочка становится длиннее.", "Начать", () => {
      const game = { id: "memory", level: 1, sequence: [], input: 0, accepting: false };
      for (let i = 0; i < 3; i += 1) game.sequence.push(Math.floor(Math.random() * 4));
      challengeRuntime = game; renderMemory(game); playSequence(game);
    });
  }

  function renderMemory(game) {
    $("#challenge-content").innerHTML = '<p class="eyebrow">ПАМЯТЬ</p><h2 class="challenge-title">Уровень ' + game.level + '</h2><p class="challenge-help" id="memory-help">Запомни последовательность…</p><div class="challenge-panel"><div class="memory-grid">' + [0,1,2,3].map((i) => '<button class="memory-tile" data-memory="' + i + '" type="button" aria-label="Цвет ' + (i + 1) + '"></button>').join("") + '</div></div>';
    $$("[data-memory]").forEach((button) => button.addEventListener("click", () => {
      if (!game.accepting || challengeRuntime !== game) return;
      const value = Number(button.dataset.memory);
      if (value !== game.sequence[game.input]) {
        game.accepting = false;
        completeChallenge("memory", game.level - 1, 10 + Math.max(0, game.level - 1) * 3, "Уровень " + (game.level - 1));
        return;
      }
      game.input += 1;
      if (game.input === game.sequence.length) {
        game.accepting = false; game.level += 1; game.sequence.push(Math.floor(Math.random() * 4)); game.input = 0;
        $("#challenge-content").innerHTML = '<div class="challenge-center"><span class="eyebrow">ОТЛИЧНО</span><h3>Уровень пройден</h3><p>Готов к следующему?</p><button class="game-action" id="memory-next" type="button">Продолжить</button></div>';
        $("#memory-next").addEventListener("click", () => { renderMemory(game); playSequence(game); });
      }
    }));
  }

  function playSequence(game) {
    game.accepting = false; $("#memory-help").textContent = "Запоминай подсветку кнопок…";
    let index = 0;
    const tick = () => {
      if (challengeRuntime !== game) return;
      if (index >= game.sequence.length) {
        game.accepting = true; game.input = 0; $("#memory-help").textContent = "Теперь повтори последовательность."; return;
      }
      const button = $('[data-memory="' + game.sequence[index] + '"]');
      if (button) { button.classList.add("is-lit"); window.setTimeout(() => button.classList.remove("is-lit"), 300); }
      index += 1; game.timeout = window.setTimeout(tick, 570);
    };
    game.timeout = window.setTimeout(tick, 400);
  }

  function startMath() {
    showIntro("Математический спринт", "За 30 секунд реши как можно больше коротких примеров. Выбирай правильный ответ из четырёх вариантов.", "Начать спринт", () => {
      const game = { id: "math", score: 0, seconds: 30, answer: 0 }; challengeRuntime = game; renderMath(game);
      game.timer = window.setInterval(() => {
        game.seconds -= 1; const clock = $("#game-clock"); if (clock) clock.textContent = game.seconds + " сек";
        if (game.seconds <= 0) { clearInterval(game.timer); completeChallenge("math", game.score, Math.min(30, 5 + game.score), game.score + " очков"); }
      }, 1000);
    });
  }

  function renderMath(game) {
    const a = 2 + Math.floor(Math.random() * 19); const b = 2 + Math.floor(Math.random() * 12);
    const subtract = Math.random() > .5; const left = subtract ? Math.max(a,b) : a; const right = subtract ? Math.min(a,b) : b;
    game.answer = subtract ? left - right : left + right;
    const options = new Set([game.answer]);
    while (options.size < 4) options.add(Math.max(0, game.answer + (Math.floor(Math.random() * 13) - 6 || 2)));
    const choices = Array.from(options).sort(() => Math.random() - .5);
    $("#challenge-content").innerHTML = '<p class="eyebrow">МАТЕМАТИЧЕСКИЙ СПРИНТ</p><div class="game-status"><span>Очки: <strong>' + game.score + '</strong></span><span id="game-clock">' + game.seconds + ' сек</span></div><h2 class="challenge-title">Сколько будет ' + left + (subtract ? " − " : " + ") + right + '?</h2><div class="challenge-panel"><div class="answer-grid">' + choices.map((n) => '<button class="answer-button" data-answer="' + n + '" type="button">' + n + '</button>').join("") + '</div></div>';
    $$("[data-answer]").forEach((button) => button.addEventListener("click", () => {
      if (challengeRuntime !== game || game.seconds <= 0) return;
      if (Number(button.dataset.answer) === game.answer) game.score += 1;
      renderMath(game);
    }));
  }

  function startCount() {
    showIntro("Счёт объектов", "За 20 секунд найди, сколько заданных символов спрятано среди остальных. Будь внимателен.", "Начать", () => {
      const game = { id: "count", score: 0, seconds: 20, target: "◆", count: 0 }; challengeRuntime = game; renderCount(game);
      game.timer = window.setInterval(() => {
        game.seconds -= 1; const clock = $("#game-clock"); if (clock) clock.textContent = game.seconds + " сек";
        if (game.seconds <= 0) { clearInterval(game.timer); completeChallenge("count", game.score, Math.min(25, 5 + game.score * 2), game.score + " очков"); }
      }, 1000);
    });
  }

  function renderCount(game) {
    const symbols = ["◆", "●", "▲", "■"];
    game.target = symbols[Math.floor(Math.random() * symbols.length)];
    const cells = Array.from({ length: 28 }, () => symbols[Math.floor(Math.random() * symbols.length)]);
    game.count = 3 + Math.floor(Math.random() * 6);
    for (let i = 0; i < game.count; i += 1) cells[i] = game.target;
    cells.sort(() => Math.random() - .5);
    const options = new Set([game.count]);
    while (options.size < 3) options.add(Math.max(1, game.count + Math.floor(Math.random() * 5) - 2));
    const choices = Array.from(options).sort(() => Math.random() - .5);
    $("#challenge-content").innerHTML = '<p class="eyebrow">СЧЁТ ОБЪЕКТОВ</p><div class="game-status"><span>Очки: <strong>' + game.score + '</strong></span><span id="game-clock">' + game.seconds + ' сек</span></div><h2 class="challenge-title">Сколько символов ' + game.target + '?</h2><div class="challenge-panel"><div class="count-board">' + cells.map((s) => '<span class="count-cell">' + s + '</span>').join("") + '</div><div class="answer-grid">' + choices.map((n) => '<button class="answer-button" data-count-answer="' + n + '" type="button">' + n + '</button>').join("") + '</div></div>';
    $$("[data-count-answer]").forEach((button) => button.addEventListener("click", () => {
      if (challengeRuntime !== game || game.seconds <= 0) return;
      if (Number(button.dataset.countAnswer) === game.count) game.score += 1;
      renderCount(game);
    }));
  }

  async function adminAction(action) {
    if (!user || !user.isAdmin) return;
    const targetId = $("#admin-target").value.trim(); const amount = Number($("#admin-amount").value);
    if (!/^\d+$/.test(targetId)) return toast("Введи корректный Telegram ID.");
    if (action === "adminGive" && (!Number.isSafeInteger(amount) || amount < 1 || amount > 1000000)) return toast("Некорректное количество монет.");
    try {
      await apiRequest(action, action === "adminGive" ? { targetId: targetId, amount: amount } : { targetId: targetId });
      toast(action === "adminGive" ? "Виртуальные монеты начислены." : "Баланс сброшен.");
    } catch (error) { toast(error.message); }
  }

  function bindEvents() {
    $$("[data-go]").forEach((button) => button.addEventListener("click", () => showScreen(button.dataset.go)));
    $$("[data-challenge]").forEach((button) => button.addEventListener("click", () => startChallenge(button.dataset.challenge)));
    $("#coin-tap").addEventListener("click", tapCoin);
    $("#bonus-open").addEventListener("click", openBonus);
    $("#balance-bonus").addEventListener("click", openBonus);
    $("#bonus-claim").addEventListener("click", claimBonus);
    $("#challenge-close").addEventListener("click", closeChallenge);
    $("#admin-give").addEventListener("click", () => adminAction("adminGive"));
    $("#admin-reset").addEventListener("click", () => adminAction("adminWipe"));
    $("#challenge-dialog").addEventListener("cancel", clearChallenge);
  }

  async function bootstrap() {
    if (telegram) {
      telegram.ready(); telegram.expand();
      if (telegram.setHeaderColor) telegram.setHeaderColor("#0b1220");
      if (telegram.setBackgroundColor) telegram.setBackgroundColor("#0b1220");
    } else {
      $("#preview-banner").hidden = false;
    }
    user = initData ? null : loadLocalUser();
    if (!initData) {
      const elapsed = Math.max(0, Math.floor((Date.now() - user.lastEnergyAt) / 1000));
      user.energy = Math.min(100, user.energy + elapsed);
      user.lastEnergyAt = user.energy === 100 ? Date.now() : user.lastEnergyAt + elapsed * 1000;
      applyUser(user);
    }
    try {
      const result = await apiRequest("bootstrap", {});
      applyUser(result.user);
    } catch (error) {
      toast(error.message);
      $("#preview-banner").hidden = false;
      if (!user) { user = loadLocalUser(); applyUser(user); }
    }
    window.setInterval(() => {
      if (user && Date.now() < user.nextClaimAt && $("#bonus-dialog").open) updateBonusDialog();
    }, 1000);
  }

  bindEvents();
  bootstrap();
})();