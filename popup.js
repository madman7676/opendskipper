document.addEventListener('DOMContentLoaded', function() {

  const expandButton = document.getElementById('expandButton');
  const calculator = document.getElementById('calculator');
  const body = document.body;

  expandButton.addEventListener('click', () => {
    if (calculator.style.display === 'none' || calculator.style.display === '') {
      calculator.style.display = 'block';
      body.style.width = '200px';
      body.style.height = '350px';
      expandButton.textContent = '↖';
    } else {
      calculator.style.display = 'none';
      body.style.width = '200px';
      body.style.height = 'auto';
      expandButton.textContent = '↘';
    }
  });

  document.getElementById('calculateButton').addEventListener('click', () => {
    const startMinutes = parseInt(document.getElementById('startMinutes').value) || 0;
    const startSeconds = parseInt(document.getElementById('startSeconds').value) || 0;
    const endMinutes = parseInt(document.getElementById('endMinutes').value) || 0;
    const endSeconds = parseInt(document.getElementById('endSeconds').value) || 0;
  
    const startTime = (startMinutes * 60) + startSeconds;
    const endTime = (endMinutes * 60) + endSeconds;
  
    let diffTime = endTime - startTime;
    const resultSeconds = diffTime;
  
    document.getElementById('calcResult').textContent = `Різниця: ${resultSeconds} сек`;
  });
  

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
  chrome.storage.sync.get(['skipStartSeconds', 'skipEndSeconds', 'enabled'], function(data) {
    startTimeInput.value = data.skipStartSeconds || 0;
    endTimeInput.value = data.skipEndSeconds || 0;
	  const enabled = data.enabled !== false; // За замовчуванням true, якщо enabled не встановлено
    disableButton.textContent = enabled ? 'Вимкнути розширення' : 'Увімкнути розширення';
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
    chrome.storage.sync.get('enabled', function(data) {
      const newStatus = data.enabled === false ? true : false;
      chrome.storage.sync.set({ enabled: newStatus }, function() {
        if (chrome.runtime.lastError) {
          console.error(chrome.runtime.lastError);
          return;
        }

        disableButton.textContent = newStatus ? 'Вимкнути розширення' : 'Увімкнути розширення';

        chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
          tabs.forEach(tab => {
            chrome.tabs.sendMessage(tab.id, { action: newStatus ? 'enableExtension' : 'disableExtension' });
          });
        });

        showMessage(newStatus ? 'Розширення працює!' : 'Розширення вимкнуте!');
      });
    });
  });
});
