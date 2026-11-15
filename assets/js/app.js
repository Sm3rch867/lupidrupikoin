
        // ЛОКАЛИЗАЦИЯ
        const langData = {
            ru: {
                nv_game: "Главная", nv_shop: "Магазин", nv_tasks: "Задания", nv_games: "Игры", nv_profile: "Профиль",
                top_title: "ТОП ИГРОКОВ 🏆", day: "День",
                st_1: "Количество монет", st_2: "Количество тапов", st_3: "Заработано в мини-играх",
                st_4: "Награды за игры", st_5: "Стрик наград", st_6: "Игры пройдены сегодня"
            },
            en: {
                nv_game: "Main", nv_shop: "Shop", nv_tasks: "Tasks", nv_games: "Games", nv_profile: "Profile",
                top_title: "TOP PLAYERS 🏆", day: "Day",
                st_1: "Coins balance", st_2: "Total taps", st_3: "Earned in mini-games",
                st_4: "Game rewards", st_5: "Reward streak", st_6: "Games completed today"
            }
        };

        let currentLang = localStorage.getItem('cc_lang') || 'ru';
        if (!langData[currentLang]) currentLang = 'ru';
        let coins = 0;
        let totalTaps = 0;
        let miniGamesWon = 0;
        let miniGamesProfit = 0;
        let rewardStreak = 0;
        let wheelSpins = 0;
        let arcadeCompletedToday = [];
        let taskClaimsToday = [];
        let tapsToday = 0;
        let energy = 0;
        let nextClaimAt = 0;
        let isAdmin = false;
        let isReady = false;
        let bootstrapError = 'Подключаем сервер...';
        let userRevision = -1;
        let tapQueue = 0;
        let tapFlushTimer = null;
        let tapRequestInFlight = false;
        let tgUser = null;
        const telegram = window.Telegram && window.Telegram.WebApp;
        const telegramInitData = telegram ? telegram.initData : '';

        if (telegram) {
            telegram.ready();
            telegram.expand();
        }

        async function apiRequest(action, payload = {}) {
            if (!telegramInitData) {
                const onGitHubPages = location.hostname === 'github.io' || location.hostname.endsWith('.github.io');
                const message = onGitHubPages
                    ? 'Приложение открыто через GitHub Pages. Там нет серверного адреса /api. Открой Telegram-приложение по ссылке Firebase Hosting (*.web.app).'
                    : 'Не получены данные Telegram. Открой приложение через кнопку Web App своего бота, а не как обычную HTML-страницу.';
                throw new Error(message);
            }

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10_000);
            try {
                const response = await fetch('/api', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    cache: 'no-store',
                    signal: controller.signal,
                    body: JSON.stringify({ action, payload, initData: telegramInitData })
                });

                const responseText = await response.text();
                let data;
                try {
                    data = responseText ? JSON.parse(responseText) : {};
                } catch {
                    if (response.status === 404 || location.hostname.endsWith('.github.io')) {
                        throw new Error('Серверный адрес /api не найден. Для работы монеты и ежедневной награды нужен Firebase Hosting, а не GitHub Pages.');
                    }
                    throw new Error('Сервер вернул непонятный ответ. Проверь Firebase Functions и маршрут /api.');
                }

                if (!response.ok) {
                    throw new Error(data.error || `Ошибка сервера (HTTP ${response.status}).`);
                }
                return data;
            } catch (error) {
                if (error.name === 'AbortError') {
                    throw new Error('Сервер не ответил за 10 секунд. Проверь подключение и попробуй ещё раз.');
                }
                throw error;
            } finally {
                clearTimeout(timeout);
            }
        }

        function applyUser(user) {
            if (!user || !Number.isSafeInteger(user.revision) || user.revision < userRevision) return;
            userRevision = user.revision;
            coins = user.coins;
            totalTaps = user.totalTaps;
            miniGamesWon = user.miniGamesWon;
            miniGamesProfit = user.miniGamesProfit;
            rewardStreak = user.rewardStreak;
            wheelSpins = user.wheelSpins;
            arcadeCompletedToday = Array.isArray(user.arcadeCompletedToday) ? user.arcadeCompletedToday : [];
            taskClaimsToday = Array.isArray(user.taskClaimsToday) ? user.taskClaimsToday : [];
            tapsToday = Number.isSafeInteger(user.tapsToday) ? user.tapsToday : 0;
            energy = user.energy;
            nextClaimAt = user.nextClaimAt;
            isAdmin = user.isAdmin;
            tgUser = { id: user.uid, first_name: user.name, username: user.username };
            document.getElementById('admin-area').style.display = isAdmin ? 'block' : 'none';
            updateUI();
            initTelegramProfile();

        }

        async function bootstrap() {
            try {
                const data = await apiRequest('bootstrap');
                if (!data || !data.user) {
                    throw new Error('Сервер не вернул профиль игрока. Попробуй закрыть и снова открыть приложение из Telegram.');
                }
                applyUser(data.user);
                bootstrapError = '';
                isReady = true;
                document.getElementById('coin-clicker').disabled = false;
                updateBonusButtonState();
            } catch (error) {
                isReady = false;
                bootstrapError = error && error.message
                    ? error.message
                    : 'Не удалось подключиться к серверу.';
                updateBonusButtonState();
                showCustomResultDialog(`Не удалось загрузить аккаунт. ${bootstrapError}`);
            }
        }

        function initTelegramProfile() {
            const nameEl = document.getElementById('user-username');
            const joinedEl = document.getElementById('user-joined');
            if (!tgUser) return;

            const fullName = tgUser.first_name || "Игрок";
            const handle = tgUser.username ? ` (@${tgUser.username})` : "";
            
            nameEl.innerText = fullName + handle;
            joinedEl.innerText = `ID: ${tgUser.id}`;
        }

        // Обновление интерфейса
        function updateUI() {
            document.getElementById('coins').innerText = coins.toLocaleString();
            
            const statsCoins = document.getElementById('stat-coins-val');
            if(statsCoins) statsCoins.innerText = coins.toLocaleString();
            
            const statsTaps = document.getElementById('stat-taps-val');
            if(statsTaps) statsTaps.innerText = totalTaps.toLocaleString();
            
            const statsWon = document.getElementById('stat-won-val');
            if(statsWon) statsWon.innerText = miniGamesWon.toLocaleString();
            
            const pSign = miniGamesProfit >= 0 ? "+" : "";
            const pEl = document.getElementById('stat-profit-val');
            if(pEl) {
                pEl.innerText = pSign + miniGamesProfit.toLocaleString();
                pEl.className = miniGamesProfit >= 0 ? "win-color" : "lose-color";
            }

            const statsStreak = document.getElementById('stat-streak-val');
            if(statsStreak) statsStreak.innerText = rewardStreak;
            
            document.getElementById('top-streak-lbl').innerText = rewardStreak;
            
            const statsWheel = document.getElementById('stat-wheel-val');
            if(statsWheel) statsWheel.innerText = arcadeCompletedToday.length;

            document.getElementById('energy-num').innerText = `${energy} / 100`;
            document.getElementById('energy-fill').style.width = `${energy}%`;

            checkBonusDotNotification();
            updateTasksUI();
        }

        // КЛИКЕР ТАПЫ
        function handleTap(e) {
            if (!isReady) {
                showCustomResultDialog(bootstrapError || 'Приложение ещё подключается к серверу. Попробуй ещё раз через несколько секунд.');
                return;
            }
            if (energy <= 0 || tapQueue >= 10) return;
            coins += 1;
            totalTaps += 1;
            energy -= 1;
            tapQueue += 1;
            updateUI();

            const coinButton = document.getElementById('coin-clicker');
            coinButton.classList.remove('tap-pop');
            void coinButton.offsetWidth;
            coinButton.classList.add('tap-pop');

            const p = document.createElement('div');
            p.className = 'plus-one';
            p.innerText = '+1';
            
            let clientX = e.clientX;
            let clientY = e.clientY;
            if (e.changedTouches && e.changedTouches.length > 0) {
                clientX = e.changedTouches[0].clientX;
                clientY = e.changedTouches[0].clientY;
            }

            p.style.left = (clientX - 10) + 'px';
            p.style.top = (clientY - 20) + 'px';
            document.body.appendChild(p);

            setTimeout(() => p.remove(), 800);
            if (!tapFlushTimer && !tapRequestInFlight) {
                tapFlushTimer = setTimeout(flushTapQueue, 120);
            }
        }

        async function flushTapQueue() {
            tapFlushTimer = null;
            if (!isReady || tapRequestInFlight || tapQueue === 0) return;
            const count = Math.min(10, tapQueue);
            tapQueue -= count;
            tapRequestInFlight = true;
            try {
                const data = await apiRequest('tap', { count });
                applyUser(data.user);
            } catch (error) {
                tapQueue = 0;
                showCustomResultDialog(error.message);
                try {
                    const data = await apiRequest('bootstrap');
                    applyUser(data.user);
                } catch (refreshError) {
                    showCustomResultDialog(refreshError.message);
                }
            } finally {
                tapRequestInFlight = false;
                if (tapQueue > 0) tapFlushTimer = setTimeout(flushTapQueue, 0);
            }
        }

        // НАВИГАЦИЯ СТРАНИЦ
        function show(screenId) {
            document.querySelectorAll('.screen').forEach((screen) => screen.classList.remove('active'));
            document.querySelectorAll('.nav-item').forEach((item) => item.classList.remove('active'));
            document.getElementById(screenId + '-scr').classList.add('active');
            document.getElementById('n-' + screenId).classList.add('active');
            if (screenId === 'profile') loadLeaderboard();
            if (screenId === 'tasks') updateTasksUI();
        }

                // КАСТОМНЫЕ ОКНА РЕЗУЛЬТАТОВ
        function showCustomResultDialog(htmlText) {
            document.getElementById('result-dialog-msg').innerHTML = htmlText;
            document.getElementById('result-dialog').classList.add('open');
        }
        function closeCustomResultDialog() {
            document.getElementById('result-dialog').classList.remove('open');
        }

        // МОДАЛКА ЕЖЕДНЕВНЫХ БОНУСОВ
        function openBonusModal() {
            renderDaysGrid();
            document.getElementById('bonus-modal').classList.add('open');
        }
        function closeBonusModal() {
            document.getElementById('bonus-modal').classList.remove('open');
        }

        function checkBonusDotNotification() {
            const dot = document.getElementById('bonus-dot');
            if (!nextClaimAt || Date.now() >= nextClaimAt) {
                dot.style.display = 'block';
            } else {
                dot.style.display = 'none';
            }
        }

        function renderDaysGrid() {
            const container = document.getElementById('days-container');
            container.innerHTML = "";
            const isLocked = Date.now() < nextClaimAt;
            let currentDayIndex = rewardStreak % 7;
            
            for(let i=0; i<7; i++) {
                let imgFile = "stopka1.jpg";
                if(i === 3 || i === 4) imgFile = "stopka2.jpg";
                if(i === 5 || i === 6) imgFile = "stopka3.jpg";

                let boxClass = "day-box";
                if(i < currentDayIndex) boxClass += " completed";
                else if(i === currentDayIndex && !isLocked) boxClass += " active";

                container.innerHTML += `
                    <div class="${boxClass}">
                        <div class="day-num">${langData[currentLang].day} ${i+1}</div>
                        <img src="${imgFile}" class="day-img">
                        <div class="day-reward-lbl">${[1000, 2500, 5000, 10000, 25000, 50000, 100000][i].toLocaleString()}<img src="assets/images/coin.png" class="coin-mini-icon"></div>
                    </div>
                `;
            }

            updateBonusButtonState();
        }

        function updateBonusButtonState() {
            const btn = document.getElementById('bonus-claim-btn');
            if(!btn) return;
            
            if (Date.now() < nextClaimAt) {
                const diff = nextClaimAt - Date.now();
                const hours = Math.floor(diff / 3600000).toString().padStart(2, '0');
                const minutes = Math.floor((diff % 3600000) / 60000).toString().padStart(2, '0');
                const seconds = Math.floor((diff % 60000) / 1000).toString().padStart(2, '0');
                
                btn.innerText = `ДОСТУПНО ЧЕРЕЗ ${hours}:${minutes}:${seconds}`;
                btn.disabled = true;
                btn.style.background = "#1e293b";
            } else {
                btn.innerText = "ЗАБРАТЬ НАГРАДУ";
                btn.disabled = false;
                btn.style.background = "#2563eb";
            }
        }

        document.getElementById('bonus-claim-btn').addEventListener('click', claimDailyBonus);

        async function claimDailyBonus() {
            if (!isReady) {
                showCustomResultDialog(bootstrapError || 'Приложение ещё подключается к серверу. Попробуй ещё раз через несколько секунд.');
                return;
            }
            if (Date.now() < nextClaimAt) return;
            try {
                const data = await apiRequest('bonus');
                applyUser(data.user);
                renderDaysGrid();
                showCustomResultDialog(`Вы успешно забрали ежедневную награду: <span style="color:#22c55e;">+${data.reward.toLocaleString()}</span> <img src="assets/images/coin.png">!`);
            } catch (error) {
                showCustomResultDialog(error.message);
            }
        }

        // БЕЗОПАСНЫЕ МИНИ-ИГРЫ: головоломки с фиксированной наградой.
        const arcadeGameNames = { mines:"Сапёр: логика", crypto:"Крипто-график", dice:"Быстрый счёт", plinko:"Числовая цепочка", doors:"Загадка дверей" };
        let currentArcadeGame = null;
        let currentArcadeChallenge = null;
        let arcadeSelectedAnswer = null;
        let arcadeSelectedNumbers = new Set();
        let arcadeRequestInFlight = false;

        function openEmbeddedGame(gameKey) {
            if (!Object.prototype.hasOwnProperty.call(arcadeGameNames, gameKey)) return;
            document.getElementById('games-selection-grid').style.display = 'none';
            document.querySelectorAll('.embedded-game-view').forEach((view) => { view.style.display = 'none'; });
            document.getElementById('view-game-' + gameKey).style.display = 'flex';
            currentArcadeGame = gameKey;
            loadArcadeChallenge(gameKey);
        }

        function closeEmbeddedGame(gameKey) {
            const view = document.getElementById('view-game-' + gameKey);
            if (view) view.style.display = 'none';
            document.getElementById('games-selection-grid').style.display = 'grid';
            currentArcadeGame = null;
            currentArcadeChallenge = null;
            arcadeSelectedAnswer = null;
            arcadeSelectedNumbers.clear();
        }

        async function loadArcadeChallenge(gameKey) {
            const prompt = document.getElementById('arcade-prompt-' + gameKey);
            const body = document.getElementById('arcade-body-' + gameKey);
            const feedback = document.getElementById('arcade-feedback-' + gameKey);
            const submit = document.getElementById('arcade-submit-' + gameKey);
            body.replaceChildren();
            feedback.textContent = '';
            submit.disabled = true;
            prompt.textContent = 'Загружаем головоломку...';
            if (!isReady) {
                prompt.textContent = bootstrapError || 'Сначала дождись подключения аккаунта.';
                return;
            }
            try {
                const data = await apiRequest('arcadeChallenge', { game: gameKey });
                applyUser(data.user);
                currentArcadeChallenge = data.challenge;
                if (data.completed || arcadeCompletedToday.includes(gameKey)) {
                    prompt.textContent = 'Эта головоломка уже пройдена сегодня.';
                    feedback.textContent = 'Награда за сегодня уже получена. Новые задания появятся завтра.';
                    return;
                }
                renderArcadeChallenge(gameKey, data.challenge);
            } catch (error) {
                prompt.textContent = 'Не удалось загрузить задание.';
                feedback.textContent = error.message;
            }
        }

        function addArcadeOption(gameKey, label, value) {
            const body = document.getElementById('arcade-body-' + gameKey);
            const container = body.querySelector('.arcade-options-row') || body;
            const option = document.createElement('button');
            option.type = 'button';
            option.className = 'arcade-option';
            option.textContent = String(label);
            option.dataset.value = String(value);
            option.addEventListener('click', () => {
                container.querySelectorAll('.arcade-option').forEach((item) => item.classList.remove('selected'));
                option.classList.add('selected');
                arcadeSelectedAnswer = option.dataset.value;
                document.getElementById('arcade-submit-' + gameKey).disabled = false;
            });
            container.appendChild(option);
        }

        function renderArcadeChallenge(gameKey, challenge) {
            const prompt = document.getElementById('arcade-prompt-' + gameKey);
            const body = document.getElementById('arcade-body-' + gameKey);
            const submit = document.getElementById('arcade-submit-' + gameKey);
            prompt.textContent = challenge.prompt;
            body.replaceChildren();
            body.classList.remove('arcade-number-grid', 'arcade-chart', 'arcade-options-grid');
            arcadeSelectedAnswer = null;
            arcadeSelectedNumbers = new Set();

            if (challenge.type === 'grid') {
                body.classList.add('arcade-number-grid');
                challenge.cells.forEach((number) => {
                    const cell = document.createElement('button');
                    cell.type = 'button';
                    cell.className = 'arcade-number-cell';
                    cell.textContent = String(number);
                    cell.addEventListener('click', () => {
                        if (arcadeSelectedNumbers.has(number)) {
                            arcadeSelectedNumbers.delete(number);
                            cell.classList.remove('selected');
                        } else if (arcadeSelectedNumbers.size < challenge.required) {
                            arcadeSelectedNumbers.add(number);
                            cell.classList.add('selected');
                        }
                        document.getElementById('arcade-feedback-' + gameKey).textContent =
                            'Выбрано: ' + arcadeSelectedNumbers.size + ' из ' + challenge.required;
                        submit.disabled = arcadeSelectedNumbers.size !== challenge.required;
                    });
                    body.appendChild(cell);
                });
            } else if (challenge.type === 'trend') {
                body.classList.add('arcade-chart');
                const min = Math.min(...challenge.values);
                const max = Math.max(...challenge.values);
                const range = Math.max(1, max - min);
                challenge.values.forEach((value) => {
                    const bar = document.createElement('div');
                    bar.className = 'arcade-chart-bar';
                    bar.style.height = (24 + ((value - min) / range) * 90) + 'px';
                    const label = document.createElement('span');
                    label.textContent = String(value);
                    bar.appendChild(label);
                    body.appendChild(bar);
                });
                const options = document.createElement('div');
                options.className = 'arcade-options-row';
                body.appendChild(options);
                addArcadeOption(gameKey, 'Вверх ▲', 'up');
                addArcadeOption(gameKey, 'Вниз ▼', 'down');
            } else {
                body.classList.add('arcade-options-grid');
                challenge.options.forEach((option, index) => {
                    const isRiddle = challenge.type === 'riddle';
                    addArcadeOption(gameKey, isRiddle ? option : String(option), isRiddle ? index : option);
                });
            }
            submit.disabled = true;
        }

        async function submitArcadeGame() {
            const gameKey = currentArcadeGame;
            if (!gameKey || !currentArcadeChallenge || arcadeRequestInFlight) return;
            const submit = document.getElementById('arcade-submit-' + gameKey);
            const feedback = document.getElementById('arcade-feedback-' + gameKey);
            if (currentArcadeChallenge.type === 'grid' && arcadeSelectedNumbers.size !== currentArcadeChallenge.required) return;
            if (currentArcadeChallenge.type !== 'grid' && arcadeSelectedAnswer === null) return;
            const answer = currentArcadeChallenge.type === 'grid'
                ? Array.from(arcadeSelectedNumbers)
                : arcadeSelectedAnswer;
            arcadeRequestInFlight = true;
            submit.disabled = true;
            submit.textContent = 'ПРОВЕРЯЕМ...';
            try {
                const data = await apiRequest('arcadeComplete', { game: gameKey, answer });
                applyUser(data.user);
                if (data.correct) {
                    feedback.textContent = 'Правильно! Награда начислена: +' + data.reward + ' монет.';
                    submit.textContent = 'ПРОЙДЕНО СЕГОДНЯ';
                    submit.disabled = true;
                    showCustomResultDialog('Отлично! Ты решил головоломку и получил <span style="color:#22c55e;">+' +
                        data.reward.toLocaleString() + '</span> <img src="assets/images/coin.png">.');
                } else {
                    feedback.textContent = 'Не совсем. Попробуй ещё раз — монеты не списываются.';
                    submit.textContent = 'ПРОВЕРИТЬ';
                    submit.disabled = currentArcadeChallenge.type === 'grid'
                        ? arcadeSelectedNumbers.size !== currentArcadeChallenge.required
                        : arcadeSelectedAnswer === null;
                }
            } catch (error) {
                feedback.textContent = error.message;
                submit.textContent = 'ПРОВЕРИТЬ';
                submit.disabled = false;
            } finally {
                arcadeRequestInFlight = false;
            }
        }

        async function claimTask(taskKey) {
            if (!isReady) {
                showCustomResultDialog(bootstrapError || 'Приложение ещё подключается к серверу.');
                return;
            }
            const button = document.getElementById('task-claim-' + taskKey);
            if (button) button.disabled = true;
            try {
                const data = await apiRequest('claimTask', { task: taskKey });
                applyUser(data.user);
                showCustomResultDialog('Задание выполнено! Начислено <span style="color:#22c55e;">+' +
                    data.reward.toLocaleString() + '</span> <img src="assets/images/coin.png">.');
            } catch (error) {
                updateTasksUI();
                showCustomResultDialog(error.message);
            }
        }

        function updateTasksUI() {
            const completedGames = arcadeCompletedToday.length;
            const tasks = [
                { key: 'tap50', progress: Math.min(tapsToday, 50), target: 50, ready: tapsToday >= 50 },
                { key: 'game1', progress: Math.min(completedGames, 1), target: 1, ready: completedGames >= 1 },
                { key: 'game3', progress: Math.min(completedGames, 3), target: 3, ready: completedGames >= 3 }
            ];
            tasks.forEach((task) => {
                const progress = document.getElementById('task-progress-' + task.key);
                const button = document.getElementById('task-claim-' + task.key);
                if (!progress || !button) return;
                const claimed = taskClaimsToday.includes(task.key);
                progress.textContent = task.progress + ' / ' + task.target;
                button.textContent = claimed ? 'ЗАБРАНО' : 'ЗАБРАТЬ';
                button.disabled = !isReady || claimed || !task.ready;
            });
        }

                // АДМИН ОПЕРАЦИИ
        async function adminGive() {
            if (!isAdmin) return;
            try {
                const data = await apiRequest('adminGive', {
                    targetId: document.getElementById('target-id').value.trim(),
                    amount: Number(document.getElementById('amount-give').value)
                });
                showCustomResultDialog(`Ресурсы успешно отправлены пользователю ${data.targetId}!`);
            } catch (error) {
                showCustomResultDialog(error.message);
            }
        }

        async function adminWipe() {
            if (!isAdmin) return;
            const targetId = document.getElementById('target-id').value.trim();
            if(!targetId) return;

            if (confirm("Вы действительно хотите полностью обнулить этого игрока?")) {
                try {
                    await apiRequest('adminWipe', { targetId });
                    showCustomResultDialog(`Данные игрока ${targetId} были успешно сброшены.`);
                } catch (error) {
                    showCustomResultDialog(error.message);
                }
            }
        }

        // ЛИДЕРБОРД ТОП 10
        async function loadLeaderboard() {
            const lContainer = document.getElementById('leaderboard');
            if (!isReady) return;
            lContainer.textContent = 'Загрузка топа...';
            try {
                const data = await apiRequest('leaderboard');
                lContainer.replaceChildren();
                if (data.leaderboard.length === 0) {
                    lContainer.textContent = 'В топе пока нет активных игроков';
                    return;
                }
                data.leaderboard.forEach((player, index) => {
                    const card = document.createElement('div');
                    card.className = 'leaderboard-card';
                    const info = document.createElement('div');
                    info.className = 'leaderboard-info';
                    const name = document.createElement('div');
                    name.className = 'leaderboard-name';
                    name.textContent = `${index + 1}. ${player.name}${player.username !== 'none' ? ` (@${player.username})` : ''}`;
                    info.appendChild(name);
                    if (isAdmin && player.uid) {
                        const uid = document.createElement('div');
                        uid.className = 'leaderboard-uid';
                        uid.textContent = `ID: ${player.uid}`;
                        info.appendChild(uid);
                    }
                    const score = document.createElement('div');
                    score.className = 'leaderboard-score';
                    score.append(document.createTextNode(player.coins.toLocaleString()));
                    const icon = document.createElement('img');
                    icon.src = 'assets/images/coin.png';
                    icon.className = 'coin-mini-icon';
                    score.appendChild(icon);
                    card.append(info, score);
                    lContainer.appendChild(card);
                });
            } catch (error) {
                lContainer.textContent = error.message;
            }
        }

        // СМЕНА ЯЗЫКА
        function setLanguage(lang) {
            currentLang = lang;
            localStorage.setItem('cc_lang', lang);

            document.getElementById('lang-ru').classList.toggle('active', lang === 'ru');
            document.getElementById('lang-en').classList.toggle('active', lang === 'en');
            
            document.getElementById('nv-game').innerText = langData[lang].nv_game;
            document.getElementById('nv-shop').innerText = langData[lang].nv_shop;
            document.getElementById('nv-tasks').innerText = langData[lang].nv_tasks;
            document.getElementById('nv-games').innerText = langData[lang].nv_games;
            document.getElementById('nv-profile').innerText = langData[lang].nv_profile;
            document.getElementById('lbl-stats-header').innerText = lang === 'ru' ? "Статистика" : "Statistics";
            document.getElementById('lbl-lead-title').innerText = langData[lang].top_title;

            document.getElementById('st-coins').innerText = langData[lang].st_1;
            document.getElementById('st-taps').innerText = langData[lang].st_2;
            document.getElementById('st-won').innerText = langData[lang].st_3;
            document.getElementById('st-profit').innerText = langData[lang].st_4;
            document.getElementById('st-streak').innerText = langData[lang].st_5;
            document.getElementById('st-wheel').innerText = langData[lang].st_6;
            
            document.getElementById('lbl-bonus-title').innerText = lang === 'ru' ? "Ежедневный Бонус" : "Daily Bonus";
            document.getElementById('lbl-bonus-desc').innerText = lang === 'ru' ? 
                "Заходите каждый день и собирайте горы монет! Не пропускайте дни, иначе стрик сбросится." : 
                "Claim rewards every single day! Don't skip a day, otherwise your streak will be reset.";


            updateUI();
            initTelegramProfile();
        }

        // Отображаем восстановление энергии; сервер остаётся источником истины.
        setInterval(() => {
            if (energy < 100) {
                energy++;
                updateUI();
            }
        }, 1000);
        
        // Сразу выставляем состояние и затем обновляем таймер раз в секунду.
        updateBonusButtonState();
        setInterval(updateBonusButtonState, 1000);

        setLanguage(currentLang);
        bootstrap();
    