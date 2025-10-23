// Storage keys
const ENABLED_DOMAINS_KEY = "bggEnabledDomains";
const CASE_INSENSITIVE_DOMAINS_KEY = "bggCaseInsensitiveDomains";
const EXTENSION_WORKING_KEY = "bggExtensionWorking";

let currentDomain: string = "";
let isWorking: boolean = false;
let isStatsShown: boolean = false;

// Button states enum
enum ButtonState {
  SHOW = "show",
  WORKING = "working",
  HIDE = "hide"
}

// Get current tab and domain
async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Check if stats are currently shown on the page
async function checkStatsShown(tabId: number): Promise<boolean> {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { action: "checkStatsShown" });
    return response?.shown || false;
  } catch (error) {
    return false;
  }
}

// Set button to one of three states
async function setButtonState(state: ButtonState) {
  const mainButton = document.getElementById("mainButton") as HTMLButtonElement;
  if (!mainButton) return;

  // Reset all classes first
  mainButton.classList.remove("hide-mode");

  // Get current tab for icon update
  const tab = await getCurrentTab();
  if (!tab.id) return;

  switch (state) {
    case ButtonState.SHOW:
      mainButton.textContent = "Show game stats";
      mainButton.disabled = false;
      // Set inactive icon
      await chrome.action.setIcon({
        tabId: tab.id,
        path: {
          "16": "icon16.png",
          "48": "icon48.png",
          "128": "icon128.png"
        }
      });
      break;
    case ButtonState.WORKING:
      mainButton.textContent = "Working...";
      mainButton.disabled = true;
      // Set active icon (working state)
      await chrome.action.setIcon({
        tabId: tab.id,
        path: {
          "16": "icon16_active.png",
          "48": "icon48_active.png",
          "128": "icon128_active.png"
        }
      });
      break;
    case ButtonState.HIDE:
      mainButton.textContent = "Hide game stats";
      mainButton.disabled = false;
      mainButton.classList.add("hide-mode");
      // Set active icon (badges shown)
      await chrome.action.setIcon({
        tabId: tab.id,
        path: {
          "16": "icon16_active.png",
          "48": "icon48_active.png",
          "128": "icon128_active.png"
        }
      });
      break;
  }
}

// Update UI based on current state
async function updateUI() {
  const autoRunCheckbox = document.getElementById("autoRunCheckbox") as HTMLInputElement;
  const caseInsensitiveCheckbox = document.getElementById("caseInsensitiveCheckbox") as HTMLInputElement;

  const tab = await getCurrentTab();
  if (!tab.url || !tab.id) return;

  currentDomain = new URL(tab.url).hostname;

  // Get storage values
  const result = await chrome.storage.local.get([
    ENABLED_DOMAINS_KEY,
    CASE_INSENSITIVE_DOMAINS_KEY,
    EXTENSION_WORKING_KEY
  ]);

  const enabledDomains: string[] = result[ENABLED_DOMAINS_KEY] || [];
  const caseInsensitiveDomains: string[] = result[CASE_INSENSITIVE_DOMAINS_KEY] || [];
  const workingState: { [tabId: string]: boolean } = result[EXTENSION_WORKING_KEY] || {};

  // Check if stats are actually shown on the page
  isStatsShown = await checkStatsShown(tab.id);
  isWorking = workingState[tab.id.toString()] || false;

  // Update button state based on current state (and icon in sync)
  if (isWorking) {
    await setButtonState(ButtonState.WORKING);
  } else if (isStatsShown) {
    await setButtonState(ButtonState.HIDE);
  } else {
    await setButtonState(ButtonState.SHOW);
  }

  // Update checkboxes based on current domain
  autoRunCheckbox.checked = enabledDomains.includes(currentDomain);
  caseInsensitiveCheckbox.checked = caseInsensitiveDomains.includes(currentDomain);
}

// Set working state
async function setWorkingState(working: boolean) {
  const tab = await getCurrentTab();
  if (!tab.id) return;

  const result = await chrome.storage.local.get([EXTENSION_WORKING_KEY]);
  const workingState: { [tabId: string]: boolean } = result[EXTENSION_WORKING_KEY] || {};

  if (working) {
    workingState[tab.id.toString()] = true;
  } else {
    delete workingState[tab.id.toString()];
  }

  await chrome.storage.local.set({ [EXTENSION_WORKING_KEY]: workingState });
  isWorking = working;
  await updateUI();
}

// Main button click handler
async function handleMainButtonClick() {
  const tab = await getCurrentTab();
  if (!tab.id) return;

  await setWorkingState(true);

  if (isStatsShown) {
    // Hide stats
    try {
      await chrome.tabs.sendMessage(tab.id, { action: "removeBadges" });
      isStatsShown = false;
    } catch (error) {
      console.error("Error hiding stats:", error);
    }
  } else {
    // Show stats
    try {
      await chrome.tabs.sendMessage(tab.id, { action: "displayMessage" });
      isStatsShown = true;
    } catch (error) {
      console.error("Error showing stats:", error);
    }
  }

  await setWorkingState(false);
}

// Auto-run checkbox handler
async function handleAutoRunChange(event: Event) {
  const checkbox = event.target as HTMLInputElement;
  const tab = await getCurrentTab();
  if (!tab.id) return;

  const result = await chrome.storage.local.get([ENABLED_DOMAINS_KEY]);
  const enabledDomains: string[] = result[ENABLED_DOMAINS_KEY] || [];

  if (checkbox.checked) {
    // Enable auto-run
    if (!enabledDomains.includes(currentDomain)) {
      enabledDomains.push(currentDomain);
      await chrome.storage.local.set({ [ENABLED_DOMAINS_KEY]: enabledDomains });
    }

    // Immediately trigger the extension if not already shown
    if (!isStatsShown) {
      await setWorkingState(true);
      try {
        await chrome.tabs.sendMessage(tab.id, { action: "displayMessage" });
        isStatsShown = true;
      } catch (error) {
        console.error("Error triggering extension:", error);
      }
      await setWorkingState(false);
    }
  } else {
    // Disable auto-run
    const updatedDomains = enabledDomains.filter(d => d !== currentDomain);
    await chrome.storage.local.set({ [ENABLED_DOMAINS_KEY]: updatedDomains });
  }
}

// Case-insensitive checkbox handler
async function handleCaseInsensitiveChange(event: Event) {
  const checkbox = event.target as HTMLInputElement;
  const tab = await getCurrentTab();
  if (!tab.id) return;

  // Get current case-insensitive domains
  const result = await chrome.storage.local.get([CASE_INSENSITIVE_DOMAINS_KEY]);
  const caseInsensitiveDomains: string[] = result[CASE_INSENSITIVE_DOMAINS_KEY] || [];

  if (checkbox.checked) {
    // Enable case-insensitive for this domain
    if (!caseInsensitiveDomains.includes(currentDomain)) {
      caseInsensitiveDomains.push(currentDomain);
      await chrome.storage.local.set({ [CASE_INSENSITIVE_DOMAINS_KEY]: caseInsensitiveDomains });
    }
  } else {
    // Disable case-insensitive for this domain
    const updatedDomains = caseInsensitiveDomains.filter(d => d !== currentDomain);
    await chrome.storage.local.set({ [CASE_INSENSITIVE_DOMAINS_KEY]: updatedDomains });
  }

  // Notify content script of the change
  try {
    await chrome.tabs.sendMessage(tab.id, {
      action: "updateCaseInsensitive",
      value: checkbox.checked
    });

    // If badges are currently shown, re-render them with the new case-matching mode
    if (isStatsShown) {
      await setWorkingState(true);

      // Remove existing badges
      await chrome.tabs.sendMessage(tab.id, { action: "removeBadges" });

      // Add badges again with new case-matching mode
      await chrome.tabs.sendMessage(tab.id, { action: "displayMessage" });

      await setWorkingState(false);
    }
  } catch (error) {
    // Content script might not be loaded
    console.log("Could not update case sensitivity in content script:", error);
  }
}

// Listen for messages from content script about working state
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "setWorkingState" && sender.tab?.id) {
    // Set working state for the specific tab that sent the message
    (async () => {
      if (!sender.tab?.id) {
        sendResponse({ success: false, error: "No tab ID" });
        return;
      }

      const tabId = sender.tab.id;
      const result = await chrome.storage.local.get([EXTENSION_WORKING_KEY]);
      const workingState: { [tabId: string]: boolean } = result[EXTENSION_WORKING_KEY] || {};

      if (request.working) {
        workingState[tabId.toString()] = true;
      } else {
        delete workingState[tabId.toString()];
      }

      await chrome.storage.local.set({ [EXTENSION_WORKING_KEY]: workingState });

      // Update UI if this is the active tab
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab.id === tabId) {
        isWorking = request.working;
        await updateUI();
      }

      sendResponse({ success: true });
    })();
    return true; // Keep message channel open for async response
  }
});

// Initialize
document.addEventListener("DOMContentLoaded", async () => {
  await updateUI();

  const mainButton = document.getElementById("mainButton");
  const autoRunCheckbox = document.getElementById("autoRunCheckbox");
  const caseInsensitiveCheckbox = document.getElementById("caseInsensitiveCheckbox");

  mainButton?.addEventListener("click", handleMainButtonClick);
  autoRunCheckbox?.addEventListener("change", handleAutoRunChange);
  caseInsensitiveCheckbox?.addEventListener("change", handleCaseInsensitiveChange);

  // Refresh UI periodically to catch working state changes
  setInterval(updateUI, 500);
});
