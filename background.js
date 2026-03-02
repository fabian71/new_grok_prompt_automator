// Background Service Worker para MV3 - Comunicação entre popup e content script
let contentScriptReady = new Map();

async function isContentScriptReady(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: "ping" });
    return true;
  } catch (error) {
    return false;
  }
}

async function ensureContentScript(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url.includes("grok.com/imagine")) {
      throw new Error("Não está na página do Grok Imagine");
    }

    if (await isContentScriptReady(tabId)) {
      return true;
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });

    await new Promise((resolve) => setTimeout(resolve, 1000));
    return await isContentScriptReady(tabId);
  } catch (error) {
    console.error("Erro ao garantir content script:", error);
    return false;
  }
}

async function sendMessageWithRetry(tabId, message, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const isReady = await ensureContentScript(tabId);
      if (!isReady) {
        throw new Error(`Content script não está pronto na aba ${tabId}`);
      }
      await chrome.tabs.sendMessage(tabId, message);
      return true;
    } catch (error) {
      console.warn(`Tentativa ${attempt}/${maxRetries} falhou:`, error.message);
      if (attempt === maxRetries) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
}

// Map to temporarily store potential filenames by URL to avoid race conditions with download ID
const pendingDownloads = new Map();

// Estado global para prefixos e pastas (Igual à extensão temp)
let globalDownloadFolder = "/";
let globalDownloadPrefix = "";
let globalAutoRename = true;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log(`[BG] Mensagem recebida: ${request.action || request.type}`);

  if (request.action === "startAutomation") {
    (async () => {
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const currentTab = tabs[0];

        if (!currentTab || !currentTab.url.includes("grok.com/imagine")) {
          throw new Error("Abra a página do Grok Imagine primeiro!");
        }

        await sendMessageWithRetry(currentTab.id, {
          action: "startAutomation",
          prompts: request.prompts,
          delay: request.delay,
          settings: request.settings,
          mode: request.mode,
        });
        sendResponse({ success: true });
      } catch (error) {
        console.error("Erro ao iniciar automação:", error);
        chrome.runtime
          .sendMessage({ action: "automationError", error: error.message })
          .catch(() => { });
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }

  if (request.action === "stopAutomation") {
    (async () => {
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const currentTab = tabs[0];

        if (currentTab && currentTab.url.includes("grok.com/imagine")) {
          await sendMessageWithRetry(currentTab.id, { action: "stopAutomation" });
        }
        sendResponse({ success: true });
      } catch (error) {
        console.error("Erro ao parar automação:", error);
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }

  if (request.action === "ping") {
    sendResponse({ status: 'awake' });
    return false; // Sync response
  }

  if (request.action === "contentScriptReady" && sender.tab) {
    contentScriptReady.set(sender.tab.id, true);
    sendResponse({ status: 'registered' });
    return false; // Sync response
  }

  if (
    request.action === "updateStatus" ||
    request.action === "automationComplete" ||
    request.action === "automationError"
  ) {
    console.log(`[BG] Encaminhando ${request.action} para popup`);
    chrome.runtime.sendMessage(request).catch((err) => {
      console.log(`[BG] Erro ao encaminhar (popup pode estar fechado):`, err.message);
    });
    sendResponse({ success: true });
    return false; // Sync response
  }

  if (request.action === "downloadImage") {
    console.log(`📥 [BG] Download solicitado: type=${request.type}, prompt=${request.prompt?.substring(0, 30)}...`);

    (async () => {
      try {
        const settings = await chrome.storage.local.get(["autoDownload", "savePromptTxt", "downloadSubfolder"]);
        console.log(`📥 [BG] Configs: autoDownload=${settings.autoDownload}, savePromptTxt=${settings.savePromptTxt}`);

        if (!settings.autoDownload) {
          console.log(`📥 [BG] autoDownload desativado, ignorando.`);
          sendResponse({ success: false, error: "Auto download disabled" });
          return;
        }

        const subfolder = settings.downloadSubfolder ? settings.downloadSubfolder.trim().replace(/[\\/]+$/g, '') : "";
        const originalPrompt = request.prompt || "imagem";
        const effectivePrompt = originalPrompt.trim() || "imagem";

        const safePrompt = effectivePrompt
          .replace(/[\\/:*?"<>|]/g, "_")
          .replace(/[^a-zA-Z0-9_\s\-]/g, "")
          .trim()
          .substring(0, 100) || "imagem";

        function detectExtFromUrl(url, type) {
          if (type === 'video') return 'mp4';
          try {
            if (url.startsWith("data:image/")) {
              const m = url.match(/^data:image\/([^;]+);/i);
              if (m && m[1]) {
                const sub = m[1].toLowerCase();
                if (sub === "jpeg") return "jpg";
                if (sub === "svg+xml") return "svg";
                return sub;
              }
            }
          } catch (_) { }
          return "png";
        }

        const ext = detectExtFromUrl(request.url, request.type);
        const timestamp = Date.now();
        const baseFilename = `${safePrompt}_${timestamp}`;
        let mainFilename = `${baseFilename}.${ext}`;
        let txtFilename = `${baseFilename}.txt`;

        if (subfolder) {
          mainFilename = `${subfolder}/${mainFilename}`;
          txtFilename = `${subfolder}/${txtFilename}`;
        }

        pendingDownloads.set(request.url, mainFilename);

        chrome.downloads.download({
          url: request.url,
          saveAs: false,
          conflictAction: 'uniquify'
        }, (downloadId) => {
          if (chrome.runtime.lastError) {
            console.error(`Falha no download da mídia: ${chrome.runtime.lastError.message}`);
            pendingDownloads.delete(request.url);
            sendResponse({ success: false, error: chrome.runtime.lastError.message });
          } else {
            console.log(`Mídia solicitada. ID: ${downloadId}`);
            sendResponse({ success: true, downloadId });
          }
        });

        // Txt download stays fire-and-forget
        if (settings.savePromptTxt) {
          const txtContent = originalPrompt;
          const base64Content = btoa(unescape(encodeURIComponent(txtContent)));
          const txtDataUrl = `data:text/plain;base64,${base64Content}`;
          pendingDownloads.set(txtDataUrl, txtFilename);
          chrome.downloads.download({
            url: txtDataUrl,
            saveAs: false,
            conflictAction: 'uniquify'
          });
        }
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  // ─── DOWNLOAD_IMAGE ──────────────────────────────
  if (request.type === "DOWNLOAD_IMAGE") {
    const { url, filename, prompt: dlPrompt, savePromptTxt: saveTxt } = request;
    if (!url || !filename) {
      sendResponse({ success: false, error: "url ou filename ausentes" });
      return false;
    }

    chrome.storage.local.get(["downloadSubfolder", "savePromptTxt"], (settings) => {
      const subfolder = (settings.downloadSubfolder || "").trim().replace(/[\\/]+$/g, "");
      const finalFilename = subfolder ? `${subfolder}/${filename}` : filename;

      console.log(`[📥 DOWNLOAD_IMAGE] ${finalFilename}`);
      pendingDownloads.set(url, finalFilename);

      chrome.downloads.download(
        { url, saveAs: false, filename: finalFilename, conflictAction: "uniquify" },
        (downloadId) => {
          if (chrome.runtime.lastError) {
            console.error(`[📥] Falha: ${chrome.runtime.lastError.message}`);
            pendingDownloads.delete(url);
            sendResponse({ success: false, error: chrome.runtime.lastError.message });
          } else {
            console.log(`[📥] Download iniciado. ID=${downloadId}`);
            sendResponse({ success: true, downloadId });
          }
        }
      );

      // Fire-and-forget text file
      const shouldSaveTxt = saveTxt !== undefined ? saveTxt : settings.savePromptTxt;
      if (shouldSaveTxt && dlPrompt) {
        const base64 = btoa(unescape(encodeURIComponent(dlPrompt)));
        const txtUrl = `data:text/plain;base64,${base64}`;
        const txtFilename = finalFilename.replace(/\.[^.]+$/, ".txt");
        pendingDownloads.set(txtUrl, txtFilename);
        chrome.downloads.download({ url: txtUrl, saveAs: false, filename: txtFilename, conflictAction: "uniquify" });
      }
    });
    return true;
  }

  if (request.action === "SETUP_DOWNLOAD" || request.type === "SETUP_DOWNLOAD") {
    const { folder, prefix, autoChangeFileName } = request;
    if (typeof folder === 'string') globalDownloadFolder = folder.trim() ? `${folder.trim()}/` : "/";
    if (typeof prefix === 'string') globalDownloadPrefix = prefix.trim();
    if (typeof autoChangeFileName === 'boolean') globalAutoRename = autoChangeFileName;
    sendResponse({ success: true });
    return false;
  }

  return false;
});

// Listener robusto para forçar nomes de arquivos e pastas
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  console.log(`[onDeterminingFilename] Item: ${item.filename}, URL: ${item.url.substring(0, 50)}...`);

  // 1. Verificar se temos um nome específico para esta URL (pendingDownloads)
  if (pendingDownloads.has(item.url)) {
    const desiredFilename = pendingDownloads.get(item.url);
    console.log(`[onDeterminingFilename] Aplicando nome específico: ${desiredFilename}`);
    pendingDownloads.delete(item.url); // Limpar após o uso

    suggest({
      filename: desiredFilename,
      conflictAction: 'uniquify'
    });
    return;
  }

  // 2. Se for uma mídia (mp4, jpg, png, etc) e o autoRename estiver ativo, aplicar folder/prefix
  // Igual à lógica da extensão temp: `${folder}${prefix}${originalFilename}`
  const isMedia = /\.(mp4|mov|webm|jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(item.filename || item.url);

  if (globalAutoRename && isMedia) {
    const originalName = item.filename.split(/[/\\]/).pop() || item.filename;
    const finalFilename = `${globalDownloadFolder}${globalDownloadPrefix}${originalName}`;
    console.log(`[onDeterminingFilename] Aplicando prefixo global: ${finalFilename}`);

    suggest({
      filename: finalFilename,
      conflictAction: 'uniquify'
    });
    return;
  }

  // 3. Fallback: comportamento padrão do navegador
  suggest();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  contentScriptReady.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    contentScriptReady.delete(tabId);
  }
});
