// Открытие экрана игры
function openMinesweeperView() {
    document.getElementById('games-scr').style.display = 'none';
    document.getElementById('minesweeper-view').style.display = 'block';
    createMinesweeperBoard();
}

// Закрытие экрана игры
function closeMinesweeperView() {
    document.getElementById('minesweeper-view').style.display = 'none';
    document.getElementById('games-scr').style.display = 'block';
}

// Создание поля 5x5
function createMinesweeperBoard() {
    const board = document.getElementById('mines-board');
    board.innerHTML = '';
    
    for (let i = 0; i < 25; i++) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.onclick = () => {
            if (cell.classList.contains('revealed')) return;
            cell.classList.add('revealed');
            
            // 20% шанс на мину
            if (Math.random() < 0.2) {
                cell.classList.add('mine');
                cell.innerText = '💣';
                alert("БАБАХ! Вы проиграли.");
                createMinesweeperBoard(); // Рестарт
            } else {
                cell.innerText = '💎';
                // Здесь добавь свою логику начисления монет
                // coins += 100; updateUI(); 
            }
        };
        board.appendChild(cell);
    }
}