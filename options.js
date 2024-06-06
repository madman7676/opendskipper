document.addEventListener('DOMContentLoaded', function() {
  const startTimeInput = document.getElementById('startTime');
  const endTimeInput = document.getElementById('endTime');
  const saveButton = document.getElementById('saveButton');

  // Завантажити збережені налаштування
  chrome.storage.sync.get(['skipStartSeconds', 'skipEndSeconds'], function(data) {
    startTimeInput.value = data.skipStartSeconds || 0;
    endTimeInput.value = data.skipEndSeconds || 0;
  });

  // Зберегти налаштування при натисканні на кнопку
  saveButton.addEventListener('click', function() {
    const skipStartSeconds = parseInt(startTimeInput.value);
    const skipEndSeconds = parseInt(endTimeInput.value);

    chrome.storage.sync.set({ skipStartSeconds, skipEndSeconds }, function() {
      alert('Налаштування збережені!');
    });
  });
});
