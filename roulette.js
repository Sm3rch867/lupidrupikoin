function spinWheel() {
    let b = parseInt(document.getElementById('wheel-bet-input').value);
    if (coins < b) { tg.showAlert("Недостаточно монет"); return; }
    coins -= b; updateUI();
    
    const yellowPointer = document.getElementById('yellow-pointer');
    const deg = Math.floor(Math.random() * 360) + 1440;
    
    yellowPointer.style.transition = 'transform 3.5s cubic-bezier(0.17, 0.67, 0.12, 0.99)';
    yellowPointer.style.transform = `rotate(${deg}deg)`;

    setTimeout(() => {
        yellowPointer.style.transition = 'none';
        yellowPointer.style.transform = `rotate(${deg % 360}deg)`;
        // Логика победы/проигрыша
        updateUI(); saveAll();
    }, 3550);
}