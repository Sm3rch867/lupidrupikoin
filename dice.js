function rollDice() {
    let b = parseInt(document.getElementById('dice-bet-input').value);
    if (coins < b) { alert("Недостаточно монет"); return; }
    coins -= b; updateUI();

    const res = Math.floor(Math.random() * 6) + 1;
    document.getElementById('dice-display').innerText = res;
    
    if (res >= 4) { coins += b * 1.5; }
    updateUI(); saveAll();
}