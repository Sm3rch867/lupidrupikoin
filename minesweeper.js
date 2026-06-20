let minesGrid = [];
const MINES_COUNT = 5;

function openMinesweeperView() {
    document.getElementById('wheel-menu-view').style.display = 'none';
    document.getElementById('minesweeper-view').style.display = 'flex';
}

function closeMinesweeperView() {
    document.getElementById('minesweeper-view').style.display = 'none';
    document.getElementById('wheel-menu-view').style.display = 'grid';
}

function startMinesweeper() {
    coins -= 1000; updateUI();
    minesGrid = Array(25).fill(0);
    let planted = 0;
    while(planted < MINES_COUNT) {
        let pos = Math.floor(Math.random() * 25);
        if(minesGrid[pos] === 0) { minesGrid[pos] = 'mine'; planted++; }
    }
    const container = document.getElementById('mines-grid');
    container.innerHTML = '';
    for(let i=0; i<25; i++) {
        let btn = document.createElement('button');
        btn.className = 'q-btn';
        btn.style.height = '50px';
        btn.onclick = () => revealMine(btn, i);
        container.appendChild(btn);
    }
}

function revealMine(btn, idx) {
    if(minesGrid[idx] === 'mine') { btn.style.background = '#ef4444'; alert("Бум!"); }
    else { btn.style.background = '#22c55e'; coins += 200; updateUI(); }
}