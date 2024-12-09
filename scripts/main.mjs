



document.getElementById("dark-mode-toggle").addEventListener('change', (event) => {
    document.body.classList.toggle('dark-mode');
	// save dark-mode state
	//localStorage.setItem('dark-mode', event.target.checked);
});