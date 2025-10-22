console.log('Background script running.');

chrome.action.onClicked.addListener((tab) => {
  if (tab.id) {
    chrome.tabs.sendMessage(tab.id, { action: "displayMessage" });
  }
});
