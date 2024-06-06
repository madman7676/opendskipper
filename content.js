(function() {
  console.log('!!! Content script loaded');

  let SKIP_START_SECONDS = 0;
  let SKIP_END_SECONDS = 0;
  let endingSkipped = false;
  let enabled = true;

  // Function to apply new settings
  function applySettings(skipStart, skipEnd) {
    SKIP_START_SECONDS = skipStart;
    SKIP_END_SECONDS = skipEnd;
  }

  // Function to check and skip the start of the video
  function skipOpening(video) {
    const currentTime = video.currentTime;
    console.log("!!! Current time:", currentTime);

    if (currentTime < SKIP_START_SECONDS) {
      console.log("!!! Skipping to start");
      video.currentTime = SKIP_START_SECONDS;
    }
  }

  // Function to check and skip the end of the video
  function skipEnding(video) {
    const currentTime = video.currentTime;

    if (!endingSkipped && video.duration - currentTime < SKIP_END_SECONDS) {
      console.log("!!! Skipping to end");
      video.currentTime = video.duration;
      endingSkipped = true;
    }
  }

  function handleVideo(node) {
    console.log("!!! Skip start:", SKIP_START_SECONDS);
    console.log("!!! Skip end:", SKIP_END_SECONDS);
    console.log("!!! New video element added:", node);
    console.log("!!! Video duration:", node.duration);
    endingSkipped = false;

    // Event handler for timeupdate event of video
    node.addEventListener("timeupdate", function() {
      if (enabled) {
        const currentTime = node.currentTime;
        console.log("!!! Current time:", currentTime);
        if (SKIP_START_SECONDS) skipOpening(node);
        if (SKIP_END_SECONDS) skipEnding(node);
      }
    });
  }

  function handleIframe(iframe) {
    iframe.addEventListener('load', () => {
      const iframeDocument = iframe.contentDocument || iframe.contentWindow.document;

      // Monitor changes inside the iframe
      const iframeObserver = new MutationObserver((mutationsList) => {
        for (const mutation of mutationsList) {
          if (mutation.type === 'childList') {
            mutation.addedNodes.forEach(node => {
              if (node.tagName === 'VIDEO') {
                console.log("!!! Video found in iframe:", node);
                handleVideo(node);
              }
            });
          }
        }
      });

      iframeObserver.observe(iframeDocument.body, { childList: true, subtree: true });
      
      // Initial search for videos in the iframe
      const videos = iframeDocument.getElementsByTagName('video');
      for (const video of videos) {
        console.log("!!! Initial video found in iframe:", video);
        handleVideo(video);
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
          } else if (node.tagName === 'IFRAME') {
            console.log("!!! Iframe is found", node);
            // Process videos inside iframe
            try {
              handleIframe(node);
            } catch (e) {
              console.error("!!! Could not access iframe content:", e);
            }
          }
        });
      }
    }
  }

  // Create a new instance of MutationObserver
  const observer = new MutationObserver(handleDOMChanges);

  // Start observing changes in the DOM
  observer.observe(document.body, { childList: true, subtree: true });

  // Get current settings values from chrome.storage
  chrome.storage.sync.get(['skipStartSeconds', 'skipEndSeconds'], function(data) {
    SKIP_START_SECONDS = data.skipStartSeconds || 0;
    SKIP_END_SECONDS = data.skipEndSeconds || 0;
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

})();
