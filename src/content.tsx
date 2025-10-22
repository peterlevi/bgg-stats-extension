chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "displayMessage") {
    const messageDiv = document.createElement('div');
    messageDiv.textContent = 'Hello from Popup!';
    messageDiv.style.cssText = 'position: fixed; top: 0; left: 0; background-color: lightblue; z-index: 99999; padding: 5px;';
    document.body.prepend(messageDiv);
  }
});
