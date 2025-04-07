const { extensions, getRequestHeaders, getApiUrl, loadExtensionSettings, saveExtensionSettings, getContext } = require('../../../script.js');
const { executeSlashCommands } = require('../../slash-commands'); // Helper for potential commands
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
// Use built-in fetch for Node >= 18, otherwise you might need node-fetch
// const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const extensionName = "history-summarizer";
const cacheDir = path.join(__dirname, 'cache');
let settings = {
    apiUrl: '',
    blockSize: 1000, // Characters
    summarySize: 150, // Target summary size (informational for the API, not enforced here)
    historySize: 2048, // Target token size for the final history prompt part
    promptTemplate: `This is a summary of the preceding conversation:\n{{summary_content}}\n\nContinue the conversation based on this summary and the most recent messages below:`,
    enabled: true,
};

let blockCache = new Map(); // In-memory cache for quick access during a session

// --- Helper Functions ---

function log(message) {
    console.log(`[${extensionName}] ${message}`);
}

async function ensureCacheDir() {
    try {
        await fs.access(cacheDir);
    } catch (error) {
        if (error.code === 'ENOENT') {
            await fs.mkdir(cacheDir);
            log('Cache directory created.');
        } else {
            console.error(`[${extensionName}] Error accessing cache directory:`, error);
        }
    }
}

function getBlockHash(blockDetails) {
    // Create hash based on the actual message content and structure
    const contentString = blockDetails.map(msg => `${msg.is_user ? 'U' : 'C'}:${msg.mes}`).join('|');
    return crypto.createHash('md5').update(contentString).digest('hex');
}

async function getSummaryFromCache(hash) {
    // Check in-memory first
    if (blockCache.has(hash)) {
        return blockCache.get(hash);
    }
    // Check file cache
    const cacheFile = path.join(cacheDir, `${hash}.json`);
    try {
        await fs.access(cacheFile);
        const data = await fs.readFile(cacheFile, 'utf-8');
        const summaryData = JSON.parse(data);
        blockCache.set(hash, summaryData.summary); // Populate in-memory cache
        return summaryData.summary;
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.error(`[${extensionName}] Error reading cache file ${cacheFile}:`, error);
        }
        return null; // Not found or error reading
    }
}

async function saveSummaryToCache(hash, summary) {
    blockCache.set(hash, summary); // Update in-memory cache
    const cacheFile = path.join(cacheDir, `${hash}.json`);
    try {
        await fs.writeFile(cacheFile, JSON.stringify({ summary }), 'utf-8');
    } catch (error) {
        console.error(`[${extensionName}] Error writing cache file ${cacheFile}:`, error);
    }
}

async function callSummarizationApi(blockDetails) {
    if (!settings.apiUrl) {
        log('Error: Summarization API URL is not set.');
        return null;
    }

    const blockContent = blockDetails.map(msg => `${msg.name}: ${msg.mes}`).join('\n');
    const payload = {
        block_content: blockContent, // Full text for potential context
        block_details: blockDetails, // Structured data as requested
        // You might want to add summary_size here if your API supports it
        // target_summary_size: settings.summarySize
    };

    try {
        log(`Sending block to API: ${JSON.stringify(payload).substring(0, 100)}...`);
        const response = await fetch(settings.apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                // Add any necessary Authorization headers here if needed
                // 'Authorization': 'Bearer YOUR_API_KEY'
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const errorText = await response.text();
            log(`Error calling summarization API: ${response.status} ${response.statusText} - ${errorText}`);
            return null;
        }

        const result = await response.json();
        log(`Received summary from API: ${result.summary.substring(0, 100)}...`);
        return result.summary || null; // Expecting { "summary": "..." }

    } catch (error) {
        console.error(`[${extensionName}] Network or fetch error calling summarization API:`, error);
        return null;
    }
}

// --- Core Logic ---

async function processHistoryForSummarization(chatHistory) {
    const blocks = [];
    let currentBlock = [];
    let currentBlockLength = 0;

    log(`Processing ${chatHistory.length} messages for summarization... Block size: ${settings.blockSize} chars.`);

    for (const message of chatHistory) {
        // Simple character count for mes
        const messageLength = message.mes ? message.mes.length : 0;

        // If adding this message exceeds block size (and block isn't empty)
        // or if the block gets too large anyway (safety)
        if (currentBlock.length > 0 && (currentBlockLength + messageLength > settings.blockSize || currentBlock.length > 100)) {
             // Finalize the current block
             const blockHash = getBlockHash(currentBlock);
             blocks.push({ hash: blockHash, details: [...currentBlock] }); // Store a copy
             // Reset for the next block
             currentBlock = [];
             currentBlockLength = 0;
        }

        // Add message to current block (if it has content)
        if (messageLength > 0) {
             // Use a standardized structure for details
             currentBlock.push({
                 name: message.name,
                 is_user: message.is_user,
                 mes: message.mes
             });
             currentBlockLength += messageLength;
        }
    }

    // Add the last remaining block if it has content
    if (currentBlock.length > 0) {
        const blockHash = getBlockHash(currentBlock);
        blocks.push({ hash: blockHash, details: currentBlock });
    }

    log(`Split history into ${blocks.length} blocks.`);

    // Get summaries for all blocks (using cache or API)
    const blockSummaries = [];
    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        let summary = await getSummaryFromCache(block.hash);
        if (summary === null) {
            log(`Cache miss for block ${i + 1}/${blocks.length} (hash: ${block.hash}). Calling API...`);
            summary = await callSummarizationApi(block.details);
            if (summary !== null) {
                await saveSummaryToCache(block.hash, summary);
            } else {
                summary = `[Error summarizing block ${i + 1}]`; // Placeholder on error
            }
        } else {
             log(`Cache hit for block ${i + 1}/${blocks.length} (hash: ${block.hash})`);
        }
        blockSummaries.push(summary);
        // Add a small delay to avoid overwhelming the API if many calls are needed
        if (summary === null || summary.startsWith('[Error')) await new Promise(resolve => setTimeout(resolve, 200));
    }

    return { blocks, blockSummaries };
}

// --- SillyTavern Integration ---

// Function to load settings from file
async function loadSettings() {
    try {
        const loaded = await loadExtensionSettings(extensionName);
        if (loaded && Object.keys(loaded).length > 0) {
            // Basic validation/migration could happen here
            settings = { ...settings, ...loaded };
            log('Settings loaded.');
        } else {
            log('No settings found, using defaults.');
            // Optionally save defaults on first load
            await saveExtensionSettings(extensionName, settings);
        }
        await ensureCacheDir(); // Ensure cache dir exists after loading settings
    } catch (error) {
        console.error(`[${extensionName}] Error loading settings:`, error);
    }
}

// Modify the prompt context before sending to LLM
async function onPromptInput(context) {
    if (!settings.enabled || !settings.apiUrl) {
        return context; // Do nothing if disabled or API not set
    }

    log('History Summarizer processing prompt...');

    // 1. Get relevant chat history (excluding WIP message)
    //    Need to adapt based on how ST structures context. Let's assume context.chat
    //    is the array of message objects. Adjust if it's context.historyString etc.
    //    We usually want the history *before* the latest user input.
    const chatHistory = context.chat?.filter(msg => !msg.is_system) || []; // Example: Filter system messages if needed

    if (chatHistory.length === 0) {
        log('No chat history to summarize.');
        return context;
    }

    // 2. Summarize the history
    const { blocks, blockSummaries } = await processHistoryForSummarization(chatHistory);

    if (blockSummaries.length === 0) {
        log('No summaries generated.');
        return context; // Nothing changed
    }

    // 3. Construct the summary block using the template
    const combinedSummary = blockSummaries.join('\n\n'); // Combine summaries
    const summaryPromptPart = settings.promptTemplate.replace('{{summary_content}}', combinedSummary);

    // 4. Calculate *approximate* token counts (using character length as proxy)
    //    A real tokenizer would be much better here.
    const templateChars = summaryPromptPart.length;
    const targetHistoryChars = settings.historySize * 4; // Very rough estimate: 1 token ~ 4 chars
    const remainingCharsForHistory = Math.max(0, targetHistoryChars - templateChars);
    log(`Target chars: ${targetHistoryChars}, Template chars: ${templateChars}, Remaining for history: ${remainingCharsForHistory}`);

    // 5. Truncate original history (keep the *most recent* messages)
    let truncatedHistory = [];
    let currentChars = 0;
    // Iterate backwards through the original history
    for (let i = chatHistory.length - 1; i >= 0; i--) {
        const message = chatHistory[i];
        const msgChars = (message.name ? message.name.length + 2 : 0) + (message.mes ? message.mes.length : 0); // name: mes\n

        if (currentChars + msgChars <= remainingCharsForHistory) {
            truncatedHistory.unshift(message); // Add to the beginning to maintain order
            currentChars += msgChars;
        } else {
            log(`Truncating history before message index ${i}. Kept ${currentChars} chars.`);
            break; // Stop once we exceed the character budget
        }
    }

    // 6. Inject into the context (This is the tricky part and depends heavily on ST version)
    //    Option A: Replace {{chat_history}} placeholder (if ST uses it this way)
    //    Option B: Modify the context.chat array directly
    //    Option C: Add a new system prompt as requested

    // Let's try Option C: Insert after first system prompt, add new system prompt, then the history.
    // We will construct a new `chat` array for the context.

    let finalChat = [];
    let firstSystemPromptFound = false;
    const summarySystemPrompt = {
        is_system: true,
        mes: summaryPromptPart,
        name: "System", // Or maybe leave name null? Check ST behavior
        is_summary_prompt: true // Custom flag for identification
    };

    // Add existing system prompts, inject ours after the first non-summary one
    if (context.chat) {
        for (const msg of context.chat) {
            if (msg.is_system && !msg.is_summary_prompt) { // Only consider original system prompts
                 finalChat.push(msg);
                 if (!firstSystemPromptFound) {
                     log('Injecting summary system prompt.');
                     finalChat.push(summarySystemPrompt);
                     firstSystemPromptFound = true;
                 }
            }
        }
    }


    // If no system prompt was found, add the summary prompt at the beginning
    if (!firstSystemPromptFound) {
         log('No system prompt found, adding summary prompt at the start.');
         finalChat.unshift(summarySystemPrompt);
    }

    // Add the truncated history messages
    finalChat = finalChat.concat(truncatedHistory);

    // Add any non-history messages from original context (like persona, user input - check ST structure)
    // This part needs careful checking based on the context structure provided by ST.
    // For simplicity, let's assume context.chat was the main thing to modify.
    // context.userInput etc. might need to be preserved separately.

    // Replace the chat in the context
    context.chat = finalChat;

    // Remove the {{chat_history}} placeholder if it exists elsewhere (e.g., in prompt fields)
    // This might require modifying context.prompt or similar fields.
    // For now, we assume modifying context.chat achieves the desired effect.
    // If ST constructs the final prompt string later, we might need to modify that string directly.
    // Let's log the intended structure:
    log(`Modified context.chat. Length: ${context.chat.length}`);
    // context.chat.forEach((msg, i) => log(`[${i}] ${msg.is_system ? 'SYS' : (msg.is_user ? 'USER' : 'AI')} (${msg.name}): ${msg.mes.substring(0, 50)}...`));


    log('Prompt modification complete.');
    return context;
}


// --- Event Handlers & API ---

// Called when extension settings are changed in the UI
extensions.on('settings-change', (extensionId, newSettings) => {
    if (extensionId === extensionName) {
        log('Settings changed via UI.');
        settings = { ...settings, ...newSettings };
        saveExtensionSettings(extensionName, settings);
    }
});

// Called when ST starts or extensions are reloaded
extensions.on('state:settings', async () => {
    await loadSettings();
});

// Register the input modifier
// Use 'prompt:input' or the correct event name for prompt modification in your ST version
// The priority might matter if other extensions modify the prompt. Lower numbers run first.
extensions.registerInputModifier(onPromptInput, extensionName, 10); // Priority 10

// API route for frontend communication (using simple message passing)
extensions.on(`${extensionName}:get_settings`, (callback) => {
    if (typeof callback === 'function') {
        callback(settings);
    }
});

extensions.on(`${extensionName}:get_preview`, async (data, callback) => {
    if (typeof callback === 'function') {
        try {
             // 1. Get full history (similar to onPromptInput, maybe reuse logic)
             //    Need access to the current chat context. This might require getting it from ST state.
             //    Let's assume we can get it via getContext() or similar.
             const context = getContext(); // Get current context (adapt as needed)
             const chatHistory = context.chat?.filter(msg => !msg.is_system) || [];

             if (chatHistory.length === 0) {
                 callback({ error: 'No history to process.' });
                 return;
             }

             // 2. Split into blocks
             const { blocks } = await processHistoryForSummarization(chatHistory);

             if (!blocks || blocks.length === 0) {
                 callback({ error: 'Could not split history into blocks.' });
                 return;
             }

             const blockIndex = data.blockIndex || 0;
             if (blockIndex < 0 || blockIndex >= blocks.length) {
                 callback({ error: `Invalid block index ${blockIndex}. Max index is ${blocks.length - 1}.` });
                 return;
             }

             // 3. Get content and summary for the requested block
             const targetBlock = blocks[blockIndex];
             const blockContent = targetBlock.details.map(msg => `${msg.name}: ${msg.mes}`).join('\n');
             let summary = await getSummaryFromCache(targetBlock.hash);

             if (summary === null) {
                 // Optionally trigger summarization just for this block if needed for preview
                 // summary = await callSummarizationApi(targetBlock.details);
                 // if (summary) await saveSummaryToCache(targetBlock.hash, summary);
                 // else summary = "[Summary not generated yet]";
                 summary = "[Summary not yet cached or generated]";
             }

             callback({
                 blockIndex: blockIndex,
                 totalBlocks: blocks.length,
                 blockContent: blockContent,
                 summaryContent: summary,
                 blockHash: targetBlock.hash // Send hash for potential editing identification
             });

        } catch (error) {
             console.error(`[${extensionName}] Error getting preview:`, error);
             callback({ error: 'Internal server error generating preview.' });
        }
    }
});

extensions.on(`${extensionName}:update_summary`, async (data, callback) => {
     if (typeof callback === 'function') {
         const { blockHash, newSummary } = data;
         if (blockHash && typeof newSummary === 'string') {
             log(`Updating summary for hash ${blockHash} via UI.`);
             await saveSummaryToCache(blockHash, newSummary);
             callback({ success: true });
         } else {
             callback({ success: false, error: 'Invalid data for summary update.' });
         }
     }
});


extensions.on(`${extensionName}:clear_cache`, async (callback) => {
    log('Clearing cache...');
    blockCache.clear(); // Clear in-memory cache
    try {
        const files = await fs.readdir(cacheDir);
        for (const file of files) {
            if (file.endsWith('.json')) {
                await fs.unlink(path.join(cacheDir, file));
            }
        }
        log('Cache directory cleared.');
        if (typeof callback === 'function') callback({ success: true });
    } catch (error) {
        if (error.code === 'ENOENT') {
             log('Cache directory does not exist, nothing to clear.');
             if (typeof callback === 'function') callback({ success: true }); // It's effectively cleared
        } else {
            console.error(`[${extensionName}] Error clearing cache directory:`, error);
            if (typeof callback === 'function') callback({ success: false, error: 'Failed to clear cache files.' });
        }
    }
});


// Initial load
loadSettings();

log('Extension loaded.');
