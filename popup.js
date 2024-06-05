document.addEventListener('DOMContentLoaded', function() {
	const startTimeInput = document.getElementById('startTime');
	const endTimeInput = document.getElementById('endTime');
	const saveButton = document.getElementById('saveButton');
	const disableButton = document.getElementById('disableButton');

	const messageDiv = document.getElementById('message');
	function showMessage(message) {
		messageDiv.textContent = message;
		messageDiv.style.display = 'block';
		setTimeout(() => {
			messageDiv.style.display = 'none';
		}, 3000);
	}

  // Отримати поточні значення налаштувань з chrome.storage
  chrome.storage.sync.get(['skipStartSeconds', 'skipEndSeconds', 'isEnabled'], function(data) {
    startTimeInput.value = data.skipStartSeconds || 0;
    endTimeInput.value = data.skipEndSeconds || 0;
	const isEnabled = data.isEnabled !== false; // За замовчуванням true, якщо isEnabled не встановлено
    disableButton.textContent = isEnabled ? 'Disable Extension' : 'Enable Extension';
  });

  // Обробник події для збереження змін
  saveButton.addEventListener('click', function() {
    // Отримати значення з полів вводу
    const skipStartSeconds = parseInt(startTimeInput.value, 10);
    const skipEndSeconds = parseInt(endTimeInput.value, 10);

    // Зберегти нові значення в chrome.storage
    chrome.storage.sync.set({ skipStartSeconds, skipEndSeconds }, function() {
      // Перевірити, чи не сталася помилка при збереженні
      if (chrome.runtime.lastError) {
        console.error(chrome.runtime.lastError);
        return;
      }

      // Застосувати зміни до вже відкритих сторінок
      chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
        tabs.forEach(tab => {
          chrome.tabs.sendMessage(tab.id, { action: 'applySettings', skipStartSeconds, skipEndSeconds });
        });
      });

      // Відобразити повідомлення про успішне збереження
      showMessage('Налаштування збережені!');
    });
  });
  
  // Обробник події для вимкнення розширення
  disableButton.addEventListener('click', function() {
    chrome.storage.sync.get('isEnabled', function(data) {
      const newStatus = data.isEnabled === false ? true : false;
      chrome.storage.sync.set({ isEnabled: newStatus }, function() {
        if (chrome.runtime.lastError) {
          console.error(chrome.runtime.lastError);
          return;
        }

        disableButton.textContent = newStatus ? 'Disable Extension' : 'Enable Extension';

        chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
          tabs.forEach(tab => {
            chrome.tabs.sendMessage(tab.id, { action: newStatus ? 'enableExtension' : 'disableExtension' });
          });
        });

        showMessage(newStatus ? 'Extension enabled!' : 'Extension disabled!');
      });
    });
  });
});
