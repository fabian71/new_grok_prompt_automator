(function () {
    'use strict';

    if (window.whiskAutomatorLoaded) {
        return;
    }
    window.whiskAutomatorLoaded = true;

    // --- State Management ---
    let automationState = {
        isRunning: false,
        prompts: [],
        currentIndex: 0,
        delay: 45,
        timeoutId: null,
        settings: {
            randomize: false,
            aspectRatios: [],
            fixedRatio: '3:2',
            upscale: false,
            autoDownload: false,
            breakEnabled: false,
            breakPrompts: 90,
            breakDuration: 3
        },
        mode: 'video',
        modeApplied: false,
        startTime: null,
        upscaledPrompts: new Set(),
        processingPrompts: new Set(),
        downloadedVideos: new Set(),
        processedVideoUrls: new Set(),
        imageDownloadInitiated: false,
        imagesDownloadedCount: 0,
        lastPromptSentIndex: -1,
        restoredFromReload: false,
        promptsSinceLastBreak: 0,
        isOnBreak: false,
        breakEndTime: null
    };

    // --- Keep-Alive para Service Worker ---
    let keepAliveInterval = null;

    function startKeepAlive() {
        if (keepAliveInterval) return;
        console.log('🔥 Keep-alive iniciado');
        keepAliveInterval = setInterval(() => {
            chrome.runtime.sendMessage({ action: 'ping' }).catch(() => { });
        }, 20000); // Ping a cada 20 segundos
    }

    function stopKeepAlive() {
        if (keepAliveInterval) {
            console.log('🔥 Keep-alive parado');
            clearInterval(keepAliveInterval);
            keepAliveInterval = null;
        }
    }

    // --- Persistence Helpers ---
    async function saveAutomationState() {
        // Sync currentIndex with currentImageIndex for image-to-video mode before saving
        if (automationState.mode === 'image-to-video') {
            automationState.currentIndex = automationState.currentImageIndex;
        }

        const stateToSave = {
            ...automationState,
            upscaledPrompts: Array.from(automationState.upscaledPrompts),
            processingPrompts: Array.from(automationState.processingPrompts),
            downloadedVideos: Array.from(automationState.downloadedVideos),
            processedVideoUrls: Array.from(automationState.processedVideoUrls)
        };
        delete stateToSave.timeoutId;

        // Log para debug
        console.log('💾 Salvando estado:', {
            mode: stateToSave.mode,
            currentIndex: stateToSave.currentIndex,
            currentImageIndex: stateToSave.currentImageIndex,
            imageQueueLength: stateToSave.imageQueue?.length || 0,
            promptsLength: stateToSave.prompts?.length || 0,
            isRunning: stateToSave.isRunning
        });

        await chrome.storage.local.set({ 'grokAutomationState': stateToSave });
    }

    async function clearAutomationState() {
        await chrome.storage.local.remove('grokAutomationState');
        // Também atualizar automationActive para false
        await chrome.storage.local.set({ automationActive: false });
    }

    async function loadAutomationState() {
        try {
            // Check if we're on the correct page first
            const isGrokImagine = window.location.href.includes('grok.com/imagine');

            const result = await chrome.storage.local.get('grokAutomationState');
            if (result.grokAutomationState && result.grokAutomationState.isRunning) {

                // If not on Grok Imagine page, clear the old state
                if (!isGrokImagine) {
                    console.log('⚠️ Estado de automação encontrado, mas não estamos na página do Grok. Limpando...');
                    await clearAutomationState();
                    return;
                }

                const saved = result.grokAutomationState;

                // Additional validation: check if prompts exist OR imageQueue exists (for image-to-video mode)
                const hasPrompts = saved.prompts && saved.prompts.length > 0;
                const hasImageQueue = saved.imageQueue && saved.imageQueue.length > 0;

                if (!hasPrompts && !hasImageQueue) {
                    console.log('⚠️ Estado restaurado não tem prompts nem imageQueue. Limpando...');
                    await clearAutomationState();
                    return;
                }

                automationState = {
                    ...saved,
                    // Ensure prompts and settings always exist with defaults
                    prompts: saved.prompts || [],
                    settings: {
                        randomize: false,
                        aspectRatios: [],
                        fixedRatio: '3:2',
                        upscale: false,
                        autoDownload: false,
                        breakEnabled: false,
                        breakPrompts: 90,
                        breakDuration: 3,
                        ...(saved.settings || {})
                    },
                    upscaledPrompts: new Set(saved.upscaledPrompts || []),
                    processingPrompts: new Set(saved.processingPrompts || []),
                    downloadedVideos: new Set(saved.downloadedVideos || []),
                    processedVideoUrls: new Set(saved.processedVideoUrls || []),
                    timeoutId: null,
                    restoredFromReload: true,
                    modeApplied: false // Force re-check of mode on new page
                };

                console.log('♻️ Estado da automação restaurado após reload.', {
                    mode: automationState.mode,
                    prompts: automationState.prompts?.length || 0,
                    imageQueue: automationState.imageQueue?.length || 0,
                    currentIndex: automationState.currentIndex,
                    currentImageIndex: automationState.currentImageIndex
                });

                // Check completion based on mode
                const isComplete = automationState.mode === 'image-to-video'
                    ? automationState.currentImageIndex >= automationState.imageQueue.length
                    : automationState.currentIndex >= automationState.prompts.length;

                if (isComplete) {
                    console.log('✅ Estado restaurado indica conclusão. Finalizando...');
                    handleAutomationComplete();
                    return;
                }

                // Resume logic
                if (automationState.isRunning) {
                    console.log('🔄 Retomando automação após reload...');
                    startOverlayTimer(); // Start timer immediately for restored state

                    if (automationState.mode === 'image-to-video') {
                        // Resume Image-to-Video
                        if (automationState.imageQueue && automationState.currentImageIndex < automationState.imageQueue.length) {
                            console.log(`🎬 Retomando Image-to-Video: imagem ${automationState.currentImageIndex + 1}/${automationState.imageQueue.length}`);
                            console.log('⏳ Aguardando 3s para página estabilizar...');
                            setTimeout(() => {
                                runImageToVideoAutomation();
                            }, 3000);
                        } else {
                            // If imageQueue is exhausted or invalid, treat as complete
                            console.log('✅ Image-to-Video queue concluída ou inválida. Finalizando...');
                            handleAutomationComplete();
                        }
                    } else {
                        // Resume Text-to-Image/Video
                        automationState.restoredFromReload = true;

                        // Wait a bit for UI to settle then resume
                        setTimeout(() => {
                            runAutomation();
                        }, 2000);
                    }
                }
            }
        } catch (e) {
            console.error('Erro ao carregar estado:', e);
            // If there's an error, clear the state to prevent loops
            await clearAutomationState();
        }
    }

    // --- Selectors ---
    const SELECTORS = {
        textarea: '.tiptap.ProseMirror',
        submitButton: 'button[aria-label="Enviar"]',
        aspectRatioMenuItem: '[role="menuitem"]'
    };

    // --- Overlay Helpers ---
    function ensureOverlay() {
        if (overlayState.container) return overlayState.container;

        const container = document.createElement('div');
        Object.assign(container.style, {
            position: 'fixed',
            bottom: '20px',
            right: '20px',
            width: '360px',
            maxWidth: '90vw',
            zIndex: '999999',
            backdropFilter: 'blur(12px)',
            background: 'linear-gradient(180deg, rgba(15, 23, 42, 0.95), rgba(15, 23, 42, 0.85))',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            boxShadow: '0 20px 40px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(56, 189, 248, 0.1)',
            borderRadius: '16px',
            overflow: 'hidden',
            color: '#e5e7eb',
            fontFamily: "'Trebuchet MS', 'Segoe UI', sans-serif",
            opacity: '0',
            transform: 'translateY(10px)',
            transition: 'opacity 160ms ease, transform 200ms ease'
        });

        // Header com gradiente igual ao da extensão
        const header = document.createElement('div');
        Object.assign(header.style, {
            background: 'linear-gradient(135deg, rgba(56, 189, 248, 0.25), rgba(14, 165, 233, 0.1))',
            padding: '14px 16px',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between'
        });

        // Logo e título
        const logoSection = document.createElement('div');
        Object.assign(logoSection.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '10px'
        });

        // Ícone/logo (círculo com gradiente)
        const iconDiv = document.createElement('div');
        Object.assign(iconDiv.style, {
            width: '28px',
            height: '28px',
            borderRadius: '8px',
            background: 'linear-gradient(135deg, #38bdf8, #0ea5e9)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '14px',
            fontWeight: 'bold',
            color: '#fff',
            boxShadow: '0 4px 12px rgba(14, 165, 233, 0.3)'
        });
        iconDiv.textContent = 'G';
        logoSection.appendChild(iconDiv);

        const titleText = document.createElement('div');
        Object.assign(titleText.style, {
            fontSize: '15px',
            fontWeight: '700',
            color: '#e5e7eb'
        });
        titleText.textContent = 'Grok Automator';
        logoSection.appendChild(titleText);

        header.appendChild(logoSection);

        // Seção direita: badge de status e botão fechar
        const rightSection = document.createElement('div');
        Object.assign(rightSection.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '10px'
        });

        // Badge de versão/status
        const statusBadge = document.createElement('div');
        Object.assign(statusBadge.style, {
            padding: '4px 10px',
            borderRadius: '999px',
            fontSize: '11px',
            fontWeight: '700',
            letterSpacing: '0.6px',
            background: 'rgba(56, 189, 248, 0.15)',
            border: '1px solid rgba(56, 189, 248, 0.35)',
            color: '#7dd3fc'
        });
        statusBadge.textContent = 'v2.0';
        rightSection.appendChild(statusBadge);

        // Botão fechar (X)
        const closeBtn = document.createElement('button');
        Object.assign(closeBtn.style, {
            width: '24px',
            height: '24px',
            borderRadius: '6px',
            border: 'none',
            background: 'rgba(239, 68, 68, 0.15)',
            color: '#ef4444',
            fontSize: '14px',
            fontWeight: '700',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'all 150ms ease'
        });
        closeBtn.innerHTML = '✕';
        closeBtn.title = 'Fechar overlay';
        closeBtn.onmouseenter = () => {
            closeBtn.style.background = 'rgba(239, 68, 68, 0.25)';
            closeBtn.style.transform = 'scale(1.05)';
        };
        closeBtn.onmouseleave = () => {
            closeBtn.style.background = 'rgba(239, 68, 68, 0.15)';
            closeBtn.style.transform = 'scale(1)';
        };
        closeBtn.onclick = () => {
            hideOverlay();
        };
        rightSection.appendChild(closeBtn);

        header.appendChild(rightSection);
        container.appendChild(header);

        // Conteúdo principal
        const content = document.createElement('div');
        Object.assign(content.style, {
            padding: '14px 16px 16px'
        });

        // Status
        const statusEl = document.createElement('div');
        Object.assign(statusEl.style, {
            fontSize: '13px',
            fontWeight: '600',
            color: '#38bdf8',
            marginBottom: '10px'
        });
        statusEl.textContent = 'Pronto';

        // Prompt
        const promptEl = document.createElement('div');
        Object.assign(promptEl.style, {
            fontSize: '13px',
            lineHeight: '1.4',
            color: '#d1d5db',
            maxHeight: '60px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            marginBottom: '10px',
            padding: '10px',
            background: 'rgba(255, 255, 255, 0.04)',
            borderRadius: '10px',
            border: '1px solid rgba(255, 255, 255, 0.06)'
        });

        // Info row (counter + timer)
        const infoRow = document.createElement('div');
        Object.assign(infoRow.style, {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '8px',
            fontSize: '12px',
            color: '#9ca3af'
        });

        const counterEl = document.createElement('div');
        counterEl.textContent = '';

        const timerEl = document.createElement('div');
        timerEl.textContent = 'Tempo: 00:00';

        infoRow.appendChild(counterEl);
        infoRow.appendChild(timerEl);

        // Break info
        const breakInfoEl = document.createElement('div');
        Object.assign(breakInfoEl.style, {
            fontSize: '11px',
            color: '#f59e0b',
            display: 'none',
            marginBottom: '8px',
            padding: '6px 10px',
            background: 'rgba(245, 158, 11, 0.1)',
            borderRadius: '8px',
            border: '1px solid rgba(245, 158, 11, 0.2)'
        });

        // Progress bar
        const progressTrack = document.createElement('div');
        Object.assign(progressTrack.style, {
            width: '100%',
            height: '6px',
            borderRadius: '999px',
            background: 'rgba(255, 255, 255, 0.06)',
            overflow: 'hidden',
            marginBottom: '12px'
        });

        const progressBar = document.createElement('div');
        Object.assign(progressBar.style, {
            height: '100%',
            width: '0%',
            background: 'linear-gradient(90deg, #38bdf8, #0ea5e9)',
            transition: 'width 160ms ease',
            borderRadius: '999px'
        });
        progressTrack.appendChild(progressBar);

        // Footer com donate
        const footer = document.createElement('div');
        Object.assign(footer.style, {
            padding: '12px 16px',
            borderTop: '1px solid rgba(255, 255, 255, 0.06)',
            background: 'rgba(255, 255, 255, 0.02)',
            fontSize: '12px',
            color: '#9ca3af',
            textAlign: 'center'
        });
        footer.innerHTML = 'Gosta do projeto? <span style="color:#f43f5e;">♥</span> Me paga um cafezinho: <a href="https://ko-fi.com/dentparanoide" target="_blank" rel="noopener noreferrer" style="color:#38bdf8; text-decoration: none; font-weight: 600;">ko-fi.com/dentparanoide</a>';

        // Montar conteúdo
        content.appendChild(statusEl);
        content.appendChild(promptEl);
        content.appendChild(infoRow);
        content.appendChild(breakInfoEl);
        content.appendChild(progressTrack);

        container.appendChild(content);
        container.appendChild(footer);

        document.body.appendChild(container);

        overlayState.container = container;
        overlayState.statusEl = statusEl;
        overlayState.promptEl = promptEl;
        overlayState.counterEl = counterEl;
        overlayState.timerEl = timerEl;
        overlayState.breakInfoEl = breakInfoEl;
        overlayState.progressBar = progressBar;
        overlayState.closeBtn = closeBtn;
        overlayState.statusBadge = statusBadge;

        requestAnimationFrame(() => {
            container.style.opacity = '1';
            container.style.transform = 'translateY(0)';
        });
        return container;
    }

    function formatDuration(totalSeconds) {
        const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
        const seconds = Math.floor(totalSeconds % 60).toString().padStart(2, '0');
        return `${minutes}:${seconds}`;
    }

    function updateOverlay({ status, prompt, index, total, elapsedSeconds }) {
        ensureOverlay();
        overlayState.lastData = { status, prompt, index, total };
        if (overlayState.statusEl) overlayState.statusEl.textContent = status || '...';
        if (overlayState.promptEl) overlayState.promptEl.textContent = prompt || '';
        if (overlayState.counterEl && total) {
            overlayState.counterEl.textContent = index
                ? `Prompt ${index} de ${total}`
                : `Total: ${total}`;
        }
        if (overlayState.timerEl && typeof automationState !== 'undefined') {
            const elapsed = typeof elapsedSeconds === 'number'
                ? elapsedSeconds
                : (automationState.startTime ? Math.max(0, Math.floor((Date.now() - automationState.startTime) / 1000)) : 0);
            overlayState.timerEl.textContent = `Tempo: ${formatDuration(elapsed)}`;
        }
        if (overlayState.progressBar && total) {
            const pct = Math.min(100, Math.max(0, Math.round(((index || 0) / total) * 100)));
            overlayState.progressBar.style.width = `${pct}%`;
        }

        // Update break info - only show if total prompts > breakPrompts setting
        const shouldShowBreakInfo = overlayState.breakInfoEl &&
            automationState.settings?.breakEnabled &&
            automationState.prompts.length > (automationState.settings?.breakPrompts || 0);

        if (shouldShowBreakInfo) {
            overlayState.breakInfoEl.style.display = 'block';

            if (automationState.isOnBreak && automationState.breakEndTime) {
                const remainingMs = automationState.breakEndTime - Date.now();
                if (remainingMs > 0) {
                    const remainingSec = Math.ceil(remainingMs / 1000);
                    overlayState.breakInfoEl.textContent = `☕ Pausa: ${formatDuration(remainingSec)} restantes`;
                    overlayState.breakInfoEl.style.color = '#ff9800';
                } else {
                    overlayState.breakInfoEl.textContent = '☕ Retomando...';
                }
            } else {
                const promptsUntilBreak = (automationState.settings?.breakPrompts || 0) - automationState.promptsSinceLastBreak;
                overlayState.breakInfoEl.textContent = `⏱️ Próxima pausa em ${promptsUntilBreak} prompts (${automationState.settings?.breakDuration || 0} min)`;
                overlayState.breakInfoEl.style.color = '#ffcc80';
            }
        } else if (overlayState.breakInfoEl) {
            overlayState.breakInfoEl.style.display = 'none';
        }

        if (overlayState.container) overlayState.container.style.display = 'block';
    }

    function hideOverlay() {
        if (!overlayState.container) return;
        overlayState.container.style.opacity = '0';
        overlayState.container.style.transform = 'translateY(10px)';
        setTimeout(() => {
            if (overlayState.container) overlayState.container.style.display = 'none';
        }, 200);
    }

    function clearOverlay() {
        if (!overlayState.container) return;

        // Clear all text content
        if (overlayState.statusEl) overlayState.statusEl.textContent = '';
        if (overlayState.promptEl) overlayState.promptEl.textContent = '';
        if (overlayState.counterEl) overlayState.counterEl.textContent = '';
        if (overlayState.timerEl) overlayState.timerEl.textContent = '';
        if (overlayState.progressBar) overlayState.progressBar.style.width = '0%';

        // Reset last data
        overlayState.lastData = {};

        // Hide the overlay
        hideOverlay();
    }

    function startOverlayTimer() {
        if (overlayState.timerInterval) return;
        overlayState.timerInterval = setInterval(() => {
            updateOverlay(overlayState.lastData || {});
        }, 1000);
    }

    function stopOverlayTimer() {
        if (overlayState.timerInterval) {
            clearInterval(overlayState.timerInterval);
            overlayState.timerInterval = null;
        }
    }

    // --- Overlay State ---
    const overlayState = {
        container: null,
        statusEl: null,
        promptEl: null,
        counterEl: null,
        timerEl: null,
        progressBar: null,
        timerInterval: null,
        lastData: {}
    };

    // --- Utility Functions ---
    function findElement(selector, parent = document) {
        return parent.querySelector(selector);
    }

    function findAllElements(selector, parent = document) {
        return Array.from(parent.querySelectorAll(selector));
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function normalizeText(text) {
        return (text || '')
            .normalize('NFD')
            .replace(/\p{Diacritic}/gu, '')
            .toLowerCase()
            .trim();
    }

    function isVisible(element) {
        if (!element) return false;
        const style = window.getComputedStyle(element);
        return style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.opacity !== '0' &&
            element.offsetParent !== null;
    }

    function waitForElement(selector, timeout = 10000) {
        return new Promise((resolve, reject) => {
            const element = findElement(selector);
            if (element) return resolve(element);

            const observer = new MutationObserver(() => {
                const element = findElement(selector);
                if (element) {
                    observer.disconnect();
                    resolve(element);
                }
            });

            const timer = setTimeout(() => {
                observer.disconnect();
                reject(new Error(`Elemento não encontrado: ${selector}`));
            }, timeout);

            observer.observe(document.body, { childList: true, subtree: true });
        });
    }

    function simulateTyping(element, text) {
        element.focus();
        if (element.isContentEditable) {
            element.innerHTML = `<p>${text}</p>`;
        } else {
            element.value = text;
        }
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
    }

    async function sendMessageToBackground(message) {
        try {
            // Acordar Service Worker com ping primeiro
            await chrome.runtime.sendMessage({ action: 'ping' }).catch(() => { });

            // Agora enviar mensagem real
            chrome.runtime.sendMessage(message, (response) => {
                if (chrome.runtime.lastError) {
                    console.error('❌ Erro ao enviar mensagem:', chrome.runtime.lastError.message);
                } else {
                    console.log('✅ Mensagem enviada:', response);
                }
            });
        } catch (error) {
            console.error('❌ Falha ao enviar mensagem:', error);
        }
    }

    // --- Interaction Helpers ---
    function forceClick(element) {
        if (!element) return;

        // Ensure visibility
        element.style.pointerEvents = 'auto';
        element.style.visibility = 'visible';
        element.style.opacity = '1';
        element.style.display = 'block';

        if (element.scrollIntoView) {
            element.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
        }

        const events = [
            'pointerover', 'pointerenter', 'mouseover', 'mouseenter',
            'pointermove', 'mousemove',
            'pointerdown', 'mousedown',
            'focus', 'focusin',
            'pointerup', 'mouseup',
            'click'
        ];

        const rect = element.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;

        events.forEach(type => {
            const event = new MouseEvent(type, {
                bubbles: true,
                cancelable: true,
                view: window,
                clientX: x,
                clientY: y,
                buttons: 1
            });
            element.dispatchEvent(event);
        });

        try {
            element.click();
        } catch (e) { }
    }

    function findMoreOptionsButton(parent = document) {
        // 1. Search by aria-label
        const targets = ['mais opcoes', 'more options', 'mais opciones'];
        const buttons = findAllElements('button[aria-label], button', parent);

        let found = buttons.find(btn => {
            const label = normalizeText(btn.getAttribute('aria-label') || btn.title || btn.textContent);
            return targets.some(target => label.includes(target));
        });

        if (found) return found;

        // 2. Search by SVG icon (ellipsis)
        const allButtons = findAllElements('button', parent);
        for (const btn of allButtons) {
            const svg = btn.querySelector('svg.lucide-ellipsis');
            if (svg) {
                const circles = svg.querySelectorAll('circle');
                if (circles.length === 3) return btn;
            }
        }

        return null;
    }

    async function openMenuAndGetItems(button, maxAttempts = 4) {
        for (let i = 0; i < maxAttempts; i++) {
            console.log(`🔄 Tentativa ${i + 1}/${maxAttempts} de abrir menu...`);
            forceClick(button);

            // Poll for menu items - mais rápido
            for (let j = 0; j < 6; j++) {
                await sleep(200);
                const items = findAllElements('[role="menuitem"]');
                if (items.length > 0) {
                    return items;
                }
            }
            await sleep(300);
        }
        return [];
    }

    // --- Aspect Ratio Helpers ---
    function findModelOptionsTrigger() {
        const buttons = findAllElements('button');
        return buttons.find(btn => {
            const label = normalizeText(btn.getAttribute('aria-label') || btn.textContent || '');
            return btn.id === 'model-select-trigger' || label.includes('selecao de modelo') || label.includes('modelo');
        });
    }

    function findAspectRatioOption(targetRatio) {
        const normalizedTarget = targetRatio.replace(/\s+/g, '').toLowerCase();
        const buttons = findAllElements('button');
        return buttons.find(btn => {
            const label = (btn.getAttribute('aria-label') || btn.textContent || '').replace(/\s+/g, '').toLowerCase();
            return label.includes(normalizedTarget);
        });
    }

    async function selectGenerationMode(mode) {
        console.log(`🎯 Tentando selecionar modo: ${mode}`);

        // Aguardar o botão aparecer (página pode estar carregando)
        let trigger = null;
        let attempts = 0;
        while (!trigger && attempts < 15) {
            // Tentar múltiplos seletores
            trigger = document.getElementById('model-select-trigger') ||
                document.querySelector('button[aria-label="Seleção de modelo"]') ||
                document.querySelector('button[id*="model"]') ||
                document.querySelector('button:has(svg.lucide-play)');

            if (!trigger) {
                console.log(`⏳ Aguardando botão de modelo... tentativa ${attempts + 1}/15`);
                await sleep(500);
                attempts++;
            }
        }

        if (!trigger) {
            console.warn('❌ Botão de modelo não encontrado após 15 tentativas.');
            console.log('🔍 Seletores disponíveis:',
                Array.from(document.querySelectorAll('button')).map(b => ({ id: b.id, ariaLabel: b.getAttribute('aria-label'), text: b.textContent?.substring(0, 50) }))
            );
            return false;
        }

        console.log('✅ Botão de modelo encontrado:', trigger.id || trigger.getAttribute('aria-label') || 'sem ID');

        const targetIsVideo = mode === 'video';

        // Helper to check current mode
        const checkCurrentMode = () => {
            const triggerText = normalizeText(trigger.textContent || '');
            const isVideo = /v[ií]deo|video/i.test(triggerText);
            const isImage = /imag[em]|image/i.test(triggerText);
            console.log(`📊 Modo atual no botão: "${triggerText}" (Video=${isVideo}, Image=${isImage})`);
            return targetIsVideo ? isVideo : isImage;
        };

        // Enhanced click function for menu items
        const robustClick = async (element) => {
            if (!element) return false;

            // Scroll into view
            element.scrollIntoView({ behavior: 'instant', block: 'center' });
            await sleep(100);

            // Focus the element
            try {
                element.focus();
            } catch (e) { }
            await sleep(100);

            // Try multiple click methods
            console.log('🖱️ Executando clique robusto...');

            // Method 1: PointerEvent + MouseEvent + Click
            const rect = element.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;

            ['pointerdown', 'mousedown', 'mouseup', 'click', 'pointerup'].forEach(type => {
                const event = new PointerEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    view: window,
                    clientX: x,
                    clientY: y,
                    pointerId: 1,
                    pointerType: 'mouse',
                    isPrimary: true,
                    buttons: type.includes('down') ? 1 : 0
                });
                element.dispatchEvent(event);
            });

            // Method 2: Direct click
            try {
                element.click();
            } catch (e) { }

            await sleep(200);
            return true;
        };

        // Check if already in correct mode
        if (checkCurrentMode()) {
            console.log('✅ Já está no modo correto!');
            return true;
        }

        for (let attempt = 0; attempt < 6; attempt++) {
            console.log(`🔄 Tentativa ${attempt + 1}/6 de selecionar modo...`);

            // Click trigger to open menu  
            await robustClick(trigger);
            await sleep(700);

            const menuItems = findAllElements('[role="menuitem"]');
            console.log(`📋 ${menuItems.length} itens de menu encontrados`);

            if (menuItems.length < 2) {
                console.warn('⚠️ Menu não abriu corretamente');
                await sleep(400);
                continue;
            }

            let targetOption = null;

            // Log all menu items for debugging
            menuItems.forEach((item, i) => {
                console.log(`  [${i}] "${normalizeText(item.textContent || '')}"`);
            });

            for (let i = 0; i < menuItems.length; i++) {
                const item = menuItems[i];
                const itemText = normalizeText(item.textContent || '');

                // Skip duration/settings options
                if (/duracao|duration|proporcao|proportion|aspect/i.test(itemText)) {
                    continue;
                }

                // Look for "gerar" + "video" or just standalone "video" at start
                const videoPattern = /^video|gerar.*v[ií]deo/i;
                const imagePattern = /^imag[em]|gerar.*imag[em]/i;

                if (targetIsVideo && videoPattern.test(itemText)) {
                    targetOption = item;
                    console.log(`🎥 VÍDEO encontrado: "${itemText}"`);
                    break;
                } else if (!targetIsVideo && imagePattern.test(itemText)) {
                    targetOption = item;
                    console.log(`🖼️ IMAGEM encontrada: "${itemText}"`);
                    break;
                }
            }

            // Fallback: Image=0, Video=1
            if (!targetOption && menuItems.length >= 2) {
                console.log('⚠️ Usando fallback por índice...');
                targetOption = menuItems[targetIsVideo ? 1 : 0];
                console.log(`   Selecionando índice ${targetIsVideo ? 1 : 0}: "${normalizeText(targetOption.textContent || '')}"`);
            }

            if (targetOption) {
                // Try clicking multiple times if needed
                for (let clickAttempt = 0; clickAttempt < 3; clickAttempt++) {
                    console.log(`🖱️ Clique ${clickAttempt + 1}/3 no item do menu...`);
                    await robustClick(targetOption);
                    await sleep(900);

                    // Verify the change was successful
                    if (checkCurrentMode()) {
                        console.log(`✅✅✅ Modo ${targetIsVideo ? 'VÍDEO' : 'IMAGEM'} selecionado COM SUCESSO!`);
                        return true;
                    }

                    console.warn(`⚠️ Clique ${clickAttempt + 1} não mudou o modo. ${clickAttempt < 2 ? 'Tentando novamente...' : ''}`);
                }

                console.warn('❌ 3 cliques no item não surtiram efeito.');
            }

            await sleep(500);
        }

        console.error(`❌❌❌ FALHOU ao selecionar modo ${targetIsVideo ? 'VÍDEO' : 'IMAGEM'} após 6 tentativas!`);
        return false;
    }

    async function selectAspectRatio(aspectRatio) {
        const target = aspectRatio || '';
        let option = findAspectRatioOption(target);

        if (!option || !isVisible(option)) {
            const trigger = findModelOptionsTrigger();
            if (trigger) {
                for (let i = 0; i < 3 && (!option || !isVisible(option)); i++) {
                    forceClick(trigger);
                    await sleep(400);
                    option = findAspectRatioOption(target);
                }
            }
        }

        if (option) {
            forceClick(option);
            await sleep(200);
            return true;
        }

        console.warn(`Aspect ratio "${aspectRatio}" nǜo encontrado.`);
        return false;
    }

    // --- Download Helper ---
    const triggerDownload = async (url, type, promptIndex = null) => {
        // Determine correct index based on mode
        let actualIndex;
        if (promptIndex !== null && promptIndex >= 0) {
            actualIndex = promptIndex;
        } else if (automationState.mode === 'image-to-video') {
            actualIndex = automationState.currentImageIndex;
        } else if (automationState.mode === 'video') {
            // Para modo vídeo, usar processedVideoUrls.size - 1
            // processedVideoUrls é incrementado imediatamente no detection
            actualIndex = Math.max(0, automationState.processedVideoUrls.size - 1);
        } else {
            // Para modo imagem, usar currentIndex - 1
            actualIndex = Math.max(0, automationState.currentIndex - 1);
        }

        // Garantir que índice nunca seja negativo
        if (actualIndex < 0) {
            actualIndex = 0;
        }

        console.log(`📥 triggerDownload: type=${type}, actualIndex=${actualIndex}, mode=${automationState.mode}, currentIndex=${automationState.currentIndex}`);

        if (type === 'video' && automationState.downloadedVideos.has(actualIndex)) {
            console.log(`✅ Download já marcado para índice ${actualIndex}, ignorando duplicata.`);
            return;
        }

        let prompt = 'prompt_desconhecido';

        if (automationState.mode === 'image-to-video' && automationState.imageQueue) {
            const imgData = automationState.imageQueue[actualIndex];
            if (imgData) prompt = imgData.name;
        } else if (automationState.prompts) {
            prompt = automationState.prompts[actualIndex] || 'prompt_desconhecido';
        }

        console.log(`📥 Nome do arquivo: ${prompt}`);

        const send = async (finalUrl) => {
            await sleep(500);

            // Tentar enviar mensagem com retry
            let attempts = 0;
            const maxAttempts = 3;
            let success = false;

            while (attempts < maxAttempts && !success) {
                attempts++;
                console.log(`📤 Enviando para background (tentativa ${attempts}/${maxAttempts}): action=downloadImage, prompt=${prompt}`);

                try {
                    const response = await new Promise((resolve) => {
                        chrome.runtime.sendMessage({
                            action: 'downloadImage',
                            url: finalUrl,
                            prompt: prompt,
                            type: type
                        }, (resp) => {
                            if (chrome.runtime.lastError) {
                                console.warn(`⚠️ Erro na tentativa ${attempts}:`, chrome.runtime.lastError.message);
                                resolve(null);
                            } else {
                                resolve(resp);
                            }
                        });
                    });

                    if (response) {
                        console.log(`✅ Mensagem enviada com sucesso! Resposta:`, response);
                        success = true;
                    } else {
                        console.warn(`⚠️ Tentativa ${attempts} falhou, aguardando antes de retry...`);
                        await sleep(1000);
                    }
                } catch (error) {
                    console.error(`❌ Erro ao enviar mensagem (tentativa ${attempts}):`, error);
                    await sleep(1000);
                }
            }

            if (!success) {
                console.error(`❌ Falhou ao enviar mensagem após ${maxAttempts} tentativas`);
                return;
            }

            // Só marcar como baixado se o envio foi bem-sucedido
            if (type === 'video') {
                console.log(`✅ Marcando vídeo ${actualIndex} como baixado`);
                automationState.downloadedVideos.add(actualIndex);
                saveAutomationState();
            }
        };

        // Se o vídeo vier como blob:, converte para data URL
        if (type === 'video' && url && url.startsWith('blob:')) {
            fetch(url)
                .then(resp => resp.blob())
                .then(blob => new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result);
                    reader.onerror = reject;
                    reader.readAsDataURL(blob);
                }))
                .then(dataUrl => send(dataUrl))
                .catch(err => {
                    console.warn('Falha ao converter blob de vídeo, usando URL original', err);
                    send(url);
                });
            return;
        }

        send(url);
    };

    // --- Upscale Logic ---
    async function waitForUpscaleComplete(container, maxWaitTime = 60000) {
        const startTime = Date.now();
        console.log('⏳ Aguardando upscale HD terminar...');

        while ((Date.now() - startTime) < maxWaitTime) {
            try {
                // Look for HD button indicator
                const hdButtons = findAllElements('button');
                const hdButton = hdButtons.find(btn => {
                    const hdText = btn.querySelector('div.text-\\[10px\\]');
                    return hdText && normalizeText(hdText.textContent) === 'hd';
                });

                if (hdButton) {
                    console.log('✅ Upscale HD concluído! Botão HD encontrado.');
                    await sleep(500);

                    // Tentar encontrar o vídeo HD para baixar com o nome correto
                    const hdVideo = document.querySelector('video#hd-video') ||
                        Array.from(document.querySelectorAll('video')).find(v => v.src && v.src.includes('generated_video') && v.style.visibility !== 'hidden');

                    if (hdVideo && hdVideo.src) {
                        console.log('📥 Vídeo HD encontrado, baixando via extensão...');
                        return { success: true, url: hdVideo.src, method: 'extension' };
                    }

                    // Se não achar o vídeo, tenta o botão de download como fallback
                    const downloadBtn = findAllElements('button').find(btn => {
                        const label = normalizeText(btn.getAttribute('aria-label') || '');
                        return label.includes('baixar') || label.includes('download');
                    });

                    if (downloadBtn) {
                        console.log('📥 Vídeo HD não acessível diretamente. Clicando no botão de download (fallback)...');
                        forceClick(downloadBtn);
                        return { success: true, method: 'click' };
                    } else {
                        console.warn('⚠️ Botão de download não encontrado após upscale.');
                        return { success: false };
                    }
                }

                await sleep(1000);
            } catch (error) {
                console.error('Erro ao aguardar upscale:', error);
            }
        }

        console.warn('⚠️ Timeout aguardando upscale HD completar.');
        return { success: false };
    }

    async function upscaleVideo(videoElement) {
        const maxRetries = 30;
        let attempt = 0;

        // Find container
        let container = videoElement.closest('.relative.mx-auto');
        if (!container) {
            let parent = videoElement.parentElement;
            for (let i = 0; i < 8; i++) {
                if (parent && findMoreOptionsButton(parent)) {
                    container = parent;
                    break;
                }
                parent = parent ? parent.parentElement : null;
            }
        }

        while (attempt < maxRetries) {
            try {
                attempt++;

                // 1. Check if video generation is complete
                const generatingText = container ? container.querySelector('span.text-white') : null;
                const isGenerating = generatingText && normalizeText(generatingText.textContent).includes('gerando');

                if (isGenerating) {
                    console.log(`[${attempt}] 📊 Vídeo ainda gerando...`);
                    await sleep(1500);
                    continue;
                }

                if (!videoElement.src || !videoElement.src.includes('generated_video.mp4')) {
                    console.log(`[${attempt}] ⏳ Aguardando vídeo ter src válido...`);
                    await sleep(1000);
                    continue;
                }

                if (videoElement.readyState < 2) {
                    console.log(`[${attempt}] 🔄 Vídeo carregando...`);
                    await sleep(1000);
                    continue;
                }

                console.log(`[${attempt}] ✅ Vídeo pronto! Procurando botão de mais opções...`);

                // Force hover
                if (container) {
                    container.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
                    container.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
                }

                // 2. Find "More options" button
                let moreOptionsBtn = container ? findMoreOptionsButton(container) : null;

                // Fallback global search
                if (!moreOptionsBtn) {
                    const allBtns = findAllElements('button');
                    for (const btn of allBtns) {
                        const svg = btn.querySelector('svg.lucide-ellipsis');
                        if (svg && svg.querySelectorAll('circle').length === 3) {
                            moreOptionsBtn = btn;
                            break;
                        }
                    }
                }

                if (!moreOptionsBtn) {
                    console.log(`[${attempt}] ❌ Botão "Mais opções" não encontrado.`);
                    await sleep(1000);
                    continue;
                }

                console.log(`[${attempt}] ✅ Botão encontrado! Clicando...`);

                // 3. Open Menu
                const menuItems = await openMenuAndGetItems(moreOptionsBtn, 5);
                if (!menuItems.length) {
                    console.log(`[${attempt}] ⚠️ Menu não abriu.`);
                    await sleep(1000);
                    continue;
                }

                console.log(`📋 Menu aberto! Itens: ${menuItems.map(m => normalizeText(m.textContent)).join(' | ')}`);

                const upscaleItem = menuItems.find(item => {
                    const text = normalizeText(item.textContent);
                    return text.includes('upscale') || text.includes('ampliar');
                });

                if (upscaleItem) {
                    forceClick(upscaleItem);
                    console.log('🚀 Upscale solicitado com sucesso!');
                    await sleep(500);

                    // Wait for upscale and download
                    return await waitForUpscaleComplete(container);
                } else {
                    console.log(`[${attempt}] ⚠️ Opção "Upscale" não encontrada no menu.`);
                    forceClick(moreOptionsBtn); // Close menu
                    await sleep(1000);
                }

            } catch (error) {
                console.error(`[${attempt}] ❌ Erro no loop de upscale:`, error);
                await sleep(1000);
            }
        }
        return { success: false };
    }

    // --- Core Logic ---
    async function submitPrompt(prompt, aspectRatio) {
        try {
            const textarea = await waitForElement(SELECTORS.textarea);
            simulateTyping(textarea, prompt);
            await sleep(500);

            if (aspectRatio) {
                await selectAspectRatio(aspectRatio);
            }

            const submitButton = findElement(SELECTORS.submitButton);
            if (!submitButton || submitButton.disabled) {
                throw new Error('Botão de envio não encontrado ou desabilitado.');
            }
            submitButton.click();

        } catch (error) {
            console.error('Erro ao enviar prompt:', error);
            throw error;
        }
    }

    function handleAutomationComplete() {
        console.log('🏁 handleAutomationComplete chamado');
        const totalPrompts = automationState.prompts?.length || 0;
        sendMessageToBackground({
            action: 'automationComplete',
            totalPrompts: totalPrompts
        });
        updateOverlay({
            status: 'Concluído',
            prompt: 'Todos os prompts enviados',
            index: totalPrompts,
            total: totalPrompts
        });
        // Overlay permanece visível para o usuário ver o resultado
        resetAutomation();
        console.log('🏁 Automação finalizada e estado resetado');
    }

    function resetAutomation() {
        if (automationState.timeoutId) clearTimeout(automationState.timeoutId);
        automationState = {
            isRunning: false,
            prompts: [],
            currentIndex: 0,
            delay: 45,
            timeoutId: null,
            settings: {},
            mode: 'video',
            modeApplied: false,
            startTime: null,
            upscaledPrompts: new Set(),
            processingPrompts: new Set(),
            downloadedVideos: new Set()
        };
        clearAutomationState();
        clearOverlay();
        stopOverlayTimer();
        stopKeepAlive(); // Parar keep-alive
    }

    async function runAutomation() {
        if (!automationState.isRunning || !automationState.prompts || automationState.currentIndex >= automationState.prompts.length) {
            handleAutomationComplete();
            return;
        }

        // --- Reload/Redirect Logic ---
        const isPostPage = window.location.pathname.includes('/imagine/post/');

        // Se estiver no modo imagem (que exige chat limpo) OU se estivermos em uma página de post (onde botões de modelo costumam sumir)
        // E NÃO acabamos de ser restaurados por um reload
        if ((automationState.mode === 'image' || isPostPage) && !automationState.restoredFromReload) {
            // Se houver algo sendo processado (upscale, etc), aguarda um pouco mais em vez de redirecionar agora
            console.log(`🔍 [runAutomation] Verificando processingPrompts.size = ${automationState.processingPrompts.size}`);
            if (automationState.processingPrompts && automationState.processingPrompts.size > 0) {
                console.log('⏳ Aguardando conclusão de processamento (upscale) antes de mudar de página...');
                automationState.timeoutId = setTimeout(runAutomation, 3000);
                return;
            }

            console.log(`🔄 Redirecionando para /imagine para garantir UI correta (Modo: ${automationState.mode}, Post: ${isPostPage})...`);
            await saveAutomationState();
            window.location.href = 'https://grok.com/imagine';
            return;
        }
        automationState.restoredFromReload = false; // Reset flag

        automationState.imageDownloadInitiated = false; // Reset for the new prompt

        const currentPrompt = (automationState.prompts && automationState.prompts[automationState.currentIndex]) || '';
        let currentAspectRatio = null;

        // For video mode: always select mode before each prompt (Grok may reset it)
        // For image mode: only select once
        if (automationState.mode === 'video' || !automationState.modeApplied) {
            console.log(`🎯 Selecionando modo ${automationState.mode} antes do prompt...`);
            await selectGenerationMode(automationState.mode);
            automationState.modeApplied = true;

            // Selecionar duração do vídeo após selecionar o modo
            // Garantir que o menu esteja fechado antes de selecionar duração
            document.body.click();
            await sleep(500);

            if (automationState.mode === 'video' && automationState.settings?.videoDuration) {
                console.log(`⏱️ Selecionando duração ${automationState.settings.videoDuration}...`);
                const durationSuccess = await selectVideoDuration(automationState.settings.videoDuration);
                console.log(`📊 Resultado seleção duração: ${durationSuccess ? 'SUCESSO' : 'FALHA'}`);
                await sleep(800);
            }

            // Selecionar resolução
            if (automationState.mode === 'video') {
                const resolution = automationState.settings?.resolution || '480p';
                console.log(`⏱️ Selecionando resolução ${resolution}...`);
                await selectResolution(resolution);
                await sleep(500);
            }
        }

        if (automationState.settings?.randomize && automationState.settings?.aspectRatios && automationState.settings.aspectRatios.length > 0) {
            const possibleRatios = automationState.settings.aspectRatios;
            currentAspectRatio = possibleRatios[Math.floor(Math.random() * possibleRatios.length)];
            sendMessageToBackground({ action: 'updateStatus', message: `Sorteado: ${currentAspectRatio}` });
        } else if (!automationState.settings?.randomize && automationState.settings?.fixedRatio) {
            currentAspectRatio = automationState.settings.fixedRatio;
        }

        sendMessageToBackground({
            action: 'updateStatus',
            message: `Enviando: "${currentPrompt.substring(0, 30)}..."`,
            type: 'running',
            progress: `Prompt ${automationState.currentIndex + 1} de ${automationState.prompts.length}`
        });

        updateOverlay({
            status: automationState.mode === 'video' ? 'Gerando vídeo' : 'Gerando imagem',
            prompt: currentPrompt,
            index: automationState.currentIndex + 1,
            total: automationState.prompts.length
        });

        try {
            await sleep(500);

            // Registrar o índice do prompt que está sendo enviado
            automationState.lastPromptSentIndex = automationState.currentIndex;
            console.log(`📝 Registrando envio do prompt[${automationState.currentIndex}]: "${currentPrompt.substring(0, 40)}..."`);

            await submitPrompt(currentPrompt, currentAspectRatio);

            // Para modo vídeo, precisamos esperar a geração completar antes de avançar
            if (automationState.mode === 'video') {
                console.log('⏳ Modo vídeo: Aguardando geração do vídeo antes de avançar...');
                updateOverlay({
                    status: 'Gerando vídeo...',
                    prompt: currentPrompt,
                    index: automationState.currentIndex + 1,
                    total: automationState.prompts.length
                });

                // Aguardar geração do vídeo - AUMENTADO PARA 720p/HD
                const maxWaitTime = automationState.settings?.upscale ? 240000 : 180000; // 4 min upscale, 3 min normal
                const checkInterval = 1500;
                let elapsed = 0;
                let videoComplete = false;
                const currentPromptIndex = automationState.currentIndex;

                while (elapsed < maxWaitTime && !videoComplete) {
                    await sleep(checkInterval);
                    elapsed += checkInterval;

                    // Verificar se vídeo foi baixado
                    console.log(`⏳ [Espera vídeo] Verificando índice ${currentPromptIndex}, downloadedVideos size: ${automationState.downloadedVideos.size}, conteúdo: [${Array.from(automationState.downloadedVideos).join(', ')}]`);
                    if (automationState.downloadedVideos.has(currentPromptIndex)) {
                        console.log(`✅ Vídeo do prompt ${currentPromptIndex + 1} baixado!`);
                        videoComplete = true;
                        break;
                    }

                    // Timeouts removidos a pedido do usuário
                    // "ele so deve mudar se ele identificar que gerrou"
                    // Mantemos apenas o maxWaitTime global de segurança
                }

                if (!videoComplete) {
                    console.log('⏱️ Timeout máximo atingido, prosseguindo...');
                }
            }

            // Para modo imagem com 'Baixar Todas', aguardar mais tempo para todas as imagens serem geradas
            if (automationState.mode === 'image' && automationState.settings?.downloadAllImages) {
                const waitTime = Math.max(30, automationState.delay * 2) * 1000; // Mínimo 30s ou 2x o delay
                console.log(`⏳ Modo 'Baixar Todas': Aguardando ${waitTime / 1000}s para todas as imagens serem geradas...`);
                updateOverlay({
                    status: `Aguardando imagens (${waitTime / 1000}s)...`,
                    prompt: currentPrompt,
                    index: automationState.currentIndex + 1,
                    total: automationState.prompts.length
                });
                await sleep(waitTime);
            }

            automationState.currentIndex++;
            automationState.promptsSinceLastBreak++;
            automationState.imagesDownloadedCount = 0; // Reset contador de imagens baixadas
            saveAutomationState(); // Persist progress immediately

            if (automationState.isRunning && automationState.currentIndex < automationState.prompts.length) {
                // Check if it's time for a break
                if (automationState.settings?.breakEnabled &&
                    automationState.promptsSinceLastBreak >= (automationState.settings?.breakPrompts || 0)) {

                    const breakDurationMs = (automationState.settings?.breakDuration || 0) * 60 * 1000;
                    automationState.isOnBreak = true;
                    automationState.breakEndTime = Date.now() + breakDurationMs;

                    console.log(`☕ Iniciando pausa de ${automationState.settings?.breakDuration || 0} minutos após ${automationState.promptsSinceLastBreak} prompts...`);

                    updateOverlay({
                        status: '☕ Pausa programada',
                        prompt: `Descansando por ${automationState.settings?.breakDuration || 0} minutos...`,
                        index: automationState.currentIndex,
                        total: automationState.prompts.length
                    });

                    automationState.timeoutId = setTimeout(() => {
                        automationState.isOnBreak = false;
                        automationState.breakEndTime = null;
                        automationState.promptsSinceLastBreak = 0;
                        console.log('☕ Pausa concluída, retomando automação...');
                        runAutomation();
                    }, breakDurationMs);
                } else {
                    // Delay reduzido para modo vídeo (já esperamos a geração)
                    const nextDelay = automationState.mode === 'video' ? Math.max(3, automationState.delay * 0.5) : automationState.delay;
                    console.log(`⏱️ Aguardando ${nextDelay}s antes do próximo...`);
                    automationState.timeoutId = setTimeout(runAutomation, nextDelay * 1000);
                }
            } else if (automationState.isRunning) {
                sendMessageToBackground({
                    action: 'updateStatus',
                    message: 'Aguardando a última geração...',
                    type: 'running'
                });
            }

            // Se for o último prompt, aguardar download da imagem antes de finalizar
            if (automationState.isRunning && automationState.currentIndex >= automationState.prompts.length) {
                console.log('✅ Último prompt processado, aguardando download da imagem...');

                // Aguardar até que o download seja iniciado ou timeout
                let waitAttempts = 0;
                const maxWaitAttempts = 120; // 60 segundos (500ms * 120)

                const waitForDownload = setInterval(() => {
                    waitAttempts++;

                    // Verificar se o download foi iniciado
                    if (automationState.imageDownloadInitiated) {
                        clearInterval(waitForDownload);
                        console.log('✅ Download da última imagem iniciado, finalizando automação...');
                        // Aguardar mais 2 segundos para garantir que o download começou
                        setTimeout(() => {
                            handleAutomationComplete();
                        }, 2000);
                        return;
                    }

                    // Timeout após 60 segundos
                    if (waitAttempts >= maxWaitAttempts) {
                        clearInterval(waitForDownload);
                        console.log('⚠️ Timeout aguardando download da última imagem. Finalizando mesmo assim...');
                        handleAutomationComplete();
                        return;
                    }

                    // Log a cada 5 segundos
                    if (waitAttempts % 10 === 0) {
                        console.log(`⏳ Aguardando download da última imagem... ${(waitAttempts * 0.5).toFixed(0)}s`);
                    }
                }, 500);

                return;
            }
        } catch (error) {
            sendMessageToBackground({ action: 'automationError', error: error.message });
            updateOverlay({
                status: 'Erro',
                prompt: error.message,
                index: automationState.currentIndex,
                total: automationState.prompts.length
            });
            resetAutomation();
        }
    }

    // --- Image-to-Video Helpers (defined at module level for scope access) ---

    // Helper: Convert base64 data URL to File object
    function dataURLtoFile(dataUrl, filename) {
        // Remove data:image/jpeg;base64, prefix if present
        let base64 = dataUrl;
        if (base64.includes(',')) {
            base64 = base64.split(',')[1];
        }

        // Decode base64
        const byteString = atob(base64);
        const byteArray = new Array(byteString.length);
        for (let i = 0; i < byteString.length; i++) {
            byteArray[i] = byteString.charCodeAt(i);
        }

        const uint8Array = new Uint8Array(byteArray);
        const blob = new Blob([uint8Array], { type: 'image/jpeg' });
        return new File([blob], filename, { type: 'image/jpeg' });
    }

    // Helper: Find the contenteditable editor (ProseMirror/TipTap)
    function findEditor() {
        // Try multiple selectors for the Grok editor
        const selectors = [
            '.tiptap.ProseMirror[contenteditable="true"]',
            'div[contenteditable="true"].ProseMirror',
            'div[contenteditable="true"]',
            '.query-bar div[contenteditable="true"]'
        ];

        for (const selector of selectors) {
            const editor = document.querySelector(selector);
            if (editor) {
                console.log('✅ Editor encontrado:', selector);
                return editor;
            }
        }

        return null;
    }

    // Helper: Upload image to Grok via file input
    async function uploadImageToGrok(imageData, filename) {
        console.log('📤 Procurando input[type="file"] na página...');

        // Find file input - try multiple strategies
        let fileInput = document.querySelector('input[type="file"]');

        if (!fileInput) {
            // Try to find in the query-bar container
            const queryBar = document.querySelector('.query-bar') || document.querySelector('div[class*="query"]');
            if (queryBar) {
                fileInput = queryBar.querySelector('input[type="file"]');
            }
        }

        if (!fileInput) {
            // Try to find by looking for hidden inputs anywhere
            const allInputs = document.querySelectorAll('input[type="file"]');
            if (allInputs.length > 0) {
                fileInput = allInputs[0];
            }
        }

        // If still not found, we might need to click the attach button first to create it
        if (!fileInput) {
            console.log('⚠️ Input de arquivo não encontrado, tentando clicar no botão Anexar...');
            const attachBtn = document.querySelector('button[aria-label="Anexar"]') ||
                document.querySelector('button svg path[d*="M10 9V15"]')?.closest('button');

            if (attachBtn) {
                forceClick(attachBtn);
                await sleep(1000);

                // Try to find the menu item "Carregar um arquivo" and click it
                const menuItems = document.querySelectorAll('[role="menuitem"]');
                for (const item of menuItems) {
                    const svg = item.querySelector('svg');
                    if (svg) {
                        const paths = svg.querySelectorAll('path');
                        const pathData = Array.from(paths).map(p => p.getAttribute('d') || '').join(' ');
                        // Look for file icon (paths with M11 20H8 and M21 18 are file icons)
                        if (pathData.includes('M11 20') || pathData.includes('M20 8V11')) {
                            console.log('✅ Menu item de upload encontrado, clicando...');
                            forceClick(item);
                            await sleep(1500);
                            break;
                        }
                    }
                }

                // Now try to find the file input again
                fileInput = document.querySelector('input[type="file"]');
            }
        }

        if (!fileInput) {
            throw new Error('Input de arquivo não encontrado na página');
        }

        console.log('✅ Input de arquivo encontrado:', fileInput);

        // Convert base64 to File
        console.log('💾 Convertendo base64 para File...');
        const file = dataURLtoFile(imageData, filename);

        // Create DataTransfer and add file
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);

        // Set files on input
        fileInput.files = dataTransfer.files;

        // Dispatch change event to trigger upload
        console.log('🚀 Disparando evento change no input...');
        const changeEvent = new Event('change', { bubbles: true });
        fileInput.dispatchEvent(changeEvent);

        // Also dispatch input event for React compatibility
        const inputEvent = new Event('input', { bubbles: true });
        Object.defineProperty(inputEvent, 'target', { writable: false, value: fileInput });
        fileInput.dispatchEvent(inputEvent);

        return true;
    }

    // Helper: Select Video Duration
    async function selectVideoDuration(targetDuration) {
        const durationMap = {
            '5s': ['5', '5s', '5 seconds'],
            '6s': ['6', '6s', '6 seconds'],
            '10s': ['10', '10s', '10 seconds']
        };

        const possibleValues = durationMap[targetDuration] || [targetDuration];

        console.log(`🎯 Selecionando duração: ${targetDuration}`);

        // Abrir o menu de modelo clicando no trigger (mesmos seletores de selectGenerationMode)
        const trigger = document.getElementById('model-select-trigger') ||
            document.querySelector('button[aria-label="Seleção de modelo"]') ||
            document.querySelector('button[id*="model"]') ||
            document.querySelector('button:has(svg.lucide-play)');

        if (!trigger) {
            console.warn('⚠️ Trigger de modelo não encontrado');
            return false;
        }

        console.log('🔔 Abrindo menu de modelo...');
        console.log('🔍 Trigger encontrado:', trigger.outerHTML.substring(0, 200));
        forceClick(trigger);
        await sleep(1500); // Aguardar um pouco mais para o menu abrir completamente

        // A duração está no menu de modelo, dentro de um menuitem com botões
        // Estrutura: <div role="menuitem"><p>Duração do Vídeo</p><div><button>6s</button><button>10s</button></div></div>

        // Procurar o menuitem que contém "Duração"
        const menuItems = findAllElements('[role="menuitem"]');
        console.log(`🔍 ${menuItems.length} menuitems encontrados`);
        let durationMenuItem = null;

        for (const item of menuItems) {
            const itemText = normalizeText(item.textContent);
            if (/duracao|duration|duración/i.test(itemText)) {
                durationMenuItem = item;
                console.log('🎯 Menu item de duração encontrado:', itemText.substring(0, 50));
                break;
            }
        }

        if (!durationMenuItem) {
            console.warn('⚠️ Menu de duração não encontrado no menu aberto');
            // Fechar menu clicando fora
            document.body.click();
            return false;
        }

        // Procurar botões dentro do menuitem de duração
        const durationButtons = durationMenuItem.querySelectorAll('button');
        console.log(`🔍 ${durationButtons.length} botões de duração encontrados`);

        if (durationButtons.length === 0) {
            console.warn('⚠️ Nenhum botão de duração encontrado no menuitem');
            document.body.click();
            return false;
        }

        for (const btn of durationButtons) {
            const btnText = normalizeText(btn.textContent);
            const ariaLabel = btn.getAttribute('aria-label') || '';
            console.log(`  - Botão: "${btnText}" (aria-label: "${ariaLabel}")`);

            // Verificar se o botão corresponde à duração desejada
            const isMatch = possibleValues.some(val =>
                btnText === val.toLowerCase() ||
                ariaLabel === val ||
                btnText.includes(val.toLowerCase())
            );

            if (isMatch) {
                console.log(`✅ Duração ${targetDuration} encontrada, clicando...`);
                console.log('🔍 Botão HTML:', btn.outerHTML.substring(0, 150));
                forceClick(btn);
                await sleep(1000); // Aguardar mais para a seleção ser aplicada

                // Verificar se a duração foi selecionada (botão deve ter classe ativa)
                const isSelected = btn.classList.contains('text-primary') ||
                    btn.classList.contains('font-semibold') ||
                    btn.getAttribute('aria-pressed') === 'true';

                console.log(`📊 Botão selecionado: ${isSelected}`);

                // Fechar menu clicando fora
                document.body.click();
                await sleep(300);

                return true;
            }
        }

        console.warn(`⚠️ Duração ${targetDuration} não encontrada entre os botões`);
        console.log('🔍 Botões disponíveis:', Array.from(durationButtons).map(b => ({
            text: normalizeText(b.textContent),
            ariaLabel: b.getAttribute('aria-label'),
            classes: b.className
        })));

        // Fechar menu clicando fora
        document.body.click();
        await sleep(300);
        return false;
    }

    // Helper: Select Resolution
    async function selectResolution(targetResolution) {
        const target = targetResolution || '480p'; // default 480p
        console.log(`🎯 Selecionando resolução: ${target}`);

        // Find resolution buttons
        // They are usually visible directly on the UI or inside a menu? 
        // User provided: <div class="flex flex-row gap-0"><button ... aria-label="480p">480p</button><button ... aria-label="720p">720p</button></div>
        // Assuming they are visible BEFORE prompt submission

        // Strategy 1: Find by aria-label directly
        let btn = document.querySelector(`button[aria-label="${target}"]`);

        // Strategy 2: Find by text content
        if (!btn) {
            const buttons = findAllElements('button');
            btn = buttons.find(b => normalizeText(b.textContent) === target);
        }

        // Strategy 3: Maybe inside a menu? (Similar to selectVideoDuration)
        // User said: "vcs escolhe o 480p ou 720p antes de enciar o prompt.. essa escolha da resolucao pode ser apos de escolher a propocao do video"
        // It might be in the same "model-select-trigger" menu OR standalone.
        // User provided HTML suggests they are standalone buttons in a flex container.

        if (btn) {
            console.log(`✅ Botão de resolução ${target} encontrado! Clicando...`);
            forceClick(btn);
            await sleep(500);
            return true;
        }

        console.warn(`⚠️ Botão de resolução ${target} não encontrado na interface principal.`);

        // Fallback: Check inside model menu (just in case)
        const trigger = document.getElementById('model-select-trigger') ||
            document.querySelector('button[aria-label="Seleção de modelo"]') ||
            document.querySelector('button[id*="model"]') ||
            document.querySelector('button:has(svg.lucide-play)');

        if (trigger) {
            console.log('🔍 Verificando menu de modelo para resolução...');
            forceClick(trigger);
            await sleep(1000);

            const menuItems = findAllElements('[role="menuitem"] button');
            btn = Array.from(menuItems).find(b =>
                normalizeText(b.textContent) === target ||
                b.getAttribute('aria-label') === target
            );

            if (btn) {
                console.log(`✅ Botão de resolução ${target} encontrado no menu! Clicando...`);
                forceClick(btn);
                await sleep(500);
                document.body.click(); // Close menu
                return true;
            }

            document.body.click(); // Close menu
        }

        return false;
    }

    async function runImageToVideoAutomation() {
        if (!automationState.isRunning || !automationState.imageQueue || automationState.currentImageIndex >= automationState.imageQueue.length) {
            handleAutomationComplete();
            return;
        }

        // Check if we're on a post page - redirect to /imagine if so
        const isPostPage = window.location.pathname.includes('/imagine/post/');
        const hasTrigger = document.getElementById('model-select-trigger');

        if (isPostPage || !hasTrigger) {
            console.log(`🔄 Redirecionando para /imagine... (isPostPage=${isPostPage}, hasTrigger=${!!hasTrigger})`);
            await saveAutomationState();
            window.location.href = 'https://grok.com/imagine';
            return;
        }

        // Sync global index for observers
        automationState.currentIndex = automationState.currentImageIndex;

        const currentImage = automationState.imageQueue[automationState.currentImageIndex];
        console.log(`📸 Processando imagem ${automationState.currentImageIndex + 1}/${automationState.imageQueue.length}: ${currentImage.name}`);

        updateOverlay({
            status: 'Preparando upload...',
            prompt: `Imagem: ${currentImage.name}`,
            index: automationState.currentImageIndex + 1,
            total: automationState.imageQueue.length
        });

        try {
            // Get image data from storage
            const storedImage = await chrome.storage.local.get(currentImage.id);
            if (!storedImage || !storedImage[currentImage.id]) {
                throw new Error(`Imagem ${currentImage.id} não encontrada no storage`);
            }

            const imgData = storedImage[currentImage.id];

            // ========== STEP 0: Insert Prompt Text (if provided) - BEFORE upload ==========
            const imagePrompt = automationState.settings?.imagePrompt;
            
            // Wait for UI to be ready - look for the contenteditable editor
            let editor = findEditor();
            let attempts = 0;
            while (!editor && attempts < 10) {
                console.log(`⏳ Aguardando editor... tentativa ${attempts + 1}/10`);
                await sleep(800);
                editor = findEditor();
                attempts++;
            }

            if (!editor) {
                throw new Error('Editor não encontrado na página após 10 tentativas');
            }

            // Insert prompt text BEFORE uploading image
            if (imagePrompt && imagePrompt.trim()) {
                console.log(`📝 Step 0: Inserindo prompt no editor antes do upload...`);
                updateOverlay({
                    status: 'Inserindo prompt...',
                    prompt: imagePrompt,
                    index: automationState.currentImageIndex + 1,
                    total: automationState.imageQueue.length
                });

                simulateTyping(editor, imagePrompt);
                console.log('✅ Prompt inserido no editor');
                await sleep(800);
            } else {
                console.log('ℹ️ Nenhum prompt para inserir (campo vazio)');
            }

            // ========== STEP 1: Upload Image via File Input ==========
            console.log('📤 Step 1: Fazendo upload da imagem...');
            console.log(`📊 Progresso: ${automationState.currentImageIndex + 1}/${automationState.imageQueue.length} - ${currentImage.name}`);

            console.log('✅ Editor pronto, aguardando 1.5s antes do upload...');
            await sleep(1500);

            // Upload image using file input method (like autogrok does)
            try {
                await uploadImageToGrok(imgData.data, currentImage.name);
                console.log('✅ Upload iniciado no input file');
            } catch (uploadError) {
                console.error('❌ Erro no upload:', uploadError);
                throw uploadError;
            }

            // Wait for image to be processed and thumbnail to appear
            updateOverlay({
                status: 'Aguardando processamento...',
                prompt: `Imagem: ${currentImage.name}`,
                index: automationState.currentImageIndex + 1,
                total: automationState.imageQueue.length
            });

            // Aguardar processamento da imagem (preview/thumbnail) - REDUZIDO
            console.log('⏳ Aguardando 5s para processamento da imagem...');
            await sleep(5000);

            // Verificar se imagem apareceu (opcional - debug)
            const hasImagePreview = document.querySelector('img[src^="blob:"]') ||
                document.querySelector('[data-testid="drop-ui"]') ||
                document.querySelector('.query-bar img');
            console.log(hasImagePreview ? '✅ Preview de imagem detectado' : '⚠️ Preview de imagem não detectado, mas continuando...');

            // ========== STEP 2: Select Video Mode ==========
            console.log('🎬 Step 2: Selecionando modo Vídeo...');
            updateOverlay({
                status: 'Selecionando modo vídeo...',
                prompt: `Imagem: ${currentImage.name}`,
                index: automationState.currentImageIndex + 1,
                total: automationState.imageQueue.length
            });

            const modeSelected = await selectGenerationMode('video');
            if (!modeSelected) {
                console.warn('⚠️ Não conseguiu selecionar modo vídeo, tentando continuar...');
            }
            await sleep(1000);

            // ========== STEP 3: Select Video Duration ==========
            if (automationState.settings?.videoDuration) {
                console.log(`⏱️ Step 3: Selecionando duração ${automationState.settings.videoDuration}...`);
                updateOverlay({
                    status: `Configurando duração ${automationState.settings.videoDuration}...`,
                    prompt: `Imagem: ${currentImage.name}`,
                    index: automationState.currentImageIndex + 1,
                    total: automationState.imageQueue.length
                });

                // Garantir que o menu esteja fechado antes de selecionar duração
                document.body.click();
                await sleep(500);

                const durationSuccess = await selectVideoDuration(automationState.settings.videoDuration);
                console.log(`📊 Resultado seleção duração (image-to-video): ${durationSuccess ? 'SUCESSO' : 'FALHA'}`);
                await sleep(1000);
            }

            // ========== STEP 3.5: Select Resolution ==========
            const resolution = automationState.settings?.resolution || '480p';
            console.log(`⏱️ Step 3.5: Selecionando resolução ${resolution}...`);
            updateOverlay({
                status: `Configurando resolução ${resolution}...`,
                prompt: `Imagem: ${currentImage.name}`,
                index: automationState.currentImageIndex + 1,
                total: automationState.imageQueue.length
            });
            await selectResolution(resolution);
            await sleep(800);

            // ========== STEP 4: Submit ==========
            console.log('🚀 Step 4: Enviando...');
            updateOverlay({
                status: 'Enviando para geração...',
                prompt: `Imagem: ${currentImage.name}`,
                index: automationState.currentImageIndex + 1,
                total: automationState.imageQueue.length
            });

            // Try multiple submit button selectors
            const submitSelectors = [
                'button[type="submit"]',
                'button[aria-label="Enviar"]',
                'button:has(svg.lucide-arrow-right)',
                'button:has(svg.stroke-\\[2\\])',
                'button[data-slot="button"]:has(svg)'
            ];

            let submitClicked = false;
            for (const selector of submitSelectors) {
                const submitBtn = document.querySelector(selector);
                if (submitBtn && !submitBtn.disabled) {
                    console.log(`✅ Botão Enviar encontrado (${selector}), clicando...`);
                    forceClick(submitBtn);
                    submitClicked = true;
                    break;
                }
            }

            if (!submitClicked) {
                // Fallback: try Enter key on editor
                const editor = findEditor();
                if (editor) {
                    console.log('⌨️ Tentando enviar com Enter no editor...');
                    editor.focus();
                    editor.dispatchEvent(new KeyboardEvent('keydown', {
                        bubbles: true, cancelable: true, key: 'Enter', code: 'Enter'
                    }));
                }
            }

            // ========== STEP 5: Wait for Generation (with early completion detection) ==========
            console.log('⏳ Step 5: Aguardando geração do vídeo...');
            updateOverlay({
                status: 'Gerando vídeo...',
                prompt: `Imagem: ${currentImage.name}`,
                index: automationState.currentImageIndex + 1,
                total: automationState.imageQueue.length
            });

            // Wait for video generation - MutationObserver will handle upscale and download
            // AUMENTADO PARA 720p/HD
            const maxWaitTime = automationState.settings?.upscale ? 240000 : 180000;
            const checkInterval = 1500; // Check every 1.5 seconds
            let elapsed = 0;
            let processingComplete = false;
            let lastDownloadCheck = false;

            while (elapsed < maxWaitTime && !processingComplete) {
                await sleep(checkInterval);
                elapsed += checkInterval;

                // Check if video was downloaded (means processing is done)
                const isDownloaded = automationState.downloadedVideos.has(automationState.currentImageIndex);
                const isUpscaled = automationState.upscaledPrompts.has(automationState.currentImageIndex);

                if (isDownloaded && !lastDownloadCheck) {
                    console.log(`✅ Download detectado após ${elapsed / 1000}s`);
                    lastDownloadCheck = true;

                    // If upscale not enabled, we can proceed immediately after download
                    if (!automationState.settings?.upscale) {
                        console.log('✅ Sem upscale, prosseguindo imediatamente...');
                        processingComplete = true;
                        break;
                    }
                }

                // If upscale enabled, check both conditions
                if (automationState.settings?.upscale && isDownloaded && isUpscaled) {
                    console.log(`✅ Upscale + download completos em ${elapsed / 1000}s!`);
                    processingComplete = true;
                    break;
                }

                // Timeouts removidos a pedido do usuário
                // Mantemos apenas o maxWaitTime global de segurança
            }

            if (!processingComplete) {
                console.log(`⏱️ Timeout máximo (${maxWaitTime / 1000}s), prosseguindo...`);
            }

            // ========== STEP 6: Next Image ==========
            console.log('⏭️ Avançando para próxima imagem...');
            automationState.currentImageIndex++;
            await saveAutomationState();

            // Short pause before reload - delay reduzido para modo image-to-video
            const reloadDelay = Math.max(3, Math.min(automationState.delay, 10)); // Max 10s, min 3s
            console.log(`⏱️ Aguardando ${reloadDelay}s antes do reload...`);
            updateOverlay({
                status: 'Preparando próxima...',
                prompt: `Delay: ${reloadDelay}s...`,
                index: automationState.currentImageIndex,
                total: automationState.imageQueue.length
            });

            await sleep(reloadDelay * 1000);

            console.log('🔄 Recarregando página para próxima imagem...');
            window.location.href = 'https://grok.com/imagine';
            return;

        } catch (error) {
            console.error('❌ Erro:', error);
            automationState.currentImageIndex++;
            await saveAutomationState();

            console.log('🔄 Reload de emergência em 5s...');
            setTimeout(() => {
                window.location.href = 'https://grok.com/imagine';
            }, 5000);
        }
    }

    // --- Listeners ---
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'ping') {
            sendResponse({ status: 'ready' });
            return true;
        }

        if (request.action === 'startAutomation') {
            console.log('📨 Mensagem startAutomation recebida:', request);

            if (automationState.isRunning) {
                sendResponse({ status: 'already_running' });
                return true;
            }

            // Extract config from request
            const config = request.config || request;

            console.log('⚙️ Config extraído:', config);

            // Validate prompts
            if (!config.prompts || config.prompts.length === 0) {
                console.error('❌ Nenhum prompt fornecido!');
                sendResponse({ status: 'error', message: 'Nenhum prompt fornecido' });
                return true;
            }

            automationState.isRunning = true;
            automationState.prompts = config.prompts || [];
            automationState.delay = config.delay || 45;
            automationState.settings = {
                randomize: config.randomizeAspectRatio || false,
                aspectRatios: config.aspectRatios || [],
                fixedRatio: config.aspectRatio || '3:2',
                upscale: config.autoUpscale || false,
                autoDownload: config.autoDownload || false,
                downloadAllImages: config.downloadAllImages || false,
                downloadMultiCount: config.downloadMultiCount || 4,
                breakEnabled: config.breakEnabled || false,
                breakPrompts: config.breakPrompts || 90,
                breakDuration: Math.floor(Math.random() * ((config.breakDurationMax || 3) - (config.breakDurationMin || 3) + 1)) + (config.breakDurationMin || 3),
                videoDuration: config.videoDuration || null,
                resolution: config.resolution || '480p'
            };

            // Force disable upscale if resolution is 720p
            if (automationState.settings.resolution === '720p') {
                automationState.settings.upscale = false;
                console.log('ℹ️ Resolução 720p selecionada: Upscale desabilitado automaticamente.');
            }
            automationState.mode = config.mode || 'image';
            automationState.modeApplied = false;
            automationState.currentIndex = 0;
            automationState.startTime = Date.now();
            automationState.upscaledPrompts = new Set();
            automationState.processingPrompts = new Set();
            automationState.downloadedVideos = new Set();
            automationState.processedVideoUrls = new Set();
            automationState.promptsSinceLastBreak = 0;
            automationState.isOnBreak = false;
            automationState.breakEndTime = null;

            console.log('🚀 Automação iniciada!', {
                prompts: automationState.prompts.length,
                promptsList: automationState.prompts,
                mode: automationState.mode,
                delay: automationState.delay,
                settings: automationState.settings
            });

            startOverlayTimer();
            startKeepAlive(); // Iniciar keep-alive para Service Worker
            runAutomation();
            sendResponse({ status: 'started' });
            return true;
        }

        if (request.action === 'startImageToVideo') {
            console.log('📨 Mensagem startImageToVideo recebida:', request);

            if (automationState.isRunning) {
                sendResponse({ status: 'already_running' });
                return true;
            }

            const config = request.config || request;

            console.log('⚙️ Config Image-to-Video extraído:', config);

            // Load image queue from storage
            chrome.storage.local.get(['automationQueue'], async (result) => {
                const queue = result.automationQueue || [];

                if (queue.length === 0) {
                    console.error('❌ Fila de imagens vazia!');
                    sendResponse({ status: 'error', message: 'Nenhuma imagem na fila' });
                    return;
                }

                console.log(`📸 ${queue.length} imagens na fila para processar`);

                automationState.isRunning = true;
                automationState.imageQueue = queue;
                automationState.currentImageIndex = 0;
                automationState.delay = config.delay || 45;
                automationState.settings = {
                    randomize: config.randomizeAspectRatio || false,
                    aspectRatios: config.aspectRatios || [],
                    fixedRatio: config.aspectRatio || '3:2',
                    upscale: config.autoUpscale || false,
                    autoDownload: config.autoDownload || false,
                    breakEnabled: config.breakEnabled || false,
                    breakPrompts: config.breakPrompts || 90,
                    breakDuration: Math.floor(Math.random() * ((config.breakDurationMax || 3) - (config.breakDurationMin || 3) + 1)) + (config.breakDurationMin || 3),
                    videoDuration: config.videoDuration || '6s',
                    resolution: config.resolution || '480p',
                    imagePrompt: config.imagePrompt || '' // Prompt para enviar com as imagens
                };

                // Force disable upscale if resolution is 720p
                if (automationState.settings.resolution === '720p') {
                    automationState.settings.upscale = false;
                    console.log('ℹ️ Resolução 720p selecionada: Upscale desabilitado automaticamente.');
                }
                automationState.mode = 'image-to-video';
                automationState.modeApplied = false;
                automationState.currentIndex = 0;
                automationState.startTime = Date.now();
                automationState.processedVideoUrls = new Set();
                automationState.promptsSinceLastBreak = 0;
                automationState.isOnBreak = false;
                automationState.breakEndTime = null;

                console.log('🚀 Automação Image-to-Video iniciada!', {
                    imageCount: queue.length,
                    mode: automationState.mode,
                    delay: automationState.delay,
                    settings: automationState.settings
                });

                startOverlayTimer();
                startKeepAlive(); // Iniciar keep-alive para Service Worker
                runImageToVideoAutomation();
            });

            sendResponse({ status: 'started' });
            return true;
        }

        if (request.action === 'stopAutomation') {
            resetAutomation();
            sendMessageToBackground({ action: 'updateStatus', message: 'Automação interrompida', type: 'stopped' });
            sendResponse({ status: 'stopped' });
            return true;
        }

        if (request.action === 'resetQueue') {
            resetAutomation();
            sendMessageToBackground({ action: 'updateStatus', message: 'Fila zerada e automação parada', type: 'stopped' });
            sendResponse({ status: 'reset' });
            return true;
        }

        if (request.action === 'clearState') {
            console.log('🧹 Limpando estado de automação manualmente...');
            resetAutomation();
            clearAutomationState();
            sendResponse({ status: 'cleared' });
            return true;
        }

        return false;
    });



    function clickVideoDownloadButton() {
        const buttons = findAllElements('button[aria-label], button');
        const target = buttons.find(btn => {
            const label = normalizeText(btn.getAttribute('aria-label') || '');
            return label.includes('baixar');
        });
        if (target) {
            forceClick(target);
            return true;
        }
        return false;
    }

    function processVideoElement(video, promptIndex = null) {
        // Use correct index based on mode
        // Para text-to-video: usar processedVideoUrls.size - 1 porque downloadedVideos é populado async
        let currentPromptIndex;
        if (promptIndex !== null) {
            currentPromptIndex = promptIndex;
        } else if (automationState.mode === 'image-to-video') {
            currentPromptIndex = automationState.currentImageIndex;
        } else {
            currentPromptIndex = Math.max(0, automationState.processedVideoUrls.size - 1);
        }
        const shouldUpscale = automationState.settings?.upscale;

        console.log(`🎬 [processVideoElement] Processando vídeo - índice: ${currentPromptIndex}, modo: ${automationState.mode}, currentIndex: ${automationState.currentIndex}`);

        // Prevent duplicate processing
        if (automationState.processingPrompts.has(currentPromptIndex)) {
            console.log(`🔒 Índice ${currentPromptIndex} já está sendo processado. Ignorando.`);
            return;
        }

        const process = async () => {
            if (shouldUpscale) {
                if (automationState.upscaledPrompts.has(currentPromptIndex)) {
                    console.log(`✅ Prompt ${currentPromptIndex} já foi upscalado. Ignorando.`);
                    return;
                }

                console.log(`🎬 Iniciando upscale para prompt ${currentPromptIndex}...`);
                automationState.processingPrompts.add(currentPromptIndex); // Lock

                const result = await upscaleVideo(video);

                if (result.success) {
                    console.log(`✅ Upscale concluído para prompt ${currentPromptIndex}!`);
                    automationState.upscaledPrompts.add(currentPromptIndex);

                    if (result.method === 'extension' && result.url) {
                        await triggerDownload(result.url, 'video', currentPromptIndex);
                    } else if (result.method === 'click') {
                        const clicked = clickVideoDownloadButton();
                        if (!clicked) {
                            console.warn('⚠ Botão de download não encontrado após upscale, tentando src do vídeo.');
                            await triggerDownload(video.src, 'video', currentPromptIndex);
                        }
                    }

                    // Se for o último, finalizar
                    if (automationState.currentIndex >= automationState.prompts.length) {
                        handleAutomationComplete();
                    }
                } else {
                    console.warn(`⚠️ Upscale falhou para prompt ${currentPromptIndex}. Baixando vídeo SD.`);
                    await triggerDownload(video.src, 'video', currentPromptIndex);

                    // Se for o último, finalizar mesmo com falha no upscale
                    if (automationState.currentIndex >= automationState.prompts.length) {
                        handleAutomationComplete();
                    }
                }

                automationState.processingPrompts.delete(currentPromptIndex); // Unlock
            } else {
                console.log('📥 Fazendo download do vídeo SD (upscale desabilitado)');
                await triggerDownload(video.src, 'video', currentPromptIndex);

                // Se for o último, finalizar
                if (automationState.currentIndex >= automationState.prompts.length) {
                    handleAutomationComplete();
                }
            }
        };
        process();
    }

    // --- Helper to handle "Which video do you prefer?" popup ---
    function handlePreferencePopup() {
        // Look for the "Ignore" button in the specific popup structure
        // Context: h3 "Qual vídeo..." -> p -> button "Ignorar"
        const buttons = Array.from(document.querySelectorAll('button'));
        const ignoreButton = buttons.find(btn => {
            const text = normalizeText(btn.textContent);
            // Check for variations of Ignore/Skip in multiple languages
            const isIgnore = /ignorar|ignore|pular|skip|saltar/i.test(text);

            // Optional: Check context to be sure (sibling h3 or p)
            if (isIgnore) {
                const parent = btn.closest('div');
                if (parent) {
                    const hasQuestion = parent.querySelector('h3') || parent.textContent.includes('prefere') || parent.textContent.includes('prefer');
                    return hasQuestion;
                }
            }
            return false;
        });

        if (ignoreButton) {
            console.log('🛑 Popup "Qual vídeo você prefere" detectado. Clicando em Ignorar...');
            forceClick(ignoreButton);
            return true;
        }
        return false;
    }

    // Flag para evitar downloads duplicados simultâneos
    let isDownloadingAllImages = false;

    // Função para baixar todas as imagens válidas de uma vez
    async function downloadAllImagesFromItems() {
        if (!automationState.isRunning || !automationState.settings?.downloadAllImages) return;
        if (isDownloadingAllImages) {
            console.log('⏳ Download de todas as imagens já em andamento, ignorando...');
            return;
        }

        isDownloadingAllImages = true;

        try {
            // Obter o índice do prompt atual
            // Usar lastPromptSentIndex se disponível, senão calcular baseado em currentIndex
            const currentPromptIdx = automationState.lastPromptSentIndex >= 0
                ? automationState.lastPromptSentIndex
                : Math.max(0, automationState.currentIndex - 1);
            const currentPrompt = automationState.prompts[currentPromptIdx];

            if (!currentPrompt) {
                console.log('⚠️ Prompt atual não encontrado, cancelando download...');
                isDownloadingAllImages = false;
                return;
            }

            const allItems = Array.from(document.querySelectorAll('div[role="listitem"]:not([data-gpa-all-images-processed="true"])'));
            if (allItems.length === 0) {
                isDownloadingAllImages = false;
                return;
            }

            console.log(`🖼️ Modo 'Baixar Todas': Prompt[${currentPromptIdx}] "${currentPrompt.substring(0, 30)}..." - Verificando ${allItems.length} itens...`);

            // Função para verificar se a imagem é válida
            function checkImageValid(item) {
                const image = item.querySelector('img[src^="data:image/"]');
                if (!image || !image.src) return null;

                const src = image.src;
                const isPng = src.startsWith('data:image/png');
                const isJpeg = src.startsWith('data:image/jpeg') || src.startsWith('data:image/jpg');
                const isWebp = src.startsWith('data:image/webp');

                const base64Length = src.split(',')[1]?.length || 0;
                const approxSizeBytes = base64Length * 0.75;
                const approxSizeKB = approxSizeBytes / 1024;

                return {
                    valid: (isJpeg || isWebp) && approxSizeKB >= 100,
                    isPlaceholder: isPng,
                    isJpeg,
                    isWebp,
                    sizeKB: approxSizeKB,
                    src: src,
                    item: item
                };
            }

            // Verificar se já atingimos o limite de downloads para este prompt
            const maxImagesPerPrompt = automationState.settings?.downloadMultiCount || 4;
            const alreadyDownloaded = automationState.imagesDownloadedCount || 0;
            if (alreadyDownloaded >= maxImagesPerPrompt) {
                console.log(`✅ Limite de ${maxImagesPerPrompt} imagens já atingido para este prompt.`);
                isDownloadingAllImages = false;
                return;
            }

            console.log(`📊 Limite de imagens configurado: ${maxImagesPerPrompt}, já baixadas: ${alreadyDownloaded}`);

            // Baixar apenas as imagens do prompt atual
            let downloadedCount = alreadyDownloaded;

            // Processar itens na ordem do DOM
            for (let i = 0; i < allItems.length && downloadedCount < maxImagesPerPrompt; i++) {
                const item = allItems[i];
                const check = checkImageValid(item);

                if (!check) continue;

                if (check.valid) {
                    const imageNumber = downloadedCount + 1;
                    const promptName = currentPrompt;

                    console.log(`⬇️ Baixando imagem ${imageNumber}: ${check.sizeKB.toFixed(1)}KB | Prompt[${currentPromptIdx}]: "${promptName.substring(0, 30)}..." [${imageNumber}/${maxImagesPerPrompt}]`);
                    item.dataset.gpaAllImagesProcessed = 'true';
                    automationState.imagesDownloadedCount = downloadedCount + 1;

                    // Usar triggerDownload com sufixo para múltiplas imagens do mesmo prompt
                    // Temporariamente modificar o prompt para incluir número da imagem
                    const originalPrompt = automationState.prompts[currentPromptIdx];
                    automationState.prompts[currentPromptIdx] = `${originalPrompt}_${imageNumber}`;
                    await triggerDownload(check.src, 'image', currentPromptIdx);
                    // Restaurar prompt original
                    automationState.prompts[currentPromptIdx] = originalPrompt;

                    downloadedCount++;

                    // Pequeno delay entre downloads para não sobrecarregar
                    await sleep(300);
                } else if (check.isPlaceholder) {
                    console.log(`⏳ Item ${i}: Placeholder PNG (${check.sizeKB.toFixed(1)}KB), aguardando...`);
                } else {
                    console.log(`⏳ Item ${i}: Imagem muito pequena (${check.sizeKB.toFixed(1)}KB), aguardando...`);
                }
            }

            if (downloadedCount > 0) {
                console.log(`✅ ${downloadedCount} imagens baixadas no modo 'Todas' do prompt[${currentPromptIdx}]`);
            }
            if (downloadedCount >= maxImagesPerPrompt) {
                console.log(`✅ Todas as ${maxImagesPerPrompt} imagens do prompt atual baixadas.`);
            }
            // Marcar que o download foi iniciado para este prompt
            automationState.imageDownloadInitiated = true;
        } finally {
            isDownloadingAllImages = false;
        }
    }

    function handleImageGeneration(mutations) {
        if (!automationState.isRunning) return;

        // Check for preference popup on every mutation
        handlePreferencePopup();

        const hasRelevantChanges = mutations.some(m => m.addedNodes.length > 0 || (m.attributeName === 'src'));
        if (!hasRelevantChanges) return;

        // --- Modo Baixar Todas as Imagens ---
        if (automationState.mode === 'image' && automationState.settings?.downloadAllImages && automationState.settings?.autoDownload) {
            // Chamar download de todas as imagens
            downloadAllImagesFromItems();
            return; // Não executar o modo de imagem única
        }

        // --- New Image Logic (Image Mode - Apenas última imagem) ---
        if (automationState.mode === 'image' && automationState.settings?.autoDownload && !automationState.imageDownloadInitiated) {
            const unprocessedItems = Array.from(document.querySelectorAll('div[role="listitem"]:not([data-gpa-image-processed="true"])'));

            if (unprocessedItems.length > 0) {
                // Sort by vertical position to find the newest item (closest to the top)
                unprocessedItems.sort((a, b) => {
                    const topA = parseFloat(a.style.top) || Infinity;
                    const topB = parseFloat(b.style.top) || Infinity;
                    return topA - topB;
                });
                const topMostItem = unprocessedItems[0];

                if (topMostItem) {
                    // Calculate download delay: delay - 8 seconds, minimum 5 seconds
                    const downloadDelay = Math.max(5, automationState.delay - 8) * 1000;
                    // No modo imagem, quando o download é acionado, o currentIndex já foi incrementado
                    // Então usamos currentIndex - 1 para pegar o prompt correto
                    const capturedImageIndex = Math.max(0, automationState.currentIndex - 1);
                    console.log(`⏱️ Aguardando ${downloadDelay / 1000}s antes de iniciar verificação da imagem (índice: ${capturedImageIndex})...`);

                    setTimeout(() => {
                        if (!automationState.isRunning) return;
                        if (automationState.imageDownloadInitiated) return;

                        // Função para verificar se a imagem é válida
                        function checkImageValid() {
                            const playIcon = topMostItem.querySelector('svg.lucide-play');
                            const image = topMostItem.querySelector('img[src^="data:image/"]');

                            if (!playIcon || !image || !image.src) {
                                return { valid: false, reason: 'no-image' };
                            }

                            const src = image.src;
                            const isPng = src.startsWith('data:image/png');
                            const isJpeg = src.startsWith('data:image/jpeg') || src.startsWith('data:image/jpg');
                            const isWebp = src.startsWith('data:image/webp');

                            // Calcular tamanho aproximado do base64
                            const base64Length = src.split(',')[1]?.length || 0;
                            const approxSizeBytes = base64Length * 0.75;
                            const approxSizeKB = approxSizeBytes / 1024;

                            // Qualquer PNG é considerado placeholder no Grok
                            // JPEG/WEBP maior que 100KB é considerado imagem final
                            return {
                                valid: (isJpeg || isWebp) && approxSizeKB >= 100,
                                isPlaceholder: isPng,
                                isJpeg,
                                isWebp,
                                sizeKB: approxSizeKB,
                                src: src
                            };
                        }

                        // Verificação inicial
                        const initialCheck = checkImageValid();
                        if (initialCheck.valid) {
                            // Imagem já está pronta
                            automationState.imageDownloadInitiated = true;
                            console.log(`✅ Imagem final detectada imediatamente (${initialCheck.sizeKB.toFixed(1)}KB). Baixando índice ${capturedImageIndex}...`);
                            topMostItem.dataset.gpaImageProcessed = 'true';
                            triggerDownload(initialCheck.src, 'image', capturedImageIndex);
                            return;
                        }

                        // Se for placeholder, iniciar polling
                        if (initialCheck.isPlaceholder) {
                            console.log(`⏳ Placeholder detectado (${initialCheck.sizeKB.toFixed(1)}KB). Iniciando polling até imagem final estar pronta (índice: ${capturedImageIndex})...`);

                            let attempts = 0;
                            const maxAttempts = 60; // 30 segundos (500ms * 60)

                            const pollInterval = setInterval(() => {
                                attempts++;

                                if (!automationState.isRunning || automationState.imageDownloadInitiated) {
                                    clearInterval(pollInterval);
                                    return;
                                }

                                const check = checkImageValid();

                                if (check.valid) {
                                    clearInterval(pollInterval);
                                    automationState.imageDownloadInitiated = true;
                                    console.log(`✅ Imagem final detectada após ${attempts} tentativas (${check.sizeKB.toFixed(1)}KB). Baixando índice ${capturedImageIndex}...`);
                                    topMostItem.dataset.gpaImageProcessed = 'true';
                                    triggerDownload(check.src, 'image', capturedImageIndex);
                                    return;
                                }

                                if (attempts >= maxAttempts) {
                                    clearInterval(pollInterval);
                                    console.log(`⚠️ Timeout após ${maxAttempts} tentativas. Baixando imagem atual mesmo assim...`);
                                    const lastCheck = checkImageValid();
                                    if (lastCheck.src && lastCheck.sizeKB > 0) {
                                        automationState.imageDownloadInitiated = true;
                                        topMostItem.dataset.gpaImageProcessed = 'true';
                                        triggerDownload(lastCheck.src, 'image', capturedImageIndex);
                                    }
                                    return;
                                }

                                // Log a cada 10 tentativas
                                if (attempts % 10 === 0) {
                                    console.log(`⏳ Polling imagem... tentativa ${attempts}/${maxAttempts}, atual: ${check.isPlaceholder ? 'PNG placeholder' : (check.isJpeg || check.isWebp ? 'JPEG/WEBP pequeno' : 'outro')}`);
                                }
                            }, 500);
                        } else if (!initialCheck.isPlaceholder && !initialCheck.valid) {
                            // JPEG/WEBP pequeno demais, iniciar polling também
                            console.log(`⏳ Imagem JPEG/WEBP muito pequena (${initialCheck.sizeKB.toFixed(1)}KB). Iniciando polling (índice: ${capturedImageIndex})...`);

                            let attempts = 0;
                            const maxAttempts = 60;

                            const pollInterval = setInterval(() => {
                                attempts++;

                                if (!automationState.isRunning || automationState.imageDownloadInitiated) {
                                    clearInterval(pollInterval);
                                    return;
                                }

                                const check = checkImageValid();

                                if (check.valid) {
                                    clearInterval(pollInterval);
                                    automationState.imageDownloadInitiated = true;
                                    console.log(`✅ Imagem final detectada após ${attempts} tentativas (${check.sizeKB.toFixed(1)}KB). Baixando índice ${capturedImageIndex}...`);
                                    topMostItem.dataset.gpaImageProcessed = 'true';
                                    triggerDownload(check.src, 'image', capturedImageIndex);
                                    return;
                                }

                                if (attempts >= maxAttempts) {
                                    clearInterval(pollInterval);
                                    console.log(`⚠️ Timeout. Baixando imagem atual...`);
                                    const lastCheck = checkImageValid();
                                    if (lastCheck.src && (lastCheck.isJpeg || lastCheck.isWebp)) {
                                        automationState.imageDownloadInitiated = true;
                                        topMostItem.dataset.gpaImageProcessed = 'true';
                                        triggerDownload(lastCheck.src, 'image', capturedImageIndex);
                                    }
                                }
                            }, 500);
                        }
                    }, downloadDelay);
                }
            }
        }

        // --- Existing Video Logic (Video Mode) ---
        for (const mutation of mutations) {
            if (mutation.type === 'childList') {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    if (automationState.mode === 'video' || automationState.mode === 'image-to-video') {
                        const videos = node.matches('video') ? [node] : Array.from(node.querySelectorAll('video'));
                        videos.forEach(video => {
                            const videoUrl = video.src;
                            if (videoUrl && videoUrl.includes('generated_video.mp4') && !automationState.processedVideoUrls.has(videoUrl)) {
                                automationState.processedVideoUrls.add(videoUrl); // Mark URL as processed immediately
                                video.dataset.processedSrc = videoUrl;
                                console.log('🎬 Vídeo gerado detectado:', videoUrl);
                                // Calcular índice correto antes de chamar processVideoElement
                                const videoIndex = automationState.mode === 'image-to-video'
                                    ? automationState.currentImageIndex
                                    : Math.max(0, automationState.processedVideoUrls.size - 1);
                                processVideoElement(video, videoIndex);
                            }
                        });
                    }
                }
            } else if (mutation.type === 'attributes' && mutation.attributeName === 'src') {
                const target = mutation.target;
                const videoUrl = target.src;
                if ((automationState.mode === 'video' || automationState.mode === 'image-to-video') && target.tagName === 'VIDEO' && videoUrl && videoUrl.includes('generated_video.mp4') && !automationState.processedVideoUrls.has(videoUrl)) {
                    automationState.processedVideoUrls.add(videoUrl); // Mark URL as processed immediately
                    target.dataset.processedSrc = videoUrl;
                    console.log('🎬 Vídeo atualizado detectado:', videoUrl);
                    // Calcular índice correto antes de chamar processVideoElement
                    const videoIndex = automationState.mode === 'image-to-video'
                        ? automationState.currentImageIndex
                        : Math.max(0, automationState.processedVideoUrls.size - 1);
                    processVideoElement(target, videoIndex);
                }
            }
        }
    }

    // --- Override: prefer botão oficial para download de vídeo após upscale ---
    async function processVideoElement(video, promptIndex = null) {
        // Use correct index based on mode
        // Para text-to-video: usar processedVideoUrls.size - 1 porque downloadedVideos é populado async
        // processedVideoUrls é incrementado imediatamente quando o vídeo é detectado
        let currentPromptIndex;
        if (promptIndex !== null) {
            currentPromptIndex = promptIndex;
        } else if (automationState.mode === 'image-to-video') {
            currentPromptIndex = automationState.currentImageIndex;
        } else {
            currentPromptIndex = Math.max(0, automationState.processedVideoUrls.size - 1);
        }
        const shouldUpscale = automationState.settings?.upscale;

        console.log(`🔍 [processVideoElement] Índice: ${currentPromptIndex}, Upscale: ${shouldUpscale}, Modo: ${automationState.mode}`);

        if (automationState.processingPrompts.has(currentPromptIndex) || automationState.downloadedVideos.has(currentPromptIndex)) {
            console.log(`⏭️ [processVideoElement] Prompt ${currentPromptIndex} já está sendo processado ou baixado. Ignorando.`);
            return;
        }

        // SET LOCK SYNCHRONOUSLY - This is critical to prevent race conditions
        automationState.processingPrompts.add(currentPromptIndex);
        console.log(`🔒 [processVideoElement] Lock adicionado para prompt ${currentPromptIndex}. processingPrompts.size = ${automationState.processingPrompts.size}`);

        const process = async () => {
            if (shouldUpscale) {
                if (automationState.upscaledPrompts.has(currentPromptIndex)) {
                    automationState.processingPrompts.delete(currentPromptIndex);
                    return;
                }

                // Lock already set synchronously above
                const result = await upscaleVideo(video);

                if (result.success) {
                    automationState.upscaledPrompts.add(currentPromptIndex);

                    if (result.method === 'extension' && result.url) {
                        // triggerDownload will mark as downloaded internally
                        await triggerDownload(result.url, 'video', currentPromptIndex);
                    } else {
                        // Fallback: use video src (may be SD if upscale URL not accessible)
                        console.log('⚠️ URL de upscale não acessível, usando src do vídeo.');
                        await triggerDownload(video.src, 'video', currentPromptIndex);
                    }
                } else {
                    // Upscale failed, download SD version
                    console.log('⚠️ Upscale falhou, baixando vídeo SD.');
                    await triggerDownload(video.src, 'video', currentPromptIndex);
                }

                // Se for o último item, finalizar
                const isLastItem = automationState.mode === 'image-to-video'
                    ? automationState.currentImageIndex >= automationState.imageQueue.length - 1
                    : automationState.currentIndex >= automationState.prompts.length - 1;
                if (isLastItem) {
                    console.log('✅ Último vídeo processado (com upscale), finalizando...');
                    handleAutomationComplete();
                }

                automationState.processingPrompts.delete(currentPromptIndex);
                console.log(`🔓 [processVideoElement] Lock removido para prompt ${currentPromptIndex} (upscale path). processingPrompts.size = ${automationState.processingPrompts.size}`);
            } else {
                // Non-upscale path - lock already set synchronously above
                console.log('⏳ Aguardando renderização final do vídeo (2s)...');
                await sleep(2000); // Wait for UI to settle

                // Double check after sleep
                if (automationState.downloadedVideos.has(currentPromptIndex)) {
                    automationState.processingPrompts.delete(currentPromptIndex);
                    return;
                }

                console.log('📥 Fazendo download do vídeo SD (upscale desabilitado)');

                // Always use extension download to ensure correct subfolder
                // Note: triggerDownload will mark as downloaded internally
                await triggerDownload(video.src, 'video', currentPromptIndex);
                console.log('✅ Download via extensão iniciado.');

                // Se for o último item, finalizar
                const isLastItemNonUpscale = automationState.mode === 'image-to-video'
                    ? automationState.currentImageIndex >= automationState.imageQueue.length - 1
                    : automationState.currentIndex >= automationState.prompts.length - 1;
                if (isLastItemNonUpscale) {
                    handleAutomationComplete();
                }

                automationState.processingPrompts.delete(currentPromptIndex);
                console.log(`🔓 [processVideoElement] Lock removido para prompt ${currentPromptIndex} (non-upscale path). processingPrompts.size = ${automationState.processingPrompts.size}`);
            }
        };
        await process();
    }

    // Mantém overlay visível ao finalizar e mostra elapsed; injeta status de upscale
    const __originalResetAutomation = resetAutomation;
    resetAutomation = function (options = {}) {
        const { keepOverlay = false, stopTimer = true } = options;
        if (automationState.timeoutId) clearTimeout(automationState.timeoutId);
        automationState = {
            isRunning: false,
            prompts: [],
            currentIndex: 0,
            delay: 20,
            timeoutId: null,
            settings: {},
            mode: 'video',
            modeApplied: false,
            startTime: null,
            upscaledPrompts: new Set(),
            processingPrompts: new Set(),
            downloadedVideos: new Set(),
            processedVideoUrls: new Set(),
            imageDownloadInitiated: false,
            promptsSinceLastBreak: 0,
            isOnBreak: false,
            breakEndTime: null
        };
        clearAutomationState();
        if (stopTimer) stopOverlayTimer();
        if (!keepOverlay) clearOverlay();
    };

    const __originalHandleAutomationComplete = handleAutomationComplete;
    handleAutomationComplete = function () {
        const elapsed = automationState.startTime ? Math.max(0, Math.floor((Date.now() - automationState.startTime) / 1000)) : 0;
        // Use imageQueue length for image-to-video mode, prompts length for other modes
        const totalItems = automationState.mode === 'image-to-video'
            ? (automationState.imageQueue?.length || 0)
            : (automationState.prompts?.length || 0);
        const itemType = automationState.mode === 'image-to-video' ? 'imagens' : 'prompts';

        sendMessageToBackground({
            action: 'automationComplete',
            totalPrompts: totalItems
        });
        stopOverlayTimer();
        updateOverlay({
            status: 'Concluído',
            prompt: `Todas as ${itemType} processadas`,
            index: totalItems,
            total: totalItems,
            elapsedSeconds: elapsed
        });
        resetAutomation({ keepOverlay: true, stopTimer: true });
    };

    const __originalProcessVideoElement = processVideoElement;
    processVideoElement = async function (video, promptIndex = null) {
        // Use correct index based on mode
        let currentPromptIndex;
        if (promptIndex !== null) {
            // Usar índice passado como parâmetro (calculado pelo caller)
            currentPromptIndex = promptIndex;
        } else if (automationState.mode === 'image-to-video') {
            currentPromptIndex = automationState.currentImageIndex;
        } else {
            // Para modo texto, usar o tamanho de processedVideoUrls (marca imediatamente)
            // Isso garante que cada vídeo novo tenha um índice único
            currentPromptIndex = automationState.processedVideoUrls.size - 1;
        }

        console.log(`🔍 [Wrapper] Tentando processar vídeo - índice: ${currentPromptIndex}, currentIndex: ${automationState.currentIndex}, processedVideoUrls.size: ${automationState.processedVideoUrls.size}`);

        // Early return if already processing or downloaded
        if (automationState.processingPrompts.has(currentPromptIndex) || automationState.downloadedVideos.has(currentPromptIndex)) {
            console.log(`🔒 [Wrapper] Índice ${currentPromptIndex} já está sendo processado ou baixado. Ignorando.`);
            return;
        }

        const promptText = (automationState.prompts && automationState.prompts[currentPromptIndex]) || '';
        if (automationState.settings?.upscale) {
            updateOverlay({
                status: 'Upscale do vídeo...',
                prompt: promptText,
                index: currentPromptIndex + 1,
                total: automationState.prompts.length
            });
        }
        return await __originalProcessVideoElement(video, currentPromptIndex);
    };

    function initialize() {
        const observer = new MutationObserver(handleImageGeneration);
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
        sendMessageToBackground({ action: 'contentScriptReady' });
        loadAutomationState();
        console.log('🚀 Grok Prompt Automator carregado!');
    }

    if (document.readyState === 'complete') {
        initialize();
    } else {
        window.addEventListener('load', initialize);
    }
})();
