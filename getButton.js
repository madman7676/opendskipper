console.log("-!!!I'm running.");


let currentElement = null;
let isSelecting = false; // Активний режим вибору
const highlightStyle = "2px solid red";

function getXPath(el) {
    if (el.id) {
        return `//*[@id="${el.id}"]`;
    }

    const parts = [];
    while (el && el.nodeType === 1) {
        let index = 0;
        let sibling = el.previousSibling;
        while (sibling) {
        if (sibling.nodeType === 1 && sibling.tagName === el.tagName) {
            index++;
        }
        sibling = sibling.previousSibling;
        }

        const tagName = el.tagName.toLowerCase();
        const part = `${tagName}[${index + 1}]`;
        parts.unshift(part);
        el = el.parentNode;
    }

    return `/${parts.join("/")}`;
}


// Додаємо слухача для виділення елемента
document.addEventListener("mousemove", (e) => {
    if (!isSelecting) return;

    if (currentElement) currentElement.style.outline = "";
    currentElement = e.target;
    currentElement.style.outline = highlightStyle;

    // Надсилаємо поточний шлях до елемента
    const selector = getXPath(currentElement);
    chrome.runtime.sendMessage({ action: "update-path", selector });
    });

    // Зберігаємо обраний елемент після кліку
    document.addEventListener("click", (e) => {
    if (!isSelecting || !currentElement) return;

    e.preventDefault();
    e.stopPropagation();

    const selector = getXPath(currentElement);
    chrome.storage.sync.set({ selectedElement: selector }, () => {
        console.log("Елемент збережено:", selector);
    });

    currentElement.style.outline = "";
    currentElement = null;
    isSelecting = false; // Вимикаємо режим вибору
});

// Отримання унікального селектора
function getUniqueSelector(el) {
    if (el.id) return `#${el.id}`;
    if (el.className) return `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`;
    return el.tagName.toLowerCase();
}

// Слухач для активації/деактивації режиму вибору
chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "toggle-selection") {
        isSelecting = message.isEnabled;

        if (!isSelecting && currentElement) {
        currentElement.style.outline = ""; // Очищуємо виділення
        currentElement = null;
        }
    }
});
