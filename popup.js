document.addEventListener('DOMContentLoaded', function() {

  chrome.storage.sync.get({ blacklist: [] }, function(data) {
    const blacklist = data.blacklist;
    // Safeguard in case blacklist is not an array
    if (!Array.isArray(blacklist)) {
      console.error("Error: blacklist is not an array. Resetting to an empty array.");
      chrome.storage.sync.set({ blacklist: [] });
      return;
    }
    // Now you can safely use .join()
    const blacklistText = blacklist.join("\n");
    document.getElementById('blacklistText').value = blacklistText;
  });

  const expandButton = document.getElementById('calcButton');
  const calculator = document.getElementById('calculator');
  const body = document.body;

  expandButton.addEventListener('click', () => {
    if (calculator.style.display === 'none' || calculator.style.display === '') {
      calculator.style.display = 'block';
      body.style.width = '200px';
      body.style.height = 'auto';
      expandButton.textContent = '↖';
    } else {
      calculator.style.display = 'none';
      body.style.width = '200px';
      body.style.height = 'auto';
      expandButton.textContent = '↘';
    }
  });

  document.getElementById('setCalcButton').addEventListener('click', () => {
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

  const setStartButton = document.getElementById('setStart');
  const setEndButton = document.getElementById('setEnd');

  // Отримати поточний час відео і вставити його в поле "startTime"
  setStartButton.addEventListener('click', function() {
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
      chrome.tabs.sendMessage(tabs[0].id, { action: 'getCurrentTime' }, function(response) {
        if (response && response.currentTime !== undefined) {
          document.getElementById('startTime').value = Math.floor(response.currentTime);
        }
      });
    });
  });

  // Отримати поточний час відео і вставити його в поле "endTime"
  setEndButton.addEventListener('click', function() {
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
      chrome.tabs.sendMessage(tabs[0].id, { action: 'getCurrentTime' }, function(response) {
        if (response && response.currentTime !== undefined) {
          document.getElementById('endTime').value = Math.floor(response.currentTime);
        }
      });
    });
  });


  const showBlacklistButton = document.getElementById('showBlacklistButton');
  const blacklistSection = document.getElementById('blacklistSection');
  const blacklistText = document.getElementById('blacklistText');
  const saveBlacklistButton = document.getElementById('saveBlacklistButton');

    // Відображення/приховування blacklist textarea
    showBlacklistButton.addEventListener('click', function() {
      if (blacklistSection.style.display === 'none' || blacklistSection.style.display === '') {
        blacklistSection.style.display = 'block';
        showBlacklistButton.textContent = '↑';
      } else {
        blacklistSection.style.display = 'none';
        showBlacklistButton.textContent = '↓';
      }
      
      // Отримати поточний blacklist з chrome.storage
      chrome.storage.sync.get('blacklist', function(data) {
        const blacklist = data.blacklist || [];
        if (Array.isArray(blacklist)) {
          // Виводимо кожен домен на новий рядок у textarea
          blacklistText.value = blacklist.join('\n');
        }
      });
    });
  
    // Збереження blacklist у chrome.storage
    saveBlacklistButton.addEventListener('click', function() {
      const blacklistRaw = blacklistText.value;

      // Розбиваємо текст на масив доменів, використовуючи нові рядки
      const blacklist = blacklistRaw.split('\n').map(domain => domain.trim()).filter(domain => domain !== '');
  
      // Збереження оновленого чорного списку у chrome.storage
      chrome.storage.sync.set({ blacklist: blacklist }, function() {
        if (chrome.runtime.lastError) {
          console.error(chrome.runtime.lastError);
          return;
        }
        alert('Чорний список доменів збережено!');
      });
    });

});
