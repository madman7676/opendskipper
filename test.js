var regStrip = /^[\r\t\f\v ]+|[\r\t\f\v ]+$/gm;
var regEndsWithFlags = /\/(?!.*(.).*\1)[gimsuy]*$/;

var tc = {
    settings: {
        skipStartSeconds: 0, // default 0
        skipEndSeconds: 0, // default 0
        enabled: true, // default enabled

        blacklist: `\
            www.instagram.com
            twitter.com
            vine.co
            imgur.com
            teams.microsoft.com
        `.replace(regStrip, ""),
    },

    // Holds a reference to all of the AUDIO/VIDEO DOM elements we've attached to
    mediaElements: []
};

chrome.storage.sync.get(tc.settings, function (storage) {

    tc.settings.skipStartSeconds = Number(storage.opSkip);
    tc.settings.skipEndSeconds = Number(storage.endSkip);
    tc.settings.enabled = Boolean(storage.enabled);
    //tc.settings.blacklist = String(storage.blacklist);

    initializeWhenReady(document);
});

function defineVideoController() {
    // Data structures
    // ---------------
    // videoController (JS object) instances:
    //   video = AUDIO/VIDEO DOM element
    //   parent = A/V DOM element's parentElement OR
    //            (A/V elements discovered from the Mutation Observer)
    //            A/V element's parentNode OR the node whose children changed.
    //   div = Controller's DOM element (which happens to be a DIV)
    //   speedIndicator = DOM element in the Controller of the speed indicator

    // added to AUDIO / VIDEO DOM elements
    //    vsc = reference to the videoController
    tc.videoController = function (target, parent) {
        if (target.vsc) {
          return target.vsc;
        }

        tc.mediaElements.push(target);

        this.video = target;
        this.parent = target.parentElement || parent;
        console.log("!!! ", target);

        target.addEventListener("timeupdate", function() {
          const currentTime = node.currentTime;
          console.log("!!! Current time:", currentTime);
          if (SKIP_START_SECONDS) skipOpening(node);
          if (SKIP_END_SECONDS) skipEnding(node);
        });
    };

    console.log("!!!", );

}
  
function escapeStringRegExp(str) {
    matchOperatorsRe = /[|\\{}()[\]^$+*?.]/g;
    return str.replace(matchOperatorsRe, "\\$&");
}


function isBlacklisted() {
    blacklisted = false;
    tc.settings.blacklist.split("\n").forEach((match) => {
      match = match.replace(regStrip, "");
      if (match.length == 0) {
        return;
      }
  
      if (match.startsWith("/")) {
        try {
          var parts = match.split("/");
  
          if (regEndsWithFlags.test(match)) {
            var flags = parts.pop();
            var regex = parts.slice(1).join("/");
          } else {
            var flags = "";
            var regex = match;
          }
  
          var regexp = new RegExp(regex, flags);
        } catch (err) {
          return;
        }
      } else {
        var regexp = new RegExp(escapeStringRegExp(match));
      }
  
      if (regexp.test(location.href)) {
        blacklisted = true;
        return;
      }
    });
    return blacklisted;
}

function initializeWhenReady(document) {
  console.log("!!! Initializing WhenReady");
  if (isBlacklisted()) {
    return;
  }
  window.onload = () => {
    initializeNow(window.document);
  };
  if (document) {
    if (document.readyState === "complete") {
      initializeNow(document);
    } else {
      document.onreadystatechange = () => {
        if (document.readyState === "complete") {
          initializeNow(document);
        }
      };
    }
  }
}

function inIframe() {
    try {
      return window.self !== window.top;
    } catch (e) {
      return true;
    }
}


function initializeNow(document) {
  console.log("!!! Initializing Now");
    if (!tc.settings.enabled) return;
    // enforce init-once due to redundant callers
    if (!document.body) {
      return;
    }
  
    if (document === window.document) {
      defineVideoController();
    } else {
      console.log("!!! ELSE");
    }

    var docs = Array(document);
    try {
      if (inIframe()) docs.push(window.top.document);
    } catch (e) {}
  /*
    function checkForVideoAndShadowRoot(node, parent, added) {
      // Only proceed with supposed removal if node is missing from DOM
      if (!added && document.body?.contains(node)) {
        // This was written prior to the addition of shadowRoot processing.
        // TODO: Determine if shadowRoot deleted nodes need this sort of 
        // check as well.
        return;
      }
      if (node.nodeName === "VIDEO") {
        if (added) {
          node.vsc = new tc.videoController(node, parent);
        } else {
          if (node.vsc) {
            node.vsc.remove();
          }
        }
      } else {
        var children = [];
        if (node.shadowRoot) {
          documentAndShadowRootObserver.observe(node.shadowRoot, documentAndShadowRootObserverOptions);
          children = Array.from(node.shadowRoot.children);
        }
        if (node.children) {
          children = [...children, ...node.children];
        };
        for (const child of children) {
          checkForVideoAndShadowRoot(child, child.parentNode || parent, added)
        };
      }
    }
  
    var documentAndShadowRootObserver = new MutationObserver(function (mutations) {
      // Process the DOM nodes lazily
      requestIdleCallback(
        (_) => {
          mutations.forEach(function (mutation) {
            switch (mutation.type) {
              case "childList":
                mutation.addedNodes.forEach(function (node) {
                  if (typeof node === "function") return;
                  if (node === document.documentElement) {
                    // This happens on sites that use document.write, e.g. watch.sling.com
                    // When the document gets replaced, we lose all event handlers, so we need to reinitialize
                    initializeWhenReady(document);
                    return;
                  }
                  checkForVideoAndShadowRoot(node, node.parentNode || mutation.target, true);
                });
                mutation.removedNodes.forEach(function (node) {
                  if (typeof node === "function") return;
                  checkForVideoAndShadowRoot(node, node.parentNode || mutation.target, false);
                });
                break;
              case "attributes":
                if (
                  (mutation.target.attributes["aria-hidden"] &&
                  mutation.target.attributes["aria-hidden"].value == "false")
                  || mutation.target.nodeName === 'APPLE-TV-PLUS-PLAYER'
                ) {
                  var flattenedNodes = getShadow(document.body);
                  var nodes = flattenedNodes.filter(
                    (x) => x.tagName == "VIDEO"
                  );
                  for (let node of nodes) {
                    // only add vsc the first time for the apple-tv case (the attribute change is triggered every time you click the vsc)
                    if (node.vsc && mutation.target.nodeName === 'APPLE-TV-PLUS-PLAYER')
                      continue;
                    if (node.vsc)
                      node.vsc.remove();
                    checkForVideoAndShadowRoot(node, node.parentNode || mutation.target, true);
                  }
                }
                break;
            }
          });
        },
        { timeout: 1000 }
      );
    });
    documentAndShadowRootObserverOptions = {
      attributeFilter: ["aria-hidden", "data-focus-method"],
      childList: true,
      subtree: true
    }
    documentAndShadowRootObserver.observe(document, documentAndShadowRootObserverOptions);
  */
    const mediaTagSelector = "video";
    mediaTags = Array.from(document.querySelectorAll(mediaTagSelector));
  
    document.querySelectorAll("*").forEach((element) => {
      if (element.shadowRoot) {
        //documentAndShadowRootObserver.observe(element.shadowRoot, documentAndShadowRootObserverOptions);
        mediaTags.push(...element.shadowRoot.querySelectorAll(mediaTagSelector));
      };
    });
  
    mediaTags.forEach(function (video) {
      video.vsc = new tc.videoController(video);
    });
  
    var frameTags = document.getElementsByTagName("iframe");
    Array.prototype.forEach.call(frameTags, function (frame) {
      // Ignore frames we don't have permission to access (different origin).
      try {
        var childDocument = frame.contentDocument;
      } catch (e) {
        return;
      }
      initializeWhenReady(childDocument);
    });
}

function skipOpening(video) {
  console.log("!!! Current time:", video.currentTime);
  if (video.currentTime < SKIP_START_SECONDS) {
    console.log("!!! Skipping to start");
    video.currentTime = SKIP_START_SECONDS;
  }
}

function skipEnding(video) {
  if (!endingSkipped && video.duration - video.currentTime < SKIP_END_SECONDS) {
    console.log("!!! Skipping to end");
    video.currentTime = video.duration;
    endingSkipped = true;
  }
}