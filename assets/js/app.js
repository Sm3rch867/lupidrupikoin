
        // ЛОКАЛИЗАЦИЯ
        const langData = {
            ru: {
                nv_game: "Главная", nv_shop: "Магазин", nv_tasks: "Задания", nv_games: "Игры", nv_profile: "Профиль",
                top_title: "ТОП ИГРОКОВ 🏆", day: "День",
                st_1: "Количество монет", st_2: "Количество тапов", st_3: "Выиграно в мини играх",
                st_4: "Прибыль", st_5: "Стрик наград", st_6: "Прокрутил колесо фортуны"
            },
            en: {
                nv_game: "Main", nv_shop: "Shop", nv_tasks: "Tasks", nv_games: "Games", nv_profile: "Profile",
                top_title: "TOP PLAYERS 🏆", day: "Day",
                st_1: "Coins balance", st_2: "Total taps", st_3: "Won in mini games",
                st_4: "Net profit", st_5: "Reward streak", st_6: "Wheel spins completed"
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
            energy = user.energy;
            nextClaimAt = user.nextClaimAt;
            isAdmin = user.isAdmin;
            tgUser = { id: user.uid, first_name: user.name, username: user.username };
            document.getElementById('admin-area').style.display = isAdmin ? 'block' : 'none';
            updateUI();
            initTelegramProfile();
            if (!isReady) restoreActiveGame(user.activeGame);
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
            if(statsWheel) statsWheel.innerText = wheelSpins;

            document.getElementById('energy-num').innerText = `${energy} / 100`;
            document.getElementById('energy-fill').style.width = `${energy}%`;

            checkBonusDotNotification();
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
            document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
            document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
            
            document.getElementById(screenId + '-scr').classList.add('active');
            document.getElementById('n-' + screenId).classList.add('active');

            if (screenId !== 'games') {
                if (cryptoInterval) {
                    clearInterval(cryptoInterval);
                    cryptoInterval = null;
                }
                if (plinkoFrameId) {
                    cancelAnimationFrame(plinkoFrameId);
                    plinkoFrameId = null;
                }
            } else {
                const cryptoView = document.getElementById('view-game-crypto');
                if (cryptoView.style.display === 'flex' && !cryptoInterval) initCryptoGame();
                const plinkoView = document.getElementById('view-game-plinko');
                if (plinkoView.style.display === 'flex' && plinkoCanvas) {
                    updatePlinkoFrame();
                }
            }

            if(screenId === 'profile') {
                loadLeaderboard();
            }
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

        // ВХОД В МИНИ-ИГРЫ
        function openEmbeddedGame(gameKey) {
            document.getElementById('games-selection-grid').style.display = 'none';
            document.getElementById('view-game-' + gameKey).style.display = 'flex';
            if(gameKey === 'crypto') initCryptoGame();
            if(gameKey === 'plinko') initPlinkoGame();
        }

        function closeEmbeddedGame(gameKey) {
            document.getElementById('view-game-' + gameKey).style.display = 'none';
            document.getElementById('games-selection-grid').style.display = 'grid';
            if(gameKey === 'crypto' && cryptoInterval) {
                clearInterval(cryptoInterval);
                cryptoInterval = null;
            }
            if(gameKey === 'plinko' && plinkoFrameId) {
                cancelAnimationFrame(plinkoFrameId);
                plinkoFrameId = null;
            }
        }

        // САПЁР МЕХАНИКА
        let minesBoard = [];
        let minesOpened = 0;
        let minesActive = false;
        let currentMinesBet = 0;
        let minesRequestInFlight = false;

        function renderMinesBoard(opened = []) {
            const grid = document.getElementById('mines-grid-board');
            grid.replaceChildren();
            for (let i = 0; i < 25; i++) {
                const tile = document.createElement('div');
                tile.className = 'mines-tile';
                tile.id = 'tile-' + i;
                tile.textContent = '?';
                tile.onclick = () => clickMinesTile(i);
                if (opened.includes(i)) {
                    tile.classList.add('opened');
                    tile.textContent = '💎';
                }
                grid.appendChild(tile);
            }
        }

        function restoreActiveGame(activeGame) {
            if (!activeGame) {
                minesActive = false;
                doorsActive = false;
                document.getElementById('mines-btn-start').disabled = false;
                document.getElementById('mines-btn-cashout').disabled = true;
                document.getElementById('doors-btn-start').disabled = false;
                document.getElementById('doors-btn-take').disabled = true;
                return;
            }
            if (activeGame.type === 'mines' && !minesActive) {
                minesActive = true;
                currentMinesBet = activeGame.bet;
                minesOpened = activeGame.opened.length;
                minesBoard = Array(25).fill(false);
                document.getElementById('mines-count').value = activeGame.mineCount;
                document.getElementById('mines-multiplier').innerText = activeGame.multiplier.toFixed(2);
                document.getElementById('mines-btn-start').disabled = true;
                document.getElementById('mines-btn-cashout').disabled = minesOpened === 0;
                renderMinesBoard(activeGame.opened);
            } else if (activeGame.type === 'doors' && !doorsActive) {
                doorsActive = true;
                doorsRoom = activeGame.room;
                currentDoorsBet = activeGame.bet;
                document.getElementById('doors-multiplier').innerText = activeGame.multiplier.toFixed(2);
                document.getElementById('lbl-doors-room').innerText = `Комната: ${doorsRoom}`;
                document.getElementById('doors-btn-start').disabled = true;
                document.getElementById('doors-btn-take').disabled = doorsRoom <= 1;
                generateDoorsLayout();
            }
        }

        async function startMinesGame() {
            if (!isReady || minesRequestInFlight) return;
            const bInput = document.getElementById('mines-bet');
            const bet = Number(bInput.value);
            const startButton = document.getElementById('mines-btn-start');
            minesRequestInFlight = true;
            startButton.disabled = true;
            try {
                const data = await apiRequest('minesStart', {
                    bet,
                    mineCount: Number(document.getElementById('mines-count').value)
                });
                applyUser(data.user);
                restoreActiveGame(data.user.activeGame);
            } catch (error) {
                startButton.disabled = false;
                showCustomResultDialog(error.message);
            } finally {
                minesRequestInFlight = false;
            }
        }

        async function clickMinesTile(idx) {
            if (!minesActive || minesRequestInFlight) return;
            const tile = document.getElementById('tile-' + idx);
            if (!tile || tile.classList.contains('opened') || tile.classList.contains('mine')) return;
            minesRequestInFlight = true;
            try {
                const data = await apiRequest('minesOpen', { index: idx });
                if (data.hitMine) {
                    minesBoard = Array(25).fill(false);
                    data.mines.forEach((mine) => { minesBoard[mine] = true; });
                    tile.classList.add('mine');
                    tile.textContent = '💣';
                    applyUser(data.user);
                    minesActive = false;
                    document.getElementById('mines-btn-start').disabled = false;
                    document.getElementById('mines-btn-cashout').disabled = true;
                    revealMinesBoard();
                    showCustomResultDialog("Бум! Вы попали на мину. Ставка проиграна.");
                } else {
                    applyUser(data.user);
                    tile.classList.add('opened');
                    tile.textContent = '💎';
                    minesOpened += 1;
                    const game = data.user.activeGame;
                    document.getElementById('mines-multiplier').innerText = game.multiplier.toFixed(2);
                    document.getElementById('mines-btn-cashout').disabled = false;
                }
            } catch (error) {
                showCustomResultDialog(error.message);
            } finally {
                minesRequestInFlight = false;
            }
        }

        function revealMinesBoard() {
            for(let i=0; i<25; i++) {
                const tile = document.getElementById('tile-' + i);
                if(tile && minesBoard[i]) {
                    tile.classList.add('mine');
                    tile.innerText = "💣";
                }
            }
        }

        async function cashoutMinesGame() {
            if (!minesActive || minesOpened === 0 || minesRequestInFlight) return;
            minesRequestInFlight = true;
            try {
                const data = await apiRequest('minesCashout');
                minesBoard = Array(25).fill(false);
                data.mines.forEach((mine) => { minesBoard[mine] = true; });
                applyUser(data.user);
                minesActive = false;
                document.getElementById('mines-btn-start').disabled = false;
                document.getElementById('mines-btn-cashout').disabled = true;
                revealMinesBoard();
                showCustomResultDialog(`Отлично! Вы забрали куш: <span style="color:#22c55e;">+${data.prize.toLocaleString()}</span> <img src="assets/images/coin.png">!`);
            } catch (error) {
                showCustomResultDialog(error.message);
            } finally {
                minesRequestInFlight = false;
            }
        }

        // КРИПТО-ИНТУИТ МЕХАНИКА
        let cryptoCanvas, cryptoCtx, cryptoInterval;
        let cryptoPoints = [];
        let cryptoCurrentVal = 100;
        let cryptoRequestInFlight = false;

        function initCryptoGame() {
            if (cryptoInterval) clearInterval(cryptoInterval);
            cryptoCanvas = document.getElementById('crypto-canvas-el');
            cryptoCtx = cryptoCanvas.getContext('2d');
            cryptoPoints = [100, 102, 99, 101, 105, 103, 106];
            cryptoCurrentVal = 106;
            drawCryptoChart();

            cryptoInterval = setInterval(() => {
                cryptoCurrentVal += (Math.random() - 0.49) * 4;
                cryptoPoints.push(cryptoCurrentVal);
                if(cryptoPoints.length > 25) cryptoPoints.shift();
                drawCryptoChart();
            }, 800);
        }

        function drawCryptoChart() {
            const w = cryptoCanvas.width = cryptoCanvas.parentElement.clientWidth;
            const h = cryptoCanvas.height = 150;
            cryptoCtx.clearRect(0,0,w,h);

            cryptoCtx.strokeStyle = "#2563eb";
            cryptoCtx.lineWidth = 3;
            cryptoCtx.beginPath();

            const step = w / 25;
            const min = Math.min(...cryptoPoints) - 5;
            const maxValue = Math.max(...cryptoPoints) + 5;
            const max = maxValue > min ? maxValue : min + 1;

            cryptoPoints.forEach((p, i) => {
                const x = i * step;
                const y = h - ((p - min) / (max - min)) * h;
                if(i === 0) cryptoCtx.moveTo(x,y);
                else cryptoCtx.lineTo(x,y);
            });
            cryptoCtx.stroke();
        }

        function playCrypto(direction) {
            if (!isReady || cryptoRequestInFlight) return;
            const betInput = document.getElementById('crypto-bet');
            const bet = Number(betInput.value);
            const initialPrice = cryptoCurrentVal;
            cryptoRequestInFlight = true;
            document.getElementById('lbl-crypto-status').innerText = "Анализ рынка (3с)...";
            document.getElementById('crypto-actions-row').style.pointerEvents = 'none';
            setTimeout(async () => {
                try {
                    const data = await apiRequest('crypto', { bet, direction });
                    applyUser(data.user);
                    cryptoCurrentVal = initialPrice + (data.wentUp ? 5 : -5);
                    cryptoPoints.push(cryptoCurrentVal);
                    if (cryptoPoints.length > 25) cryptoPoints.shift();
                    drawCryptoChart();
                    const trend = data.wentUp ? 'вверх' : 'вниз';
                    showCustomResultDialog(data.won
                        ? `График пошёл ${trend}. Вы угадали! <span style="color:#22c55e;">+${data.prize.toLocaleString()}</span> <img src="assets/images/coin.png">`
                        : `График пошёл ${trend}. Ставка проиграна.`);
                } catch (error) {
                    showCustomResultDialog(error.message);
                } finally {
                    cryptoRequestInFlight = false;
                    document.getElementById('lbl-crypto-status').innerText = "Ожидание...";
                    document.getElementById('crypto-actions-row').style.pointerEvents = 'auto';
                }
            }, 3000);
        }

        // DICE МЕХАНИКА
        let currentDiceMode = 'gt'; 
        let selectedDiceExact = 1;

        function setDiceMode(mode) {
            currentDiceMode = mode;
            document.querySelectorAll('.dice-tab').forEach(t => t.classList.remove('active'));
            document.getElementById('dice-tab-' + mode).classList.add('active');

            const wrapper = document.getElementById('dice-options-wrapper');
            const kLbl = document.getElementById('dice-current-k');

            if(mode === 'eq') {
                wrapper.style.display = 'block';
                kLbl.innerText = "5.50";
            } else {
                wrapper.style.display = 'none';
                kLbl.innerText = "1.90";
            }
        }

        function selectDiceNum(num) {
            selectedDiceExact = num;
            document.querySelectorAll('.dice-num-btn').forEach((b, i) => {
                b.classList.toggle('active', (i+1) === num);
            });
        }

        function rollDiceGame() {
            if (!isReady) return;
            const betInput = document.getElementById('dice-bet');
            const bet = Number(betInput.value);
            const mode = currentDiceMode;
            const selectedNumber = selectedDiceExact;
            const rollBtn = document.getElementById('dice-roll-btn');
            rollBtn.disabled = true;

            let ticks = 0;
            const visual = document.getElementById('dice-visual-box');
            
            const timer = setInterval(() => {
                visual.innerText = Math.floor(Math.random() * 6) + 1;
                ticks++;
                if(ticks > 8) {
                    clearInterval(timer);
                    apiRequest('dice', { bet, mode, number: selectedNumber })
                        .then((data) => {
                            applyUser(data.user);
                            visual.innerText = data.roll;
                            showCustomResultDialog(data.won
                                ? `Выпало число ${data.roll}. Победа! <span style="color:#22c55e;">+${data.prize.toLocaleString()}</span> <img src="assets/images/coin.png">`
                                : `Выпало число ${data.roll}. Повезёт в следующий раз!`);
                        })
                        .catch((error) => showCustomResultDialog(error.message))
                        .finally(() => { rollBtn.disabled = false; });
                }
            }, 100);
        }

        // PLINKO МЕХАНИКА
        let plinkoCanvas, plinkoCtx, plinkoBalls = [];
        let plinkoFrameId = null;
        let plinkoRequestInFlight = false;
        const plinkoPins = [];
        const plinkoRows = 7;
        const plinkoBuckets = [5, 2, 0.5, 0.2, 0.5, 2, 5];

        function initPlinkoGame() {
            plinkoCanvas = document.getElementById('plinko-canvas-el');
            plinkoCtx = plinkoCanvas.getContext('2d');
            
            plinkoPins.length = 0;
            const h = 260;
            const startY = 40;
            const rowSpacing = 22;

            for (let r = 0; r < plinkoRows; r++) {
                const count = r + 3;
                const rowY = startY + r * rowSpacing;
                for (let i = 0; i < count; i++) {
                    plinkoPins.push({ r: r, i: i, count: count, y: rowY });
                }
            }
            updatePlinkoFrame();
        }

        function updatePlinkoFrame() {
            if (!plinkoCanvas || !plinkoCtx) return;
            const w = plinkoCanvas.width = plinkoCanvas.parentElement.clientWidth;
            const h = plinkoCanvas.height = 260;
            plinkoCtx.clearRect(0, 0, w, h);

            plinkoCtx.fillStyle = "#475467";
            plinkoPins.forEach(p => {
                const rowW = (p.count - 1) * 24;
                const startX = (w - rowW) / 2;
                p.x = startX + p.i * 24;
                plinkoCtx.beginPath();
                plinkoCtx.arc(p.x, p.y, 3, 0, Math.PI * 2);
                plinkoCtx.fill();
            });

            const bY = h - 20;
            const bW = w / plinkoBuckets.length;
            plinkoCtx.font = "bold 10px Arial";
            plinkoCtx.textAlign = "center";

            plinkoBuckets.forEach((b, idx) => {
                const bx = idx * bW;
                plinkoCtx.fillStyle = b >= 2 ? "#7f1d1d" : (b < 1 ? "#1e293b" : "#14532d");
                plinkoCtx.fillRect(bx + 2, bY, bW - 4, 16);
                plinkoCtx.fillStyle = "white";
                plinkoCtx.fillText(b + "x", bx + bW/2, bY + 12);
            });

            plinkoCtx.fillStyle = "#ffb020";
            for (let i = plinkoBalls.length - 1; i >= 0; i--) {
                const ball = plinkoBalls[i];
                ball.frames += 1;
                ball.y += ball.vy;
                ball.x += (ball.targetX - ball.x) * 0.045;
                ball.vy += 0.18;

                plinkoCtx.beginPath();
                plinkoCtx.arc(ball.x, ball.y, 5, 0, Math.PI * 2);
                plinkoCtx.fill();

                if (ball.y >= bY || ball.frames >= 180) {
                    showCustomResultDialog(`Шар упал в ячейку ${ball.multiplier}x. Выигрыш: <span style="color:#22c55e;">+${ball.prize.toLocaleString()}</span> <img src="assets/images/coin.png">!`);
                    plinkoBalls.splice(i, 1);
                }
            }

            if (plinkoBalls.length) {
                plinkoFrameId = requestAnimationFrame(updatePlinkoFrame);
            } else {
                plinkoFrameId = null;
                document.getElementById('plinko-drop-btn').disabled = false;
            }
        }

        async function startPlinkoBall() {
            if (!isReady || plinkoRequestInFlight || plinkoBalls.length) return;
            const betInput = document.getElementById('plinko-bet');
            const bet = Number(betInput.value);
            plinkoRequestInFlight = true;
            document.getElementById('plinko-drop-btn').disabled = true;
            try {
                const data = await apiRequest('plinko', { bet });
                applyUser(data.user);
                const bucketWidth = plinkoCanvas.width / plinkoBuckets.length;
                plinkoBalls.push({
                    x: plinkoCanvas.width / 2,
                    targetX: (data.slot + 0.5) * bucketWidth,
                    y: 10,
                    vy: 1.5,
                    frames: 0,
                    multiplier: data.multiplier,
                    prize: data.prize
                });
                if (!plinkoFrameId) plinkoFrameId = requestAnimationFrame(updatePlinkoFrame);
            } catch (error) {
                document.getElementById('plinko-drop-btn').disabled = false;
                showCustomResultDialog(error.message);
            } finally {
                plinkoRequestInFlight = false;
            }
        }

        // ДВЕРИ МЕХАНИКА
        let doorsActive = false;
        let doorsRoom = 0;
        let currentDoorsBet = 0;
        let doorsRequestInFlight = false;
        let doorsRoomTimer = null;

        async function startDoorsGame() {
            if (!isReady || doorsRequestInFlight) return;
            const bInput = document.getElementById('doors-bet');
            doorsRequestInFlight = true;
            document.getElementById('doors-btn-start').disabled = true;
            try {
                const data = await apiRequest('doorsStart', { bet: Number(bInput.value) });
                applyUser(data.user);
                restoreActiveGame(data.user.activeGame);
            } catch (error) {
                document.getElementById('doors-btn-start').disabled = false;
                showCustomResultDialog(error.message);
            } finally {
                doorsRequestInFlight = false;
            }
        }

        function generateDoorsLayout() {
            const container = document.getElementById('doors-tiles-wrapper');
            container.replaceChildren();
            for (let i = 0; i < 3; i++) {
                const door = document.createElement('div');
                door.className = 'door-element';
                door.id = 'door-' + i;
                door.textContent = `🚪 Дверь ${i + 1}`;
                door.onclick = () => chooseDoorElement(i);
                container.appendChild(door);
            }
        }

        async function chooseDoorElement(idx) {
            if (!doorsActive || doorsRequestInFlight) return;
            doorsActive = false;
            doorsRequestInFlight = true;
            const dEl = document.getElementById('door-' + idx);
            try {
                const data = await apiRequest('doorsChoose', { index: idx });
                applyUser(data.user);
                if (data.wonRoom) {
                    dEl.classList.add('win');
                    dEl.textContent = "💎 Сокровища!";
                    doorsRoom = data.user.activeGame.room;
                    document.getElementById('doors-multiplier').innerText = data.user.activeGame.multiplier.toFixed(2);
                    document.getElementById('lbl-doors-room').innerText = `Комната: ${doorsRoom}`;
                    document.getElementById('doors-btn-take').disabled = false;
                    doorsRoomTimer = setTimeout(() => {
                        doorsRoomTimer = null;
                        if (!data.user.activeGame) return;
                        doorsActive = true;
                        generateDoorsLayout();
                    }, 600);
                } else {
                    dEl.classList.add('lose');
                    dEl.textContent = "👾 Монстр!";
                    doorsActive = false;
                    document.getElementById('doors-btn-start').disabled = false;
                    document.getElementById('doors-btn-take').disabled = true;
                    showCustomResultDialog("О нет! За дверью оказался монстр. Комната проиграна.");
                }
            } catch (error) {
                doorsActive = true;
                showCustomResultDialog(error.message);
            } finally {
                doorsRequestInFlight = false;
            }
        }

        async function takeDoorsPrize() {
            if (doorsRoom <= 1 || doorsRequestInFlight) return;
            if (doorsRoomTimer) {
                clearTimeout(doorsRoomTimer);
                doorsRoomTimer = null;
            }
            doorsActive = false;
            doorsRequestInFlight = true;
            document.getElementById('doors-btn-take').disabled = true;
            try {
                const data = await apiRequest('doorsCashout');
                applyUser(data.user);
                document.getElementById('doors-btn-start').disabled = false;
                document.getElementById('doors-tiles-wrapper').replaceChildren();
                showCustomResultDialog(`Вы благополучно покинули замок! Награда: <span style="color:#22c55e;">+${data.prize.toLocaleString()}</span> <img src="assets/images/coin.png">!`);
            } catch (error) {
                doorsActive = true;
                document.getElementById('doors-btn-take').disabled = false;
                showCustomResultDialog(error.message);
            } finally {
                doorsRequestInFlight = false;
            }
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

            document.getElementById('lbl-mines-b').innerText = lang === 'ru' ? "Ставка:" : "Bet:";
            document.getElementById('lbl-mines-m').innerText = lang === 'ru' ? "Мины:" : "Mines:";
            document.getElementById('lbl-crypto-b').innerText = lang === 'ru' ? "Ставка:" : "Bet:";
            document.getElementById('lbl-dice-b').innerText = lang === 'ru' ? "Ставка:" : "Bet:";
            document.getElementById('lbl-plinko-b').innerText = lang === 'ru' ? "Ставка:" : "Bet:";
            document.getElementById('lbl-doors-b').innerText = lang === 'ru' ? "Ставка:" : "Bet:";

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
    