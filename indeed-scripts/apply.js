(() => {
    const buttons = ['Continue', 'Submit your application'];

    setInterval(() => {
        const button = [...document.querySelectorAll('span')]
            .find(el => buttons.includes(el.textContent.trim()));

        if (button) {
            button.click();
            console.log(`Clicked: ${button.textContent.trim()}`);
        }
    }, 300);
})();