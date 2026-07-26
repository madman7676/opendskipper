chrome.runtime.onMessage.addListener((message, sender) => {
    if (message.action === "toggle-selection") {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs.length > 0 && tabs[0].id) {
                chrome.scripting.executeScript(
                    {
                        target: { tabId: tabs[0].id },
                        files: ["getButton.js"],
                    },
                    () => {
                        // Перевіряємо, чи скрипт завантажився успішно
                        if (chrome.runtime.lastError) {
                            console.error("Error injecting script:", chrome.runtime.lastError.message);
                            return;
                        }

                        // Надсилаємо повідомлення після завантаження скрипта
                        chrome.tabs.sendMessage(tabs[0].id, {
                            action: "toggle-selection",
                            isEnabled: message.isEnabled,
                        }, (response) => {
                            if (chrome.runtime.lastError) {
                                console.error("Error sending message:", chrome.runtime.lastError.message);
                            } else {
                                console.log("Message sent successfully:", response);
                            }
                        });
                    }
                );
            }
        });
    }
});
