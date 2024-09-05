(function() {
  console.log('!!! Content script loaded');

  let SKIP_START_SECONDS = 0;
  let SKIP_END_SECONDS = 0;
  let endSkipped = false;
  let startSkipped = false;
  let enabled = true;

  // Function to apply new settings
  function applySettings(skipStart, skipEnd) {
    SKIP_START_SECONDS = skipStart;
    SKIP_END_SECONDS = skipEnd;
  }

  // Get current settings values from chrome.storage
  chrome.storage.sync.get(['skipStartSeconds', 'skipEndSeconds', 'enabled'], function(data) {
    SKIP_START_SECONDS = data.skipStartSeconds || 0;
    SKIP_END_SECONDS = data.skipEndSeconds || 0;
    enabled = data.enabled;
  });

  // Message handler from popup.js
  chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (request.action === 'applySettings') {
      applySettings(request.skipStartSeconds, request.skipEndSeconds);
    } else if (request.action === 'enableExtension') {
      enabled = true;
    } else if (request.action === 'disableExtension') {
      enabled = false;
    }
  });

  // Function to check and skip the start of the video
  function skipOpening(video) {

    if ((video.currentTime > 1) && (video.currentTime < SKIP_START_SECONDS)) {
      console.log("!!! Skipping to start");
      video.currentTime = SKIP_START_SECONDS;
    }
  }

  // Function to check and skip the end of the video
  function skipEnding(video) {

    if (((video.duration - video.currentTime) > 0.2) && ((video.duration - video.currentTime) < SKIP_END_SECONDS)) {
      console.log("!!! Skipping to end");
      video.currentTime = video.duration-0.1;
    }
  }

  function handleVideo(node) {
    console.log("!!! Skip start:", SKIP_START_SECONDS);
    console.log("!!! Skip end:", SKIP_END_SECONDS);
    console.log("!!! Enabled:", enabled);
    console.log("!!! New video element added:", node);
    startSkipped = false;
    endSkipped = false;
    let currentSrc = "";

    // Event handler for timeupdate event of video
    node.addEventListener("timeupdate", function() {
      if (enabled) {
        console.log("!!! Current time:", node.currentTime);
        console.log("!!! Video duration: ", node.duration);

        if (currentSrc !== node.currentSrc){
          console.log("!!! New video is found");
          startSkipped = false;
          endSkipped = false;
          currentSrc = node.currentSrc;
        }

        if (SKIP_START_SECONDS && !startSkipped) skipOpening(node);
        if (SKIP_END_SECONDS && !endSkipped) skipEnding(node);

      }
    });
  }

  // Function to handle DOM changes
  function handleDOMChanges(mutationsList, observer) {
    for (const mutation of mutationsList) {
      if (mutation.type === 'childList') {
        mutation.addedNodes.forEach(node => {
          if (node.tagName === 'VIDEO') {
            handleVideo(node);
          } 
        });
      }
    }
  }

  // Create a new instance of MutationObserver
  const observer = new MutationObserver(handleDOMChanges);

  // Start observing changes in the DOM
  observer.observe(document.body, { childList: true, subtree: true });


    // Функція для отримання поточного часу відео
    function getCurrentVideoTime() {
      const video = document.querySelector('video');  // Знайти елемент <video> на сторінці
      if (video) {
        return video.currentTime;
      }
      return null;  // Повернути null, якщо відео не знайдено
    }
  
    // Додаємо обробник для повідомлень від popup.js
    chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
      if (request.action === 'getCurrentTime') {
        const currentTime = getCurrentVideoTime();
        sendResponse({ currentTime: currentTime });
      }
    });
    
})();
