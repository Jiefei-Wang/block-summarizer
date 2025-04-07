// Imports from SillyTavern global scope
import { extension_settings, getContext, setExtensionPrompt, getApiUrl, loadExtensionSettings, saveExtensionSettings, doExtrasFetch, renderExtensionTemplateAsync } from '../../extensions.js';
import { debounce, getStringHash } from '../../utils.js'; // Assuming utils are available
import { eventSource, event_types, saveSettingsDebounced, substituteParamsExtended, extension_prompt_types, extension_prompt_roles, is_send_press, generateQuietPrompt } from '../../../script.js';

// --- IndexedDB Setup ---
const DB_NAME = 'HistorySummarizerDB';
const STORE_NAME = 'blockSummaryCache';
const DB_VERSION = 1;
let dbPromise = null;

function openDB() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = (event) => {
            console.error(`[${MODULE_NAME}] IndexedDB error:`, event.target.error);
            reject(`IndexedDB error: ${event.target.error}`);
        };

        request.onsuccess = (event) => {
            log('IndexedDB opened successfully.');
            resolve(event.target.result);
        };

        request.onupgradeneeded = (event) => {
            log('IndexedDB upgrade needed.');
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'hash' });
                log(`Object store "${STORE_NAME}" created.`);
            }
        };
    });
    return dbPromise;
}

async function getItemFromDB(hash) {
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.get(hash);

            request.onerror = (event) => {
                console.error(`[${MODULE_NAME}] DB get error:`, event.target.error);
                reject(event.target.error);
            };

            request.onsuccess = (event) => {
                resolve(event.target.result ? event.target.result.summary : null);
            };
        });
    } catch (error) {
        console.error(`[${MODULE_NAME}] Failed to get item from DB:`, error);
        return null; // Return null on error opening DB etc.
    }
}

async function setItemInDB(hash, summary) {
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.put({ hash: hash, summary: summary });

            request.onerror = (event) => {
                console.error(`[${MODULE_NAME}] DB put error:`, event.target.error);
                reject(event.target.error);
            };

            request.onsuccess = () => {
                resolve(true);
            };
        });
     } catch (error) {
        console.error(`[${MODULE_NAME}] Failed to set item in DB:`, error);
        return false; // Indicate failure
    }
}

async function clearDBStore() {
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.clear();

            request.onerror = (event) => {
                console.error(`[${MODULE_NAME}] DB clear error:`, event.target.error);
                reject(event.target.error);
            };

            request.onsuccess = () => {
                log('IndexedDB store cleared.');
                resolve(true);
            };
        });
    } catch (error) {
        console.error(`[${MODULE_NAME}] Failed to clear DB store:`, error);
        return false; // Indicate failure
    }
}
// --- End IndexedDB Setup ---


// --- Web Crypto Hashing ---
async function digestMessage(message) {
  const msgUint8 = new TextEncoder().encode(message); // encode as (utf-8) Uint8Array
  const hashBuffer = await window.crypto.subtle.digest('SHA-256', msgUint8); // hash the message
  const hashArray = Array.from(new Uint8Array(hashBuffer)); // convert buffer to byte array
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join(''); // convert bytes to hex string
  return hashHex;
}

// Extension specific variables
const MODULE_NAME = 'history-summarizer'; // Unique name for the extension
let blockCache = new Map(); // In-memory cache (still useful for session speed)
let inApiCall = false;
let lastMessageCount = 0;
let currentPreviewState = {
    blockIndex: 0,
    totalBlocks: 0,
    currentBlockHash: null,
    allBlocks: [],
};
let lastSummaryContent = '';

// Default settings (same as before)
const defaultSettings = {
    enabled: true,
    apiUrl: '',
    blockSize: 1000,
    summarySize: 150,
    triggerThreshold: 10,
    promptTemplate: `[This is a summary of earlier conversation blocks:\n{{summary_content}}\nEnd of Summary]`,
    position: extension_prompt_types.AFTER_SYSTEM,
    depth: 5,
    role: extension_prompt_roles.SYSTEM,
    scan: false,
};

// --- Helper Functions (Logging) ---
function log(message) {
    console.log(`[${MODULE_NAME}] ${message}`);
}

// --- Cache Handling (Uses new DB functions) ---
async function getSummaryFromCache(hash) {
    // Check in-memory first
    if (blockCache.has(hash)) {
        return blockCache.get(hash);
    }
    // Check IndexedDB
    const summaryFromDB = await getItemFromDB(hash);
    if (summaryFromDB !== null) {
        blockCache.set(hash, summaryFromDB); // Populate in-memory cache
        return summaryFromDB;
    }
    return null; // Not found anywhere
}

async function saveSummaryToCache(hash, summary) {
    blockCache.set(hash, summary); // Update in-memory cache
    await setItemInDB(hash, summary); // Save to IndexedDB
}

async function clearSummaryCache() {
    log('Clearing cache...');
    blockCache.clear(); // Clear in-memory cache
    const success = await clearDBStore(); // Clear IndexedDB store
    return success;
}

// --- Block Hashing (Uses Web Crypto) ---
async function getBlockHash(blockDetails) {
    const contentString = blockDetails.map(msg => `${msg.is_user ? 'U' : 'C'}:${msg.mes}`).join('|');
    return await digestMessage(contentString); // Use Web Crypto SHA-256
}


// --- API Call (Unchanged, uses fetch) ---
async function callSummarizationApi(blockDetails) {
    const settings = extension_settings[MODULE_NAME];
    if (!settings.apiUrl) {
        log('Error: Summarization API URL is not set.');
        return null;
    }
    const blockContent = blockDetails.map(msg => `${msg.name}: ${msg.mes}`).join('\n');
    const payload = {
        block_content: blockContent,
        block_details: blockDetails,
        target_summary_size: settings.summarySize
    };
    try {
        log(`Sending block to API: ${JSON.stringify(payload).substring(0, 100)}...`);
        const response = await fetch(settings.apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!response.ok) {
            const errorText = await response.text();
            log(`Error calling summarization API: ${response.status} ${response.statusText} - ${errorText}`);
            return `[Error: API response ${response.status}]`;
        }
        const result = await response.json();
        log(`Received summary from API: ${result.summary ? result.summary.substring(0, 100) : '[No summary]' }...`);
        return result.summary || null;
    } catch (error) {
        console.error(`[${MODULE_NAME}] Network/fetch error calling API:`, error);
        return `[Error: Network/Fetch failed]`;
    }
}

// --- Core Summarization Logic (Mostly unchanged, but uses async hash) ---
async function generateBlocks(chatHistory) {
    // ... (generateBlocks function remains the same internally, but caller needs await)
    const settings = extension_settings[MODULE_NAME];
    const blocks = [];
    let currentBlock = [];
    let currentBlockLength = 0;

    log(`Blocking ${chatHistory.length} messages. Block size: ${settings.blockSize} chars.`);

    for (const message of chatHistory) {
        if (message.is_system) continue;
        const messageLength = message.mes ? message.mes.length : 0;
        if (messageLength === 0) continue;

        const blockMsg = { name: message.name, is_user: message.is_user, mes: message.mes };

        if (currentBlock.length > 0 && (currentBlockLength + messageLength > settings.blockSize)) {
             const blockHash = await getBlockHash(currentBlock); // Await hash calculation
             blocks.push({ hash: blockHash, details: [...currentBlock] });
             currentBlock = [blockMsg];
             currentBlockLength = messageLength;
        } else {
             currentBlock.push(blockMsg);
             currentBlockLength += messageLength;
        }
    }

    if (currentBlock.length > 0) {
        const blockHash = await getBlockHash(currentBlock); // Await hash calculation
        blocks.push({ hash: blockHash, details: currentBlock });
    }

    log(`Split history into ${blocks.length} blocks.`);
    return blocks;
}

async function summarizeAllBlocks(blocks) {
    // ... (summarizeAllBlocks function remains the same, but calls async cache/api)
    const blockSummaries = [];
    let hasError = false;
    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        let summary = await getSummaryFromCache(block.hash); // Await cache lookup
        if (summary === null) {
            log(`Cache miss for block ${i + 1}/${blocks.length}. Calling API...`);
            summary = await callSummarizationApi(block.details); // Await API call
            if (summary !== null && !summary.startsWith('[Error:')) {
                await saveSummaryToCache(block.hash, summary); // Await cache save
            } else {
                log(`API call failed or returned null for block ${i+1}`);
                summary = summary || `[Summary generation failed for block ${i + 1}]`;
                hasError = true;
            }
        } else {
             log(`Cache hit for block ${i + 1}/${blocks.length}.`);
        }
        blockSummaries.push(summary);
    }
    return { blockSummaries, hasError };
}

// --- SillyTavern Integration (Unchanged) ---
function updatePromptWithSummary(summaryText) {
    // ... (remains the same)
    const settings = extension_settings[MODULE_NAME];
    let finalPrompt = '';
    if (summaryText && summaryText.trim() !== '') {
        finalPrompt = settings.promptTemplate.replace('{{summary_content}}', summaryText.trim());
    }
    setExtensionPrompt(MODULE_NAME, finalPrompt, settings.position, settings.depth, settings.scan, settings.role);
    log(`Set extension prompt. Position: ${settings.position}, Depth: ${settings.depth}, Role: ${settings.role}, Scan: ${settings.scan}. Content: ${finalPrompt.substring(0,100)}...`);
}

async function checkAndSummarize() {
    // ... (remains mostly the same, but calls async generateBlocks/summarizeAllBlocks)
    const settings = extension_settings[MODULE_NAME];
    if (!settings.enabled || inApiCall) { return; }
    const context = getContext();
    const chat = context.chat;
    const currentMessageCount = chat.filter(m => !m.is_system && m.mes).length;
    const messagesSinceLastCheck = currentMessageCount - lastMessageCount;

    if (messagesSinceLastCheck >= settings.triggerThreshold) {
        log(`Trigger threshold reached (${messagesSinceLastCheck} >= ${settings.triggerThreshold}). Starting summarization.`);
        inApiCall = true;
        $('#histSumm_forceUpdate').prop('disabled', true).text('Summarizing...');
        try {
            const historyToSummarize = chat.slice(0, -1);
            const blocks = await generateBlocks(historyToSummarize); // Await
            if (blocks.length > 0) {
                const { blockSummaries, hasError } = await summarizeAllBlocks(blocks); // Await
                const combinedSummary = blockSummaries.join('\n\n').trim();
                if (combinedSummary) {
                    lastSummaryContent = combinedSummary;
                    updatePromptWithSummary(combinedSummary);
                    if (hasError) { toastr.warning('Some blocks failed to summarize. Check console.', 'Summarization Issue'); }
                    else { toastr.success(`History summarized into ${blocks.length} blocks.`, 'Summary Updated'); }
                } else {
                    log('No summary content generated.');
                    updatePromptWithSummary('');
                }
                lastMessageCount = currentMessageCount;
            } else {
                log('No blocks generated from history.');
                updatePromptWithSummary('');
                lastMessageCount = currentMessageCount;
            }
        } catch (error) {
            console.error(`[${MODULE_NAME}] Error during summarization process:`, error);
            toastr.error('Summarization failed. Check console.', 'Error');
            updatePromptWithSummary('');
        } finally {
            inApiCall = false;
            $('#histSumm_forceUpdate').prop('disabled', false).text('Summarize Now');
        }
    } else {
         updatePromptWithSummary(lastSummaryContent);
    }
}

async function forceSummarize() {
    // ... (remains the same, calls async checkAndSummarize)
    log('Forcing summarization...');
    lastMessageCount = 0;
    await checkAndSummarize();
}

// --- Event Handlers (Unchanged) ---
function onChatChanged() {
    // ... (remains the same)
    log('Chat changed, reapplying last known summary to prompt.');
    updatePromptWithSummary(lastSummaryContent);
}

function onMessageRendered() {
    // ... (remains the same)
    log('Message rendered, checking summarization trigger.');
    debounce(checkAndSummarize, 200)();
}

// --- Initialization and UI Logic (Needs to call async preview/cache functions) ---
jQuery(async function () {
    // Load settings HTML
    const settingsHtml = await renderExtensionTemplateAsync(MODULE_NAME, 'settings');
    $('#extensions_settings').append(settingsHtml);
    log('Settings HTML loaded.');

    // Initialize settings object
    extension_settings[MODULE_NAME] = extension_settings[MODULE_NAME] || {};
    for (const key of Object.keys(defaultSettings)) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    // Ensure IndexedDB is opened (doesn't need explicit ensureCacheDir anymore)
    await openDB();

    // Function to update UI elements based on settings (Unchanged)
    function updateUIFromSettings() {
        // ... (remains the same)
        const settings = extension_settings[MODULE_NAME];
        $('#histSumm_enabled').prop('checked', settings.enabled);
        $('#histSumm_apiUrl').val(settings.apiUrl);
        $('#histSumm_blockSize').val(settings.blockSize);
        $('#histSumm_blockSize_value').text(settings.blockSize);
        $('#histSumm_summarySize').val(settings.summarySize);
        $('#histSumm_summarySize_value').text(settings.summarySize);
        $('#histSumm_triggerThreshold').val(settings.triggerThreshold);
        $('#histSumm_triggerThreshold_value').text(settings.triggerThreshold);
        $('#histSumm_promptTemplate').val(settings.promptTemplate);
        $(`input[name="position"][value="${settings.position}"]`).prop('checked', true);
        $('#histSumm_depth').val(settings.depth);
        $('#histSumm_role').val(settings.role);
        $('#histSumm_scan').prop('checked', settings.scan);
        updatePromptWithSummary(lastSummaryContent);
    }

    // Function to handle settings change and save (Unchanged)
    function handleSettingChange() {
        // ... (remains the same)
        const settings = extension_settings[MODULE_NAME];
        settings.enabled = $('#histSumm_enabled').prop('checked');
        settings.apiUrl = $('#histSumm_apiUrl').val();
        settings.blockSize = Number($('#histSumm_blockSize').val());
        settings.summarySize = Number($('#histSumm_summarySize').val());
        settings.triggerThreshold = Number($('#histSumm_triggerThreshold').val());
        settings.promptTemplate = $('#histSumm_promptTemplate').val();
        settings.position = Number($('input[name="position"]:checked').val());
        settings.depth = Number($('#histSumm_depth').val());
        settings.role = Number($('#histSumm_role').val());
        settings.scan = $('#histSumm_scan').prop('checked');
        $('#histSumm_blockSize_value').text(settings.blockSize);
        $('#histSumm_summarySize_value').text(settings.summarySize);
        $('#histSumm_triggerThreshold_value').text(settings.triggerThreshold);
        saveSettingsDebounced();
        updatePromptWithSummary(lastSummaryContent);
        log('Settings updated and saved.');
    }

    // --- Preview Panel Logic (Needs async calls) ---
    async function loadPreview(blockIndex) {
        // ... (needs to call async generateBlocks and cache functions)
        const context = getContext();
        const chat = context.chat.slice();
        if (chat.length === 0) {
             $('#histSumm_preview_error').text('No chat history available for preview.');
             return;
        }

        if (currentPreviewState.allBlocks.length === 0) {
             currentPreviewState.allBlocks = await generateBlocks(chat); // Await
             currentPreviewState.totalBlocks = currentPreviewState.allBlocks.length;
        }

        const blocks = currentPreviewState.allBlocks;
        const totalBlocks = currentPreviewState.totalBlocks;

        if (totalBlocks === 0) { /* ... error handling ... */ return; }

        currentPreviewState.blockIndex = Math.max(0, Math.min(blockIndex, totalBlocks - 1));
        const currentIdx = currentPreviewState.blockIndex;
        const targetBlock = blocks[currentIdx];
        currentPreviewState.currentBlockHash = targetBlock.hash; // Hash is already calculated in generateBlocks

        // Update UI
        $('#histSumm_blockIndicator').text(`Block ${currentIdx + 1} / ${totalBlocks}`);
        $('#histSumm_prevBlock').prop('disabled', currentIdx === 0);
        $('#histSumm_nextBlock').prop('disabled', currentIdx === totalBlocks - 1);
        $('#histSumm_preview_error').text('');

        const blockContent = targetBlock.details.map(msg => `${msg.name}: ${msg.mes}`).join('\n');
        $('#histSumm_blockContentPreview').val(blockContent);

        let summary = await getSummaryFromCache(targetBlock.hash); // Await cache lookup
        if (summary === null) {
            summary = "[Summary not cached. Edit and save to create, or run summarization.]";
        }
        $('#histSumm_summaryPreview').val(summary);
        $('#histSumm_edit_status').text('');
        $('#histSumm_saveSummaryEdit').prop('disabled', false);
    }

    // Needs to be async now
    async function refreshPreview() {
        currentPreviewState.allBlocks = [];
        await loadPreview(currentPreviewState.blockIndex); // Await
    }

    // Needs to be async now
    async function saveEditedSummary() {
         // ... (needs to call async saveSummaryToCache)
         const hash = currentPreviewState.currentBlockHash;
         const newSummary = $('#histSumm_summaryPreview').val();
         if (!hash) { /* ... error handling ... */ return; }
         $('#histSumm_edit_status').text('Saving...').css('color', '');
         await saveSummaryToCache(hash, newSummary); // Await cache save
         $('#histSumm_edit_status').text('Saved!').css('color', 'lime');
         setTimeout(() => $('#histSumm_edit_status').text(''), 2000);
    }

    // --- Attach Event Listeners ---
    log('Attaching UI listeners...');
    $('#histSumm_settings').on('change input', 'input, textarea, select', debounce(handleSettingChange, 300));
    $('#histSumm_forceUpdate').on('click', forceSummarize); // forceSummarize is now async
    $('#histSumm_clearCache').on('click', async () => { // Make listener async
        if (confirm("Are you sure you want to clear the block summary cache? This cannot be undone.")) {
            $('#histSumm_cache_status').text('Clearing...');
            const success = await clearSummaryCache(); // Await
            if (success) {
                $('#histSumm_cache_status').text('Cache Cleared!').css('color', 'lime');
                await refreshPreview(); // Await preview refresh
                lastSummaryContent = '';
                updatePromptWithSummary('');
            } else {
                $('#histSumm_cache_status').text('Clear Failed!').css('color', 'red');
            }
            setTimeout(() => $('#histSumm_cache_status').text(''), 3000);
        }
    });

    // Preview Panel Listeners (need async handlers)
    $('#histSumm_prevBlock').on('click', async () => await loadPreview(currentPreviewState.blockIndex - 1)); // Await
    $('#histSumm_nextBlock').on('click', async () => await loadPreview(currentPreviewState.blockIndex + 1)); // Await
    $('#histSumm_refreshPreview').on('click', refreshPreview); // refreshPreview is now async
    $('#histSumm_saveSummaryEdit').on('click', saveEditedSummary); // saveEditedSummary is now async

    // Drawer toggles (needs async preview refresh)
    $('#histSumm_settings').on('click', '.inline-drawer-toggle', async function() { // Make handler async
        const content = $(this).next('.inline-drawer-content');
        const icon = $(this).find('.inline-drawer-icon');
        content.slideToggle(200);
        icon.toggleClass('down up');
        if (content.has('#histSumm_blockIndicator').length > 0 && icon.hasClass('down')) {
             await refreshPreview(); // Await preview refresh
        }
    });

    // Set initial UI state
    updateUIFromSettings();

    // Register core event listeners (Unchanged)
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onMessageRendered);

    log('History Summarizer Extension loaded successfully (using Browser APIs).');
});
