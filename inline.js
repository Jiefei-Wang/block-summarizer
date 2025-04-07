(function () {
    const extensionName = "history-summarizer";
    let settings = {};
    let currentBlockIndex = 0;
    let totalBlocks = 0;
    let currentBlockHash = null; // To track which summary is being edited

    // --- DOM Elements ---
    let elements = {};

    function getElements() {
        elements.container = document.querySelector('.histSummSetContainer');
        elements.enabled = document.getElementById('histSumm_enabled');
        elements.apiUrl = document.getElementById('histSumm_apiUrl');
        elements.blockSize = document.getElementById('histSumm_blockSize');
        elements.summarySize = document.getElementById('histSumm_summarySize');
        elements.historySize = document.getElementById('histSumm_historySize');
        elements.promptTemplate = document.getElementById('histSumm_promptTemplate');
        elements.clearCacheBtn = document.getElementById('histSumm_clearCache');
        elements.cacheStatus = document.getElementById('histSumm_cache_status');

        // Preview elements
        elements.prevBlockBtn = document.getElementById('histSumm_prevBlock');
        elements.nextBlockBtn = document.getElementById('histSumm_nextBlock');
        elements.blockIndicator = document.getElementById('histSumm_blockIndicator');
        elements.refreshPreviewBtn = document.getElementById('histSumm_refreshPreview');
        elements.blockContentPreview = document.getElementById('histSumm_blockContentPreview');
        elements.summaryPreview = document.getElementById('histSumm_summaryPreview');
        elements.saveSummaryEditBtn = document.getElementById('histSumm_saveSummaryEdit');
        elements.editStatus = document.getElementById('histSumm_edit_status');
        elements.previewError = document.getElementById('histSumm_preview_error');
    }


    // --- Communication with Backend (script.js) ---

    function emitSettingChange() {
        // Gather settings from inputs
        const newSettings = {};
        document.querySelectorAll('.histSumm_setting').forEach(input => {
            const name = input.name;
            if (input.type === 'checkbox') {
                newSettings[name] = input.checked;
            } else if (input.type === 'number') {
                newSettings[name] = Number(input.value);
            } else {
                 newSettings[name] = input.value;
            }
        });
        settings = newSettings; // Update local copy
        // Use ST's method to send settings change signal
        // This might vary slightly based on ST version. Check docs for `emit`, `sendSystemMessage`, etc.
        // Assuming 'extensions.emit' exists and works like Socket.IO emit:
        if (typeof extensions !== 'undefined' && extensions.emit) {
             extensions.emit('settings-change', extensionName, newSettings);
             console.log(`[${extensionName}] Sent settings update`);
        } else {
            console.error(`[${extensionName}] Cannot find extensions.emit function.`);
        }
    }

    function fetchSettings() {
        if (typeof extensions !== 'undefined' && extensions.emit) {
             console.log(`[${extensionName}] Requesting settings...`);
             extensions.emit(`${extensionName}:get_settings`, (receivedSettings) => {
                 console.log(`[${extensionName}] Received settings:`, receivedSettings);
                 settings = receivedSettings || {};
                 updateUIFromSettings();
             });
        } else {
             console.error(`[${extensionName}] Cannot find extensions.emit function.`);
             // Fallback or error display
             updateUIFromSettings(); // Use defaults
        }
    }

    function requestPreview(index) {
         if (typeof extensions !== 'undefined' && extensions.emit) {
             console.log(`[${extensionName}] Requesting preview for block index: ${index}`);
             elements.blockIndicator.textContent = 'Loading...';
             elements.previewError.textContent = ''; // Clear previous errors
             extensions.emit(`${extensionName}:get_preview`, { blockIndex: index }, (response) => {
                  console.log(`[${extensionName}] Received preview response:`, response);
                  if (response && !response.error) {
                      currentBlockIndex = response.blockIndex;
                      totalBlocks = response.totalBlocks;
                      currentBlockHash = response.blockHash; // Store hash for saving edits
                      updatePreviewUI(response.blockContent, response.summaryContent);
                  } else {
                      elements.blockIndicator.textContent = `Block ${currentBlockIndex + 1} / ${totalBlocks || '?'}`;
                      elements.previewError.textContent = `Error: ${response?.error || 'Failed to get preview.'}`;
                      // Clear previews on error maybe?
                      // elements.blockContentPreview.value = '';
                      // elements.summaryPreview.value = '';
                  }
             });
         } else {
              elements.previewError.textContent = 'Error: Cannot communicate with backend.';
         }
    }

     function saveEditedSummary() {
         if (!currentBlockHash) {
             elements.editStatus.textContent = 'No block loaded';
             return;
         }
         if (typeof extensions !== 'undefined' && extensions.emit) {
             const newSummary = elements.summaryPreview.value;
             console.log(`[${extensionName}] Saving edited summary for hash: ${currentBlockHash}`);
             elements.editStatus.textContent = 'Saving...';
             extensions.emit(`${extensionName}:update_summary`, { blockHash: currentBlockHash, newSummary: newSummary }, (response) => {
                  if (response && response.success) {
                      elements.editStatus.textContent = 'Saved!';
                      setTimeout(() => { elements.editStatus.textContent = ''; }, 2000);
                  } else {
                      elements.editStatus.textContent = `Save failed: ${response?.error || 'Unknown error'}`;
                  }
             });
         } else {
             elements.editStatus.textContent = 'Error: Cannot communicate with backend.';
         }
     }


    function requestClearCache() {
         if (typeof extensions !== 'undefined' && extensions.emit) {
             if (confirm("Are you sure you want to clear the entire summary cache? This cannot be undone.")) {
                 console.log(`[${extensionName}] Requesting cache clear...`);
                 elements.cacheStatus.textContent = 'Clearing...';
                 extensions.emit(`${extensionName}:clear_cache`, (response) => {
                      if (response && response.success) {
                          elements.cacheStatus.textContent = 'Cache Cleared!';
                          requestPreview(currentBlockIndex); // Refresh preview as summary might be gone
                      } else {
                          elements.cacheStatus.textContent = `Error: ${response?.error || 'Failed to clear cache.'}`;
                      }
                      setTimeout(() => { elements.cacheStatus.textContent = ''; }, 3000);
                 });
             }
         } else {
              elements.cacheStatus.textContent = 'Error: Cannot communicate with backend.';
         }
    }


    // --- UI Updates ---

    function updateUIFromSettings() {
        if (!elements.container) return; // Make sure elements are available

        elements.enabled.checked = settings.enabled ?? true;
        elements.apiUrl.value = settings.apiUrl ?? '';
        elements.blockSize.value = settings.blockSize ?? 1000;
        elements.summarySize.value = settings.summarySize ?? 150;
        elements.historySize.value = settings.historySize ?? 2048;
        elements.promptTemplate.value = settings.promptTemplate ?? `This is a summary of the preceding conversation:\n{{summary_content}}\n\nContinue the conversation based on this summary and the most recent messages below:`;
    }

    function updatePreviewUI(blockContent, summaryContent) {
         elements.blockIndicator.textContent = `Block ${currentBlockIndex + 1} / ${totalBlocks}`;
         elements.blockContentPreview.value = blockContent ?? '[No Content]';
         elements.summaryPreview.value = summaryContent ?? '[No Summary]';
         elements.previewError.textContent = ''; // Clear error on success
         elements.editStatus.textContent = ''; // Clear save status

         // Enable/disable nav buttons
         elements.prevBlockBtn.disabled = (currentBlockIndex <= 0);
         elements.nextBlockBtn.disabled = (currentBlockIndex >= totalBlocks - 1);
         elements.saveSummaryEditBtn.disabled = !currentBlockHash; // Only enable if a block is loaded
    }

    // --- Event Listeners ---

    function addEventListeners() {
        if (!elements.container) return;

        // Settings changes
        elements.container.querySelectorAll('.histSumm_setting').forEach(input => {
            input.addEventListener('change', emitSettingChange);
            // For text inputs, maybe update on 'input' or 'blur' instead of just 'change'
            if (input.type === 'text' || input.tagName === 'TEXTAREA') {
                input.addEventListener('input', emitSettingChange);
            }
        });

        // Clear Cache button
        elements.clearCacheBtn.addEventListener('click', requestClearCache);

        // Preview navigation/refresh
        elements.prevBlockBtn.addEventListener('click', () => {
             if (currentBlockIndex > 0) {
                 requestPreview(currentBlockIndex - 1);
             }
        });
        elements.nextBlockBtn.addEventListener('click', () => {
             if (currentBlockIndex < totalBlocks - 1) {
                  requestPreview(currentBlockIndex + 1);
             }
        });
        elements.refreshPreviewBtn.addEventListener('click', () => {
             requestPreview(currentBlockIndex); // Request current block again
        });

        // Save edited summary
        elements.saveSummaryEditBtn.addEventListener('click', saveEditedSummary);

        // Initial preview load when the panel is opened (or refreshed)
        requestPreview(currentBlockIndex);
    }


    // --- Initialization ---

    // Make sure the DOM is fully loaded before trying to find elements
    if (document.readyState === 'complete') {
        init();
    } else {
        document.addEventListener('DOMContentLoaded', init);
    }

    function init() {
         console.log(`[${extensionName}] Initializing frontend...`);
         getElements();
         if (!elements.container) {
             console.error(`[${extensionName}] Could not find main container element.`);
             return;
         }
         fetchSettings(); // Load initial settings from backend
         addEventListeners(); // Add listeners after elements are found
         // Add drawer toggle functionality (copy from other extensions if needed)
         elements.container.querySelectorAll('.inline-drawer-toggle').forEach(toggle => {
             toggle.addEventListener('click', () => {
                 const content = toggle.nextElementSibling;
                 const icon = toggle.querySelector('.inline-drawer-icon');
                 content.style.display = (content.style.display === 'none' || content.style.display === '') ? 'block' : 'none';
                 icon.classList.toggle('down');
                 icon.classList.toggle('up');
                 // When opening the preview drawer, refresh the preview
                 if (content === elements.previewError.closest('.inline-drawer-content') && content.style.display === 'block') {
                     requestPreview(currentBlockIndex);
                 }
             });
             // Optionally start closed
              //toggle.nextElementSibling.style.display = 'none';
              //toggle.querySelector('.inline-drawer-icon').classList.replace('down', 'up'); // Assuming default is down/open
         });
         console.log(`[${extensionName}] Frontend initialized.`);
    }

})();
