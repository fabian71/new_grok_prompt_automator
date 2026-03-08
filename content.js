(function () {
    'use strict';

    if (window.whiskAutomatorLoaded) {
        return;
    }
    window.whiskAutomatorLoaded = true;

    try {
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
            awaitingImageCompletion: false,
            imageToVideoRetries: {},
            imagesDownloadedCount: 0,
            lastPromptSentIndex: -1,
            restoredFromReload: false,
            promptsSinceLastBreak: 0,
            isOnBreak: false,
            breakEndTime: null
        };

        // --- Keep-Alive para Service Worker ---
        let keepAliveInterval = null;
        let imageToVideoRunLock = false;

        function startKeepAlive() {
            if (keepAliveInterval) return;
            console.log('ðŸ”¥ Keep-alive iniciado');
            keepAliveInterval = setInterval(() => {
                try {
                    if (chrome.runtime && chrome.runtime.id) {
                        chrome.runtime.sendMessage({ action: 'ping' }).catch(() => {
                            // Context likely invalidated, stop sending
                            stopKeepAlive();
                        });
                    } else {
                        stopKeepAlive();
                    }
                } catch (e) {
                    // If context invalidated, this catch will trigger
                    stopKeepAlive();
                }
            }, 20000); // Ping a cada 20 segundos
        }

        function stopKeepAlive() {
            if (keepAliveInterval) {
                console.log('ðŸ”¥ Keep-alive parado');
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
            console.log('ðŸ’¾ Salvando estado:', {
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
            // TambÃ©m atualizar automationActive para false
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
                        console.log('âš ï¸ Estado de automaÃ§Ã£o encontrado, mas nÃ£o estamos na pÃ¡gina do Grok. Limpando...');
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
                        modeApplied: false, // Force re-check of mode on new page
                        // Garantir que currentImageIndex nunca seja undefined
                        currentImageIndex: saved.currentImageIndex != null ? saved.currentImageIndex : 0
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

            // Header com gradiente igual ao da extensÃ£o
            const header = document.createElement('div');
            Object.assign(header.style, {
                background: 'linear-gradient(135deg, rgba(56, 189, 248, 0.25), rgba(14, 165, 233, 0.1))',
                padding: '14px 16px',
                borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between'
            });

            // Logo e tÃ­tulo
            const logoSection = document.createElement('div');
            Object.assign(logoSection.style, {
                display: 'flex',
                alignItems: 'center',
                gap: '10px'
            });

            // Ãcone/logo (cÃ­rculo com gradiente)
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

            // SeÃ§Ã£o direita: badge de status e botÃ£o fechar
            const rightSection = document.createElement('div');
            Object.assign(rightSection.style, {
                display: 'flex',
                alignItems: 'center',
                gap: '10px'
            });

            // Badge de versÃ£o/status
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
            statusBadge.textContent = 'v3.0';
            rightSection.appendChild(statusBadge);

            // BotÃ£o fechar (X)
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

            // ConteÃºdo principal
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
            footer.innerHTML = 'Gosta do projeto? <span style="color:#f43f5e;">❤</span> Me paga um cafezinho: <a href="https://ko-fi.com/dentparanoide" target="_blank" rel="noopener noreferrer" style="color:#38bdf8; text-decoration: none; font-weight: 600;">ko-fi.com/dentparanoide</a>';

            // Montar conteÃºdo
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

        function sanitizeUiText(text) {
            let out = String(text || '');
            out = out
                .replace(/Ã¡|Ã¢|Ã£|Ã¤/g, 'a')
                .replace(/Ã§/g, 'c')
                .replace(/Ã©|Ãª/g, 'e')
                .replace(/Ã­/g, 'i')
                .replace(/Ã³|Ã´|Ãµ/g, 'o')
                .replace(/Ãº/g, 'u')
                .replace(/Ã/g, 'A')
                .replace(/â™¥/g, '❤')
                .replace(/âœ•/g, '✕')
                .replace(/â˜•/g, 'Pausa')
                .replace(/â±ï¸/g, '')
                .replace(/âœ…|âš ï¸|âŒ|â³|â©|â„¹ï¸|âŒ¨ï¸|â­ï¸/g, '')
                .replace(/\s{2,}/g, ' ')
                .trim();
            return out;
        }

        function updateOverlay({ status, prompt, index, total, elapsedSeconds }) {
            ensureOverlay();
            overlayState.lastData = { status, prompt, index, total };
            if (overlayState.statusEl) overlayState.statusEl.textContent = sanitizeUiText(status || '...');
            if (overlayState.promptEl) overlayState.promptEl.textContent = sanitizeUiText(prompt || '');
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
                        overlayState.breakInfoEl.textContent = `Pausa: ${formatDuration(remainingSec)} restantes`;
                        overlayState.breakInfoEl.style.color = '#ff9800';
                    } else {
                        overlayState.breakInfoEl.textContent = 'Retomando...';
                    }
                } else {
                    const promptsUntilBreak = (automationState.settings?.breakPrompts || 0) - automationState.promptsSinceLastBreak;
                    overlayState.breakInfoEl.textContent = `Proxima pausa em ${promptsUntilBreak} prompts (${automationState.settings?.breakDuration || 0} min)`;
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
            try {
                const style = window.getComputedStyle(element);
                if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;

                // offsetParent is null if the element or any of its parents has display: none
                // But it's also null for fixed elements. So we use alternative checks.
                const rect = element.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            } catch (e) {
                return false;
            }
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
                    reject(new Error(`Elemento nÃ£o encontrado: ${selector}`));
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
                        console.error('âŒ Erro ao enviar mensagem:', chrome.runtime.lastError.message);
                    } else {
                        console.log('âœ… Mensagem enviada:', response);
                    }
                });
            } catch (error) {
                console.error('âŒ Falha ao enviar mensagem:', error);
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

        function safeSubmitClick(element) {
            if (!element) return;
            try {
                if (element.scrollIntoView) {
                    element.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
                }
                element.focus();
            } catch (e) { }
            // Intencionalmente apenas 1 click real para evitar duplo envio.
            element.click();
        }

        function closeOpenMenusSafely() {
            try {
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
                document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true }));
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
                console.log(`ðŸ”„ Tentativa ${i + 1}/${maxAttempts} de abrir menu...`);
                forceClick(button);

                // Poll for menu items - mais rÃ¡pido
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
            const direct = document.getElementById('model-select-trigger');
            if (direct && isVisible(direct)) return direct;

            const candidates = findAllElements('button[aria-haspopup="menu"], button[id*="model"]');
            const filtered = candidates.filter(btn => {
                if (!isVisible(btn)) return false;
                if (btn.closest('[role="menu"]')) return false;
                if (btn.disabled) return false;
                return !!btn.querySelector('span') && btn.querySelectorAll('svg').length >= 1;
            });

            if (!filtered.length) return null;

            return filtered.sort((a, b) => {
                const score = (el) => {
                    let s = 0;
                    if (el.id === 'model-select-trigger') s += 10;
                    if ((el.id || '').startsWith('radix-')) s += 3;
                    if ((el.getAttribute('aria-haspopup') || '') === 'menu') s += 2;
                    return s;
                };
                return score(b) - score(a);
            })[0];
        }

        function normalizeAspectRatio(value) {
            const match = String(value || '').match(/(\d+)\s*:\s*(\d+)/);
            return match ? `${match[1]}:${match[2]}` : '';
        }

        function findAspectRatioTrigger() {
            const candidates = findAllElements('button[aria-haspopup="menu"]')
                .filter(btn => isVisible(btn) && !btn.disabled && !btn.closest('[role="menu"]'));

            const scored = candidates
                .map(btn => {
                    const txt = normalizeText(btn.textContent || '');
                    const aria = normalizeText(btn.getAttribute('aria-label') || '');
                    const ratioFromText = normalizeAspectRatio(btn.textContent || '');
                    let score = 0;

                    if (ratioFromText) score += 8;
                    if (aria.includes('ratio') || aria.includes('propor')) score += 5;
                    if (btn.getAttribute('aria-expanded') !== null) score += 2;
                    if ((btn.id || '').startsWith('radix-')) score += 1;
                    if (txt.includes(':')) score += 1;

                    return { btn, score };
                })
                .filter(item => item.score > 0)
                .sort((a, b) => b.score - a.score);

            return scored.length ? scored[0].btn : null;
        }

        function findAspectRatioOption(targetRatio) {
            const normalizedTarget = normalizeAspectRatio(targetRatio);
            if (!normalizedTarget) return null;

            // 1. Tentar busca global primeiro (caso os botÃµes estejam expostos na barra lateral/ferramentas)
            const allButtons = Array.from(document.querySelectorAll('button'));
            const directMatch = allButtons.find(btn => {
                const aria = btn.getAttribute('aria-label') || '';
                const text = btn.textContent || '';
                if (!isVisible(btn)) return false;
                if (btn.closest('[role="menu"]')) return false;
                if (btn.getAttribute('aria-haspopup') === 'menu') return false; // trigger, not option
                return normalizeAspectRatio(aria) === normalizedTarget || normalizeAspectRatio(text) === normalizedTarget;
            });
            if (directMatch) return directMatch;

            // 2. Se nÃ£o achou direto, procurar em menus abertos
            const openMenus = findAllElements('[role="menu"][data-state="open"], [data-radix-menu-content][data-state="open"]');
            for (const menu of openMenus) {
                const option = Array.from(menu.querySelectorAll('[role="menuitem"], button')).find(el => {
                    const aria = el.getAttribute('aria-label') || '';
                    const text = el.textContent || '';
                    return normalizeAspectRatio(aria) === normalizedTarget || normalizeAspectRatio(text) === normalizedTarget;
                });
                if (option) return option;
            }

            return null;
        }

        function isAspectRatioSelected(optionButton) {
            if (!optionButton) return false;

            // 1. Atributos padrÃ£o ARIA
            if (optionButton.getAttribute('aria-checked') === 'true' ||
                optionButton.getAttribute('aria-selected') === 'true' ||
                optionButton.dataset.state === 'on') return true;

            // 2. Classes de estilo do Grok (Texto e Fundo PrimÃ¡rio)
            const hasPrimaryText = !!optionButton.querySelector('.text-primary, [class*="text-primary"]');
            const hasPrimaryBg = !!optionButton.querySelector('.bg-primary, [class*="bg-primary"]');
            const hasFontSemibold = !!optionButton.querySelector('.font-semibold');

            // 3. Checar o prÃ³prio botÃ£o
            const btnClasses = optionButton.className || '';
            const isPrimaryBtn = btnClasses.includes('text-primary') || btnClasses.includes('bg-primary');

            // No HTML que vocÃª enviou, o botÃ£o ativo tem text-primary e font-semibold
            if ((hasPrimaryText && hasFontSemibold) || hasPrimaryBg || isPrimaryBtn) return true;

            // Novo menu de proporcao usa role=menuitem com font-semibold no item selecionado
            if (optionButton.getAttribute('role') === 'menuitem') {
                if (btnClasses.includes('font-semibold') || optionButton.querySelector('.font-semibold')) return true;
                if (optionButton.querySelector('.bg-primary, [class*="bg-primary"]')) return true;
            }

            return false;
        }

        function findOpenAspectMenuForTrigger(trigger) {
            if (!trigger) return null;
            const triggerId = trigger.id;

            if (triggerId) {
                const linked = document.querySelector(`[role="menu"][data-state="open"][aria-labelledby="${triggerId}"]`);
                if (linked) return linked;
            }

            return document.querySelector('[role="menu"][data-state="open"][data-radix-menu-content]') ||
                document.querySelector('[role="menu"][data-state="open"]');
        }

        async function selectGenerationMode(mode) {
            const targetMode = mode === 'video' ? 'video' : 'image';
            console.log(`🎯 [selectGenerationMode] Alvo: ${targetMode}`);

            // Novo layout: radiogroup direto na barra de prompt.
            for (let attempt = 0; attempt < 8; attempt++) {
                const groups = findAllElements('[role="radiogroup"]')
                    .filter(g => {
                        const text = normalizeText(g.textContent || '');
                        const label = normalizeText(g.getAttribute('aria-label') || '');
                        return (
                            label.includes('modo') ||
                            label.includes('generation mode') ||
                            text.includes('imagem') ||
                            text.includes('image')
                        ) && (
                                text.includes('video') ||
                                text.includes('vídeo') ||
                                text.includes('imagem') ||
                                text.includes('image')
                            );
                    });

                const modeGroup = groups[0];
                if (modeGroup) {
                    const radios = Array.from(modeGroup.querySelectorAll('button[role="radio"]'));
                    const targetBtn = radios.find(btn => {
                        const txt = normalizeText(btn.textContent || '');
                        if (targetMode === 'video') return txt.includes('video') || txt.includes('vídeo');
                        return txt.includes('image') || txt.includes('imagem');
                    });

                    if (targetBtn) {
                        if (targetBtn.getAttribute('aria-checked') === 'true') {
                            console.log(`✅ Modo ${targetMode} já estava selecionado.`);
                            return true;
                        }

                        forceClick(targetBtn);
                        await sleep(450);

                        if (targetBtn.getAttribute('aria-checked') === 'true') {
                            console.log(`✅ Modo ${targetMode} selecionado no radiogroup.`);
                            return true;
                        }
                    }
                }

                await sleep(300);
            }

            // Fallback legado: menu dropdown (UI antiga).
            let trigger = null;
            for (let i = 0; i < 15; i++) {
                const menus = Array.from(document.querySelectorAll('button[aria-haspopup="menu"]'));
                trigger = menus.find(b => {
                    const label = (b.getAttribute('aria-label') || '').toLowerCase();
                    const text = (b.textContent || '').toLowerCase();
                    return label.includes('config') || label.includes('sett') ||
                        label.includes('seleção') || label.includes('selection') ||
                        text.includes('imagem') || text.includes('vídeo') ||
                        text.includes('image') || text.includes('video');
                });
                if (trigger) break;
                await sleep(500);
            }

            if (!trigger) {
                console.warn('⚠️ Trigger de modo não encontrado.');
                return false;
            }

            for (let attempt = 0; attempt < 3; attempt++) {
                if (trigger.getAttribute('aria-expanded') !== 'true') {
                    forceClick(trigger);
                    await sleep(800);
                }

                const modeGroup = Array.from(document.querySelectorAll('[role="group"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]'))
                    .find(el => el.querySelectorAll('[role="menuitemradio"]').length >= 2);

                if (!modeGroup) {
                    forceClick(trigger);
                    await sleep(1000);
                    continue;
                }

                const items = Array.from(modeGroup.querySelectorAll('[role="menuitemradio"]'));
                let targetBtn = null;
                if (targetMode === 'video') {
                    targetBtn = items.find(el => {
                        const text = normalizeText(el.textContent || '');
                        return text.includes('video') || text.includes('vídeo');
                    }) || items[1];
                } else {
                    targetBtn = items.find(el => {
                        const text = normalizeText(el.textContent || '');
                        return text.includes('image') || text.includes('imagem');
                    }) || items[0];
                }

                if (targetBtn) {
                    const isSelected = targetBtn.getAttribute('aria-checked') === 'true';
                    if (!isSelected) {
                        forceClick(targetBtn);
                        await sleep(600);
                    }
                    closeOpenMenusSafely();
                    await sleep(300);
                    return true;
                }
            }

            console.warn('⚠️ Não foi possível garantir a seleção do modo.');
            closeOpenMenusSafely();
            return false;
        }


        async function selectAspectRatio(aspectRatio) {
            const target = normalizeAspectRatio(aspectRatio);
            if (!target) return false;

            console.log(`ðŸŽ¯ Tentando selecionar proporÃ§Ã£o: ${target}`);

            // 1. Tentar seleÃ§Ã£o direta primeiro (sem abrir menu)
            const directOption = findAspectRatioOption(target);
            if (directOption && isVisible(directOption)) {
                if (isAspectRatioSelected(directOption)) {
                    console.log(`âœ… ProporÃ§Ã£o ${target} jÃ¡ selecionada.`);
                    return true;
                }
                console.log(`ðŸ–±ï¸ Clicando diretamente no botÃ£o de proporÃ§Ã£o ${target}`);
                forceClick(directOption);
                await sleep(500);
                if (isAspectRatioSelected(directOption)) return true;
            }

            // 2. Se falhou direto, tentar via menu de opÃ§Ãµes do modelo
            for (let i = 0; i < 3; i++) {
                const trigger = findAspectRatioTrigger() || findModelOptionsTrigger();
                if (!trigger) {
                    await sleep(300);
                    continue;
                }

                if (trigger.getAttribute('aria-expanded') !== 'true') {
                    forceClick(trigger);
                    await sleep(500);
                }

                const menu = findOpenAspectMenuForTrigger(trigger);
                if (!menu) continue;

                const option = Array.from(menu.querySelectorAll('[role="menuitem"], button')).find(el => {
                    const aria = el.getAttribute('aria-label') || '';
                    const text = el.textContent || '';
                    return normalizeAspectRatio(aria) === target || normalizeAspectRatio(text) === target;
                });

                if (option) {
                    if (isAspectRatioSelected(option)) {
                        console.log(`✅ [Menu] Proporção ${target} já selecionada.`);
                        closeOpenMenusSafely();
                        return true;
                    }
                    forceClick(option);
                    await sleep(600);
                    // Verificar se realmente foi selecionada após o clique
                    if (isAspectRatioSelected(option)) {
                        console.log(`✅ [Menu] Proporção ${target} selecionada com sucesso.`);
                        closeOpenMenusSafely();
                        return true;
                    }
                    console.warn(`⚠️ [Menu] Clique na proporção ${target} pode não ter funcionado. Tentando via seleção direta...`);
                    closeOpenMenusSafely();
                    await sleep(400);
                    // Tentativa extra: selecionar diretamente fora do menu
                    const directRetry = findAspectRatioOption(target);
                    if (directRetry && isVisible(directRetry) && !isAspectRatioSelected(directRetry)) {
                        forceClick(directRetry);
                        await sleep(500);
                        console.log(`✅ [Direto retry] Proporção ${target} aplicada.`);
                    }
                    return true;
                }
            }

            console.warn(`❌ Não foi possível encontrar opção para proporção: ${target}`);
            return false;
        }

        // --- Download Helper ---
        const triggerDownload = async (url, type, promptIndex = null) => {
            if (!url) return;
            // Determine correct index based on mode
            let actualIndex;
            if (promptIndex !== null && promptIndex >= 0) {
                actualIndex = promptIndex;
            } else if (automationState.mode === 'image-to-video') {
                actualIndex = automationState.currentImageIndex;
            } else if (automationState.mode === 'video') {
                actualIndex = Math.max(0, automationState.processedVideoUrls.size - 1);
            } else {
                actualIndex = Math.max(0, automationState.currentIndex - 1);
            }

            if (actualIndex < 0) actualIndex = 0;

            console.log(`ðŸ“¥ [triggerDownload] type=${type}, actualIndex=${actualIndex}, mode=${automationState.mode}`);

            // Bloqueio SÃ­ncrono Imediato
            let preMarkedVideoDownload = false;
            if (type === 'video') {
                if (automationState.downloadedVideos.has(actualIndex)) {
                    console.log(`âœ… [triggerDownload] JÃ¡ marcado como baixado para Ã­ndice ${actualIndex}, abortando.`);
                    return;
                }
                automationState.downloadedVideos.add(actualIndex);
                preMarkedVideoDownload = true;
                saveAutomationState();
            }

            let promptText = 'prompt';
            if (automationState.mode === 'image-to-video' && automationState.imageQueue) {
                const imgData = automationState.imageQueue[actualIndex];
                if (imgData) promptText = imgData.name;
            } else if (automationState.prompts) {
                promptText = automationState.prompts[actualIndex] || 'prompt';
            }

            const safePromptName = promptText.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9\-]/g, '').substring(0, 50);
            const timestamp = Date.now();
            const ext = type === 'video' ? 'mp4' : 'png';
            const filename = `${actualIndex + 1}_${safePromptName}_${timestamp}.${ext}`;

            const isRuntimeAvailable = () => {
                try {
                    return !!(chrome && chrome.runtime && chrome.runtime.id);
                } catch (e) {
                    return false;
                }
            };

            const sendToBackground = async (finalUrl) => {
                console.log(`ðŸš€ [triggerDownload] Enviando para background: ${filename}`);
                try {
                    if (!isRuntimeAvailable()) {
                        console.warn('WARN [triggerDownload] Runtime indisponivel (context invalidated).');
                        return false;
                    }
                    const response = await new Promise((resolve) => {
                        try {
                            chrome.runtime.sendMessage({
                                action: 'DOWNLOAD_IMAGE',
                                type: 'DOWNLOAD_IMAGE',
                                url: finalUrl,
                                filename: filename,
                                prompt: promptText,
                                savePromptTxt: automationState.settings?.savePromptTxt || false
                            }, (resp) => {
                                if (chrome.runtime.lastError) {
                                    console.warn(`âš ï¸ [triggerDownload] Erro:`, chrome.runtime.lastError.message);
                                    resolve(null);
                                } else {
                                    resolve(resp);
                                }
                            });
                        } catch (innerErr) {
                            console.warn('WARN [triggerDownload] Falha ao chamar sendMessage:', innerErr?.message || innerErr);
                            resolve(null);
                        }
                    });
                    if (response && response.success) {
                        console.log(`âœ… [triggerDownload] Resposta do background:`, response);
                        return true;
                    }
                    return false;
                } catch (error) {
                    console.error('âŒ Erro no triggerDownload:', error);
                    return false;
                }
            };

            // Se o vÃ­deo vier como blob:, converte para data URL para o background script ter acesso
            let sentOk = false;
            if (url.startsWith('blob:')) {
                try {
                    const resp = await fetch(url);
                    const blob = await resp.blob();
                    const dataUrl = await new Promise((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onloadend = () => resolve(reader.result);
                        reader.onerror = reject;
                        reader.readAsDataURL(blob);
                    });
                    sentOk = await sendToBackground(dataUrl);
                } catch (err) {
                    console.warn('âš ï¸ Falha ao converter blob, tentando URL original...', err);
                    sentOk = await sendToBackground(url);
                }
            } else {
                sentOk = await sendToBackground(url);
            }

            if (!sentOk && preMarkedVideoDownload) {
                console.warn(`WARN [triggerDownload] Download nao confirmado para indice ${actualIndex}. Removendo marca de download para permitir retentativa.`);
                automationState.downloadedVideos.delete(actualIndex);
                saveAutomationState();
            }
        };

        // --- Upscale Logic ---
        async function waitForUpscaleComplete(container, maxWaitTime = 35000) {
            const startTime = Date.now();
            console.log('⏳ Aguardando upscale HD terminar...');

            const getHdVideoFromContainer = () => {
                if (!container) return null;

                const directHd = container.querySelector('video#hd-video') ||
                    container.querySelector('video[src*="generated_video_hd"]') ||
                    container.querySelector('video source[src*="generated_video_hd"]')?.closest('video');
                if (directHd) return directHd;

                const videos = Array.from(container.querySelectorAll('video'));
                return videos.find(v => {
                    const src = v.currentSrc || v.src || '';
                    if (!src) return false;
                    const hasHdHint = src.includes('generated_video_hd') || v.id === 'hd-video';
                    const looksVisible = v.style.visibility !== 'hidden' && v.style.display !== 'none';
                    return hasHdHint && looksVisible;
                }) || null;
            };

            while ((Date.now() - startTime) < maxWaitTime) {
                try {
                    const hdVideoFast = getHdVideoFromContainer();
                    if (hdVideoFast) {
                        const hdSrc = hdVideoFast.currentSrc || hdVideoFast.src || '';
                        if (hdSrc && hdSrc.startsWith('http')) {
                            const rs = typeof hdVideoFast.readyState === 'number' ? hdVideoFast.readyState : 0;
                            console.log(`✅ HD detectado (fast-path). readyState=${rs}`);
                            return { success: true, url: hdSrc, method: 'extension' };
                        }
                    }

                    const hdIndicator = Array.from(container.querySelectorAll('div')).find(div => {
                        return div.textContent.trim() === 'HD' && div.classList.contains('absolute') && div.classList.contains('rounded-full');
                    });

                    if (hdIndicator) {
                        console.log('✅ Upscale HD concluído! Indicador HD encontrado no container.');
                        await sleep(600);

                        let hdVideo = getHdVideoFromContainer();
                        if (!hdVideo) {
                            const videos = Array.from(container.querySelectorAll('video'));
                            hdVideo = videos.find(v => v.src && v.style.visibility !== 'hidden' && v.src.includes('generated_video'));
                        }

                        if (hdVideo && (hdVideo.currentSrc || hdVideo.src)) {
                            const hdSrc = hdVideo.currentSrc || hdVideo.src;
                            console.log('📥 Vídeo HD encontrado, enviando URL do HD para download via extensão...');
                            return { success: true, url: hdSrc, method: 'extension' };
                        }
                    }

                    const downloadBtn = Array.from(container.querySelectorAll('button')).find(btn => {
                        const label = normalizeText(btn.getAttribute('aria-label') || '');
                        return label.includes('baixar') || label.includes('download');
                    });

                    if (downloadBtn) {
                        console.log('📥 Botão de download detectado no card. Clicando para não atrasar o fluxo...');
                        forceClick(downloadBtn);
                        return { success: true, method: 'click' };
                    }

                    const elapsed = Date.now() - startTime;
                    await sleep(elapsed < 10000 ? 500 : 1000);
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
                        console.log(`[${attempt}] ðŸ“Š VÃ­deo ainda gerando...`);
                        await sleep(1500);
                        continue;
                    }

                    if (!videoElement.src || !videoElement.src.includes('generated_video.mp4')) {
                        console.log(`[${attempt}] â³ Aguardando vÃ­deo ter src vÃ¡lido...`);
                        await sleep(1000);
                        continue;
                    }

                    if (videoElement.readyState < 2) {
                        console.log(`[${attempt}] ðŸ”„ VÃ­deo carregando...`);
                        await sleep(1000);
                        continue;
                    }

                    console.log(`[${attempt}] âœ… VÃ­deo pronto! Procurando botÃ£o de mais opÃ§Ãµes...`);

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
                        console.log(`[${attempt}] âŒ BotÃ£o "Mais opÃ§Ãµes" nÃ£o encontrado.`);
                        await sleep(1000);
                        continue;
                    }

                    console.log(`[${attempt}] âœ… BotÃ£o encontrado! Clicando...`);

                    // 3. Open Menu
                    const menuItems = await openMenuAndGetItems(moreOptionsBtn, 5);
                    if (!menuItems.length) {
                        console.log(`[${attempt}] âš ï¸ Menu nÃ£o abriu.`);
                        await sleep(1000);
                        continue;
                    }

                    console.log(`ðŸ“‹ Menu aberto! Itens: ${menuItems.map(m => normalizeText(m.textContent)).join(' | ')}`);

                    const upscaleItem = menuItems.find(item => {
                        const hasIcon = item.querySelector('svg.lucide-expand');
                        const text = normalizeText(item.textContent);
                        return hasIcon || text.includes('upscale') || text.includes('ampliar') || text.includes('escala') || text.includes('expand');
                    });

                    if (upscaleItem) {
                        forceClick(upscaleItem);
                        console.log('ðŸš€ Upscale solicitado com sucesso!');
                        await sleep(500);

                        // Wait for upscale and download
                        return await waitForUpscaleComplete(container);
                    } else {
                        console.log(`[${attempt}] âš ï¸ OpÃ§Ã£o "Upscale" nÃ£o encontrada no menu.`);
                        forceClick(moreOptionsBtn); // Close menu
                        await sleep(1000);
                    }

                } catch (error) {
                    console.error(`[${attempt}] âŒ Erro no loop de upscale:`, error);
                    await sleep(1000);
                }
            }
            return { success: false };
        }

        function findSubmitButton() {
            const selectors = [
                'form button[type="submit"]',
                'button[type="submit"]',
                'button[aria-label*="enviar" i]',
                'button[aria-label*="send" i]',
                'button:has(svg.lucide-arrow-right)',
                'button:has(svg.lucide-arrow-up)'
            ];

            for (const selector of selectors) {
                const candidates = findAllElements(selector);
                const button = candidates.find(btn =>
                    isVisible(btn) &&
                    !btn.disabled &&
                    !btn.closest('[role="menu"]') &&
                    (btn.getAttribute('aria-haspopup') || '') !== 'menu'
                );
                if (button) return button;
            }

            return null;
        }

        // --- Core Logic ---
        async function submitPrompt(prompt, aspectRatio) {
            try {
                const textarea = findEditor() || await waitForElement(SELECTORS.textarea);
                simulateTyping(textarea, prompt);
                await sleep(500);

                if (aspectRatio) {
                    let aspectApplied = false;
                    for (let attempt = 0; attempt < 2 && !aspectApplied; attempt++) {
                        aspectApplied = await selectAspectRatio(aspectRatio);
                        if (!aspectApplied) {
                            console.warn(`âš ï¸ Falha ao aplicar aspect ratio ${aspectRatio} (tentativa ${attempt + 1}/2).`);
                            await sleep(300);
                        }
                    }

                    if (!aspectApplied) {
                        throw new Error(`NÃ£o foi possÃ­vel aplicar a proporÃ§Ã£o ${aspectRatio} antes do envio.`);
                    }
                }

                const submitButton = findSubmitButton();
                if (!submitButton || submitButton.disabled) {
                    // Fallback agnÃ³stico de idioma: tenta Enter no editor
                    textarea.focus();
                    textarea.dispatchEvent(new KeyboardEvent('keydown', {
                        bubbles: true, cancelable: true, key: 'Enter', code: 'Enter'
                    }));
                    textarea.dispatchEvent(new KeyboardEvent('keyup', {
                        bubbles: true, cancelable: true, key: 'Enter', code: 'Enter'
                    }));
                    await sleep(250);
                    return;
                }
                safeSubmitClick(submitButton);

            } catch (error) {
                console.error('Erro ao enviar prompt:', error);
                throw error;
            }
        }

        // =========================================================================
        // FLUXO DE IMAGEM â€” espelho exato da extensÃ£o de referÃªncia (pasta temp)
        // =========================================================================

        // Tamanho mínimo do src de uma imagem JPEG base64 finalizada.
        // Uma imagem final do Grok tem geralmente >130KB de dados base64.
        // Declarada aqui (antes das funções) pois const não tem hoisting.
        const FINAL_IMAGE_SRC_MIN_LENGTH = 130000;

        /**
         * PASSO 1 â€” Configurar proporÃ§Ã£o da imagem.
         * NOTA: JÃ¡ estamos na pÃ¡gina /imagine (modo imagem).
         * O menu de configuraÃ§Ã£o Ã© para selecionar modelo (Aurora, etc.), nÃ£o Image vs Video.
         * Portanto nÃ£o existe botÃ£o "Image Mode" para clicar â€” apenas selecionar a proporÃ§Ã£o.
         */
        async function configureImageMode(aspectRatio) {
            console.log(`ðŸŽ¨ [configureImageMode] Alvo: ${aspectRatio}`);

            if (!aspectRatio) return true;

            const target = normalizeAspectRatio(aspectRatio);

            // 1. Tentar seleÃ§Ã£o direta (Muitas vezes os botÃµes jÃ¡ estÃ£o na tela)
            const directBtn = findAspectRatioOption(target);
            if (directBtn && isVisible(directBtn)) {
                if (isAspectRatioSelected(directBtn)) {
                    console.log(`âœ… ProporÃ§Ã£o ${target} jÃ¡ estÃ¡ selecionada (direto).`);
                    return true;
                }
                console.log(`ðŸ–±ï¸ Clicando no botÃ£o de proporÃ§Ã£o direto: ${target}`);
                forceClick(directBtn);
                await sleep(1000);
                if (isAspectRatioSelected(directBtn)) return true;
                console.log('âš ï¸ Clique direto nÃ£o parece ter funcionado, tentando via menu...');
            }

            // 2. Tentar via menu de configuraÃ§Ãµes
            const applied = await selectAspectRatio(target);
            if (!applied) {
                console.warn(`âš ï¸ NÃ£o foi possÃ­vel aplicar proporÃ§Ã£o ${target}, prosseguindo.`);
            }

            return true;
        }

        /**
         * PASSO 2 â€” Inserir prompt e enviar via keydown Enter.
         * Replica a funÃ§Ã£o E() da extensÃ£o temp:
         *   - textContent = prompt  (nÃ£o innerHTML)
         *   - dispatch: input + change
         *   - keydown Enter com keyCode 13
         * NÃƒO usa forceClick no botÃ£o submit â€” isso interferia com a geraÃ§Ã£o.
         */
        async function insertAndSubmitPromptImage(prompt) {
            console.log(`ðŸ“ [insertAndSubmitPromptImage] "${prompt.substring(0, 40)}..."`);

            let editor = null;
            for (let i = 0; i < 15; i++) {
                editor = findEditor();
                if (editor) break;
                await sleep(500);
            }
            if (!editor) throw new Error('Editor nÃ£o encontrado apÃ³s 7.5s');

            editor.focus();
            await sleep(200);

            // Inserir texto â€” igual Ã  extensÃ£o temp: textContent para contenteditable
            if (editor.isContentEditable) {
                editor.textContent = prompt;
            } else {
                editor.value = prompt;
            }

            // Disparar eventos para React reconhecer a mudanÃ§a
            editor.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
            editor.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
            await sleep(500);

            // Enviar via keydown Enter (keyCode 13) â€” EXATAMENTE como a extensÃ£o temp
            editor.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
                bubbles: true, cancelable: true
            }));

            console.log('ðŸš€ Prompt enviado via keydown Enter');
            await sleep(300);
            return true;
        }

        /**
         * PASSO 3 â€” Aguardar e baixar imagens finalizadas.
         * Replica o loop k() da extensÃ£o temp para textToImage:
         *   - Polling a cada 2s, mÃ¡ximo 150 iteraÃ§Ãµes (5 min)
         *   - Procura img[alt="Generated image"] com src.length >= 130000
         *   - Quando outputCount imagens prontas, baixa todas
         */
        async function waitAndDownloadImages(promptIndex, prompt, outputCount, sectionsBefore = -1) {
            console.log(`ðŸ” [waitAndDownloadImages] Aguardando ${outputCount} imagem(ns)... (prompt ${promptIndex + 1})`);
            const maxIterations = 150; // 150 Ã— 2s = 5 minutos

            // Se sectionsBefore nÃ£o foi passado, capturar agora (pode jÃ¡ incluir a nova seÃ§Ã£o)
            if (sectionsBefore < 0) {
                sectionsBefore = document.querySelectorAll('[id^="imagine-masonry-section"]').length;
            }

            // Nome seguro para arquivo â€” igual Ã  funÃ§Ã£o v() da extensÃ£o temp
            const safePromptName = (prompt || 'imagem')
                .replace(/\s+/g, '-')
                .replace(/[^a-zA-Z0-9\-]/g, '')
                .replace(/-+/g, '-')
                .replace(/^-+|-+$/g, '')
                .substring(0, 50) || 'imagem';

            const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');

            // â”€â”€ PASSO A: Aguardar nova seÃ§Ã£o masonry aparecer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
            // A extensÃ£o temp usa h(r.imagineMasonrySection).last() â€” pega a Ãšltima seÃ§Ã£o.
            // Quando o Grok recebe o prompt, cria uma nova seÃ§Ã£o masonry.
            // SÃ³ comeÃ§amos a polling NAS IMAGENS depois que essa nova seÃ§Ã£o existir.
            console.log(`ðŸ“Š SeÃ§Ãµes masonry antes: ${sectionsBefore}`);

            // Aguardar nova seÃ§Ã£o (mÃ¡x 30s = 15 iteraÃ§Ãµes de 2s)
            let newSectionFound = false;
            for (let i = 0; i < 15; i++) {
                if (!automationState.isRunning) return false;
                await sleep(2000);
                const sectionsNow = document.querySelectorAll('[id^="imagine-masonry-section"]').length;
                if (sectionsNow > sectionsBefore) {
                    console.log(`âœ… Nova seÃ§Ã£o masonry detectada! (${sectionsNow} seÃ§Ãµes)`);
                    newSectionFound = true;
                    break;
                }
                console.log(`â³ Aguardando nova seÃ§Ã£o... (${sectionsNow}/${sectionsBefore + 1})`);
            }

            if (!newSectionFound) {
                console.warn('âš ï¸ Nenhuma nova seÃ§Ã£o masonry apareceu. Usando Ãºltima seÃ§Ã£o existente.');
            }

            // â”€â”€ PASSO B: Polling na ÃšLTIMA seÃ§Ã£o (= geraÃ§Ã£o atual) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
            let iteration = 0;
            while (iteration < maxIterations) {
                if (!automationState.isRunning) {
                    console.log('ðŸ›‘ AutomaÃ§Ã£o parada');
                    return false;
                }

                // Sempre pegar a Ãºltima seÃ§Ã£o (mais recente = geraÃ§Ã£o atual)
                // IGUAL ao .last() da extensÃ£o temp
                const root = getMasonryRoot();
                const allImgs = Array.from(root.querySelectorAll('img[alt="Generated image"]'));
                const finalImgs = allImgs.filter(img => {
                    const src = img.src || '';
                    if (!src || src.length < 10) return false;

                    // Imagem base64 JPEG final (formato antigo do Grok)
                    if (src.startsWith('data:image/jpeg') && src.length >= FINAL_IMAGE_SRC_MIN_LENGTH) return true;

                    // Imagem via URL HTTP/HTTPS (formato atual do Grok - serve via CDN)
                    // Aceitar qualquer src que seja URL externa e nÃ£o seja PNG placeholder
                    if ((src.startsWith('http://') || src.startsWith('https://')) && !src.startsWith('data:image/png')) return true;

                    // Blob URL (tambÃ©m pode ser a imagem final)
                    if (src.startsWith('blob:')) return true;

                    return false;
                });

                if (iteration % 5 === 0) {
                    const pngs = allImgs.filter(i => (i.src || '').startsWith('data:image/png')).length;
                    const jpegs = allImgs.filter(i => (i.src || '').startsWith('data:image/jpeg')).length;
                    const httpImgs = allImgs.filter(i => (i.src || '').startsWith('http')).length;
                    const blobs = allImgs.filter(i => (i.src || '').startsWith('blob:')).length;
                    console.log(`⏳ [img poll] iter=${iteration} root=${root.id || 'doc'} png=${pngs} jpeg=${jpegs} http=${httpImgs} blob=${blobs} finais=${finalImgs.length}/${outputCount}`);
                }

                // Quando atingir o nÃºmero esperado E a primeira tiver src â€” baixar tudo
                if (finalImgs.length >= outputCount && finalImgs[0].src) {
                    console.log(`âœ… ${finalImgs.length} imagem(ns) finalizada(s)! Iniciando downloads...`);

                    const toDownload = finalImgs.slice(0, outputCount);

                    for (let i = 0; i < toDownload.length; i++) {
                        const src = toDownload[i].src;
                        if (!src) continue;

                        const letter = letters[i] || `_${i + 1}`;
                        // Filename exatamente igual Ã  extensÃ£o temp:
                        //   {promptIndex}_{safePromptName}_{letter}.jpg
                        const filename = `${promptIndex}_${safePromptName}_${letter}.jpg`;

                        console.log(`ðŸ“¥ Download [${i + 1}/${toDownload.length}]: ${filename}`);

                        try {
                            const result = await chrome.runtime.sendMessage({
                                type: 'DOWNLOAD_IMAGE',
                                url: src,
                                filename: filename,
                                prompt: prompt,
                                autoChangeFileName: true
                            });

                            if (result && result.success) {
                                console.log(`âœ… Download iniciado: ${filename} (id=${result.downloadId})`);
                            } else {
                                console.warn(`âš ï¸ Download falhou: ${result?.error || 'sem resposta'}`);
                            }
                        } catch (err) {
                            console.error(`âŒ Erro ao enviar DOWNLOAD_IMAGE:`, err);
                        }

                        if (i < toDownload.length - 1) await sleep(500);
                    }

                    automationState.imageDownloadInitiated = true;
                    return true;
                }

                await sleep(2000); // Polling a cada 2s â€” idÃªntico Ã  extensÃ£o temp
                iteration++;
            }

            console.warn('âš ï¸ Timeout (5min) aguardando imagens. Prosseguindo sem download.');
            return false;
        }

        /**
         * FunÃ§Ã£o principal do modo imagem â€” replica exatamente o fluxo da extensÃ£o temp.
         */

        async function waitAndDownloadVideo(promptIndex, prompt, sectionsBefore = -1) {
            console.log(`[waitAndDownloadVideo] Aguardando video... (prompt ${promptIndex + 1}) sectionsBefore=${sectionsBefore}`);
            const maxIterations = 150; // 5 min

            if (sectionsBefore < 0) {
                sectionsBefore = document.querySelectorAll('[id^="imagine-masonry-section"]').length;
            }

            let newSectionFound = false;
            for (let i = 0; i < 20; i++) {
                if (!automationState.isRunning) return false;
                const sectionsNow = document.querySelectorAll('[id^="imagine-masonry-section"]').length;
                if (sectionsNow > sectionsBefore) {
                    console.log(`OK Nova secao detectada (secao ${sectionsNow})`);
                    newSectionFound = true;
                    break;
                }
                await sleep(2000);
            }

            const now = new Date();
            const folderName = `${String(now.getDate()).padStart(2, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}`;
            const safePromptName = (prompt || 'video').replace(/\s+/g, '-').replace(/[^a-zA-Z0-9\-]/g, '').substring(0, 50);
            try {
                chrome.runtime.sendMessage({ action: 'SETUP_DOWNLOAD', folder: folderName, prefix: `${promptIndex + 1}_${safePromptName}_` });
            } catch (e) { }

            const findBtnByPath = (pathFragment) => {
                return Array.from(document.querySelectorAll('button, a')).find(el => {
                    const paths = Array.from(el.querySelectorAll('path, polyline, line'));
                    return Array.from(paths).some(p => (p.getAttribute('d') || p.getAttribute('points') || '').includes(pathFragment));
                });
            };

            let iteration = 0;
            while (iteration < maxIterations) {
                if (!automationState.isRunning) return false;
                // Se o MutationObserver jÃ¡ tiver baixado o vÃ­deo, podemos prosseguir
                if (automationState.downloadedVideos.has(promptIndex)) {
                    console.log(`OK [waitAndDownloadVideo] Video ${promptIndex + 1} ja baixado (via Observer), prosseguindo.`);
                    return true;
                }
                // No fluxo /imagine/more o video pode aparecer com source interno ou URL sem "generated_video".
                // Buscar em video + source e usar sinais de prontidao (readyState/duration/videoWidth).
                const allVideos = Array.from(document.querySelectorAll('video'));
                const videosFromSource = Array.from(document.querySelectorAll('video source[src]'))
                    .map(s => s.closest('video'))
                    .filter(Boolean);
                const uniqueVideos = Array.from(new Set([...allVideos, ...videosFromSource]));

                const readyVideos = uniqueVideos.filter(v => {
                    const src = v.currentSrc || v.src || v.querySelector('source')?.src || '';
                    if (!src || src.length < 16) return false;

                    const hasKnownVideoUrl = /blob:|generated_video|\.mp4|videodelivery|manifest|m3u8|video/i.test(src);
                    const hasPlaybackSignals = (v.readyState >= 2) || (Number.isFinite(v.duration) && v.duration > 0) || (v.videoWidth > 0);
                    return hasKnownVideoUrl || hasPlaybackSignals;
                });
                // Em /imagine/more o Grok pode mostrar cards de imagem enquanto prepara o vÃ­deo.
                // NÃ£o tratar isso como erro prematuro; manter polling atÃ© vÃ­deo aparecer ou timeout.

                if (iteration % 5 === 0) {
                    const sampleSrc = readyVideos[0] ? (readyVideos[0].currentSrc || readyVideos[0].src || '').slice(0, 120) : '';
                    console.log(`WAIT [video poll] iter=${iteration} ready=${readyVideos.length} path=${window.location.pathname} src="${sampleSrc}"`);
                    updateOverlay({ status: 'Gerando video...', prompt, index: promptIndex + 1, total: automationState.prompts.length });
                }

                if (readyVideos.length > 0) {
                    console.log(`OK Video pronto! Chamando processVideoElement (prompt ${promptIndex + 1})`);
                    await processVideoElement(readyVideos[0], promptIndex);
                    return true;
                }

                // Se ficar preso em /imagine/more sem detectar video, voltar para /imagine e tentar novamente pelo retry do item.
                if (iteration > 45 && window.location.pathname.includes('/imagine/more/')) {
                    console.warn('WARN Timeout parcial em /imagine/more sem video detectado. Voltando para /imagine para retentativa.');
                    await saveAutomationState();
                    window.location.href = 'https://grok.com/imagine';
                    return false;
                }
                await sleep(1000); // Polling mais rÃ¡pido (1s)
                iteration++;
            }
            return false;
        }

        function handleAutomationComplete() {
            console.log('ðŸ handleAutomationComplete chamado');
            const totalItems = automationState.mode === 'image-to-video'
                ? (automationState.imageQueue?.length || 0)
                : (automationState.prompts?.length || 0);

            const elapsed = automationState.startTime ? Math.max(0, Math.floor((Date.now() - automationState.startTime) / 1000)) : 0;
            const itemType = automationState.mode === 'image-to-video' ? 'imagens' : 'prompts';

            sendMessageToBackground({
                action: 'automationComplete',
                totalPrompts: totalItems
            });

            updateOverlay({
                status: 'ConcluÃ­do',
                prompt: `Todas as ${itemType} processadas`,
                index: totalItems,
                total: totalItems,
                elapsedSeconds: elapsed
            });

            resetAutomation({ keepOverlay: true, stopTimer: true });
            console.log('ðŸ AutomaÃ§Ã£o finalizada');
        }

        function resetAutomation(options = {}) {
            const { keepOverlay = false, stopTimer = true } = options;
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
                downloadedVideos: new Set(),
                processedVideoUrls: new Set(), // Added from override
                imageDownloadInitiated: false,
                awaitingImageCompletion: false,
                imageToVideoRetries: {},
                promptsSinceLastBreak: 0,
                isOnBreak: false,
                breakEndTime: null
            };

            clearAutomationState();
            if (stopTimer) stopOverlayTimer();
            if (!keepOverlay) clearOverlay();
            stopKeepAlive();
        }

        async function runAutomation() {
            if (!automationState.isRunning || !automationState.prompts || automationState.currentIndex >= automationState.prompts.length) {
                handleAutomationComplete();
                return;
            }

            const isImaginePage = window.location.pathname.includes('/imagine');
            if (!isImaginePage) {
                console.log('ðŸ”„ Redirecionando para /imagine...');
                await saveAutomationState();
                window.location.href = 'https://grok.com/imagine';
                return;
            }

            automationState.restoredFromReload = false;
            const currentPrompt = (automationState.prompts && automationState.prompts[automationState.currentIndex]) || '';
            let currentAspectRatio = null;
            if (automationState.settings?.randomize && automationState.settings?.aspectRatios?.length > 0) {
                currentAspectRatio = automationState.settings.aspectRatios[Math.floor(Math.random() * automationState.settings.aspectRatios.length)];
                console.log(`ðŸŽ² ProporÃ§Ã£o randomizada: ${currentAspectRatio}`);
            } else {
                currentAspectRatio = automationState.settings?.fixedRatio || (automationState.settings?.aspectRatio) || '3:2';
            }

            // --- ConfiguraÃ§Ãµes Iniciais do Modelo (DuraÃ§Ã£o, ResoluÃ§Ã£o, ProporÃ§Ã£o) ---
            if (automationState.mode === 'video' || !automationState.modeApplied) {
                await selectGenerationMode(automationState.mode);
                automationState.modeApplied = true;
                document.body.click();
                await sleep(500);

                if (automationState.mode === 'video' && automationState.settings?.videoDuration) {
                    await selectVideoDuration(automationState.settings.videoDuration);
                    await sleep(500);
                }
                if (automationState.mode === 'video') {
                    await selectResolution(automationState.settings?.resolution || '480p');
                    await sleep(500);
                }
            }

            // Aplicar ProporÃ§Ã£o SEMPRE, inclusive para vÃ­deo text-to
            if (currentAspectRatio) {
                console.log(`ðŸŽ° [Prompt ${automationState.currentIndex + 1}] ProporÃ§Ã£o alvo: ${currentAspectRatio}`);
                updateOverlay({
                    status: `Configurando ProporÃ§Ã£o [${currentAspectRatio}]...`,
                    prompt: currentPrompt,
                    index: automationState.currentIndex + 1,
                    total: automationState.prompts.length
                });
                await configureImageMode(currentAspectRatio);
                await sleep(500); // Aguardar estabilizaÃ§Ã£o apÃ³s config
            }

            updateOverlay({
                status: automationState.mode === 'video' ? 'Gerando vÃ­deo' : 'Gerando imagem',
                prompt: currentPrompt,
                index: automationState.currentIndex + 1,
                total: automationState.prompts.length
            });

            try {
                if (automationState.mode === 'image') {
                    // runImageModeStep agora recebe apenas index e prompt, ja que configuramos ratio acima
                    const outputCount = automationState.settings?.downloadAllImages
                        ? (automationState.settings?.downloadMultiCount || 4)
                        : 1;
                    const sectionsBefore = document.querySelectorAll('[id^="imagine-masonry-section"]').length;

                    updateOverlay({ status: 'Enviando prompt...', prompt: currentPrompt, index: automationState.currentIndex + 1, total: automationState.prompts.length });
                    await insertAndSubmitPromptImage(currentPrompt);

                    updateOverlay({ status: 'Gerando imagens...', prompt: currentPrompt, index: automationState.currentIndex + 1, total: automationState.prompts.length });
                    await waitAndDownloadImages(automationState.currentIndex, currentPrompt, outputCount, sectionsBefore);
                } else {
                    const sectionsBefore = document.querySelectorAll('[id^="imagine-masonry-section"]').length;
                    await insertAndSubmitPromptImage(currentPrompt);
                    await waitAndDownloadVideo(automationState.currentIndex, currentPrompt, sectionsBefore);
                }

                automationState.currentIndex++;
                automationState.promptsSinceLastBreak++;
                saveAutomationState();

                if (automationState.isRunning && automationState.currentIndex < automationState.prompts.length) {
                    if (automationState.settings?.breakEnabled && automationState.promptsSinceLastBreak >= (automationState.settings?.breakPrompts || 0)) {
                        const breakMs = (automationState.settings.breakDuration || 3) * 60 * 1000;
                        automationState.isOnBreak = true;
                        updateOverlay({ status: 'â˜• Pausa', prompt: `Descansando...`, index: automationState.currentIndex, total: automationState.prompts.length });
                        await sleep(breakMs);
                        automationState.isOnBreak = false;
                        automationState.promptsSinceLastBreak = 0;
                    }
                    const delaySeconds = automationState.settings?.promptDelaySeconds != null
                        ? parseInt(automationState.settings.promptDelaySeconds)
                        : (automationState.delay || 45);
                    const delayMs = Math.max(2, delaySeconds) * 1000;
                    console.log(`â±ï¸ Aguardando ${delayMs / 1000}s para o prÃ³ximo prompt...`);
                    await sleep(delayMs);

                    // Garantir ambiente limpo entre prompts: recarregar sempre em /imagine.
                    await saveAutomationState();
                    console.log('ðŸ”„ Voltando para /imagine para o prÃ³ximo prompt...');
                    window.location.href = 'https://grok.com/imagine';
                    return;
                } else {
                    handleAutomationComplete();
                }
            } catch (error) {
                console.error('âŒ Erro na automaÃ§Ã£o:', error);
                handleAutomationComplete();
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
                    console.log('âœ… Editor encontrado:', selector);
                    return editor;
                }
            }

            return null;
        }

        // Helper: Upload image to Grok via file input
        async function uploadImageToGrok(imageData, filename) {
            console.log('ðŸ“¤ Procurando input[type="file"] na pÃ¡gina...');

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
                console.log('âš ï¸ Input de arquivo nÃ£o encontrado, tentando clicar no botÃ£o Anexar...');
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
                                console.log('âœ… Menu item de upload encontrado, clicando...');
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
                throw new Error('Input de arquivo nÃ£o encontrado na pÃ¡gina');
            }

            console.log('âœ… Input de arquivo encontrado:', fileInput);

            // Convert base64 to File
            console.log('ðŸ’¾ Convertendo base64 para File...');
            const file = dataURLtoFile(imageData, filename);

            // Create DataTransfer and add file
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(file);

            // Set files on input
            fileInput.files = dataTransfer.files;

            // Dispatch change event to trigger upload
            console.log('ðŸš€ Disparando evento change no input...');
            const changeEvent = new Event('change', { bubbles: true });
            fileInput.dispatchEvent(changeEvent);

            // Also dispatch input event for React compatibility
            const inputEvent = new Event('input', { bubbles: true });
            Object.defineProperty(inputEvent, 'target', { writable: false, value: fileInput });
            fileInput.dispatchEvent(inputEvent);

            return true;
        }

        // Helper: Open attach menu and pick "Animate image" action (language-agnostic)
        async function openAttachAndChooseAnimateImage() {
            const findAttachButton = () => {
                const editor = findEditor();
                const scope = editor?.closest('form, [class*="query"], [class*="composer"], [class*="chat"]') || document;

                // Prefer attach button by stable icon path (plus inside image icon)
                const iconPathFragment = 'M19 17H22V19H19V22H17V19H14V17H17V14H19V17Z';
                const byIcon = Array.from(scope.querySelectorAll('button[aria-haspopup="menu"]')).find(btn =>
                    !!btn.querySelector(`path[d*="${iconPathFragment}"]`) && isVisible(btn) && !btn.disabled
                );
                if (byIcon) return byIcon;

                // Fallback by aria-label in common languages
                const byLabel = Array.from(scope.querySelectorAll('button[aria-haspopup="menu"]')).find(btn => {
                    const label = normalizeText(btn.getAttribute('aria-label') || '');
                    return (
                        label.includes('anex') || label.includes('attach') || label.includes('upload') ||
                        label.includes('adjuntar') || label.includes('joindre') || label.includes('anhang')
                    ) && isVisible(btn) && !btn.disabled;
                });
                if (byLabel) return byLabel;

                return null;
            };

            const findAnimateItem = (menu) => {
                const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
                if (!items.length) return null;

                const scored = items.map(item => {
                    const text = normalizeText(item.textContent || '');
                    let score = 0;

                    if (
                        (text.includes('anim') && (text.includes('imag') || text.includes('image') || text.includes('imagen') || text.includes('imagem'))) ||
                        (text.includes('video') && text.includes('transform'))
                    ) score += 10;

                    // Path fragment from your provided "Animar imagem" menu icon
                    if (item.querySelector('path[d*="M14.5 15.7158"]')) score += 8;

                    // Usually this item has title + subtitle
                    if (item.querySelectorAll('span').length >= 2) score += 2;

                    return { item, score };
                }).sort((a, b) => b.score - a.score);

                if (scored[0]?.score > 0) return scored[0].item;
                return null;
            };

            for (let attempt = 0; attempt < 4; attempt++) {
                const attachBtn = findAttachButton();
                if (!attachBtn) {
                    await sleep(350);
                    continue;
                }

                forceClick(attachBtn);
                await sleep(450);

                const triggerId = attachBtn.id;
                let menu = null;
                if (triggerId) {
                    menu = document.querySelector(`[role="menu"][data-state="open"][aria-labelledby="${triggerId}"]`);
                }
                if (!menu) {
                    menu = document.querySelector('[role="menu"][data-state="open"]');
                }
                if (!menu) {
                    await sleep(300);
                    continue;
                }

                const animateItem = findAnimateItem(menu);
                if (!animateItem) {
                    await sleep(250);
                    continue;
                }

                forceClick(animateItem);
                await sleep(600);
                console.log('âœ… AÃ§Ã£o de animar imagem selecionada no menu de anexo.');
                return true;
            }

            console.warn('âš ï¸ NÃ£o foi possÃ­vel selecionar a aÃ§Ã£o de animar imagem no menu de anexo.');
            return false;
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

            // Novo layout: radiogroup direto (ex.: +6s / +10s).
            const targetSeconds = String(targetDuration || '').replace(/[^\d]/g, '');
            for (let i = 0; i < 6; i++) {
                const durationGroup = findAllElements('[role="radiogroup"]')
                    .find(g => {
                        const label = normalizeText(g.getAttribute('aria-label') || '');
                        const text = normalizeText(g.textContent || '');
                        return label.includes('duracao') || label.includes('duration') || /[\+\s]?\d+s/.test(text);
                    });

                if (durationGroup) {
                    const buttons = Array.from(durationGroup.querySelectorAll('button[role="radio"], button'));
                    const targetBtn = buttons.find(btn => {
                        const txt = normalizeText(btn.textContent || '');
                        const digits = txt.replace(/[^\d]/g, '');
                        return digits && digits === targetSeconds;
                    });

                    if (targetBtn) {
                        if (targetBtn.getAttribute('aria-checked') === 'true') {
                            console.log(`✅ Duração ${targetDuration} já estava selecionada.`);
                            return true;
                        }
                        forceClick(targetBtn);
                        await sleep(450);
                        if (targetBtn.getAttribute('aria-checked') === 'true') {
                            console.log(`✅ Duração ${targetDuration} selecionada no radiogroup.`);
                            return true;
                        }
                    }
                }
                await sleep(250);
            }

            // Abrir o menu de configurações do modelo
            let trigger = null;
            for (let i = 0; i < 8; i++) {
                trigger = findModelOptionsTrigger();
                if (trigger) break;
                await sleep(300);
            }

            if (!trigger) {
                console.warn('âš ï¸ Trigger de modelo nÃ£o encontrado para selecionar duraÃ§Ã£o');
                return false;
            }

            if (trigger.getAttribute('aria-expanded') !== 'true') {
                console.log('ðŸ”” Abrindo menu de modelo...');
                forceClick(trigger);
                await sleep(700);
            }

            // Restringir estritamente ao menu aberto vinculado ao trigger para evitar cliques em elementos fora do painel.
            const openMenu = findOpenAspectMenuForTrigger(trigger);
            if (!openMenu) {
                console.warn('âš ï¸ Menu de configuraÃ§Ãµes nÃ£o abriu para selecionar duraÃ§Ã£o.');
                return false;
            }

            // Procurar o container que contém "Duração" ou botões 6s/10s apenas dentro do menu aberto
            const groupItems = Array.from(openMenu.querySelectorAll('[role="group"], [role="menuitem"], div'));
            let durationMenuItem = null;

            for (const item of groupItems) {
                const itemText = normalizeText(item.textContent);
                // Detectar pelo tÃ­tulo (multi-idioma) OU se contÃ©m botÃµes especÃ­ficos de tempo (6s, 10s)
                const hasDurationTitle = /duracao|duration|duraciÃ³n|tempo/i.test(itemText);
                const hasTimeButtons = item.querySelector('button[aria-label*="s"], button[aria-label*="s"]');

                if (hasDurationTitle || (hasTimeButtons && item.querySelectorAll('button').length >= 2)) {
                    durationMenuItem = item;
                    console.log('ðŸŽ¯ Container de duraÃ§Ã£o encontrado:', itemText.substring(0, 50));
                    break;
                }
            }

            if (!durationMenuItem) {
                console.warn('âš ï¸ Menu de duraÃ§Ã£o nÃ£o encontrado dentro do painel de configuraÃ§Ã£o.');
            }

            if (!durationMenuItem) {
                console.warn('âš ï¸ Menu de duraÃ§Ã£o realmente nÃ£o encontrado.');
                return false;
            }

            // Procurar botÃµes dentro do menuitem de duraÃ§Ã£o
            const durationButtons = durationMenuItem.querySelectorAll('button');
            console.log(`ðŸ” ${durationButtons.length} botÃµes de duraÃ§Ã£o encontrados`);

            if (durationButtons.length === 0) {
                console.warn('âš ï¸ Nenhum botÃ£o de duraÃ§Ã£o encontrado no menuitem');
                closeOpenMenusSafely();
                return false;
            }

            for (const btn of durationButtons) {
                const btnText = normalizeText(btn.textContent);
                const ariaLabel = btn.getAttribute('aria-label') || '';
                console.log(`  - BotÃ£o: "${btnText}" (aria-label: "${ariaLabel}")`);

                // Verificar se o botÃ£o corresponde Ã  duraÃ§Ã£o desejada
                const isMatch = possibleValues.some(val =>
                    btnText === val.toLowerCase() ||
                    ariaLabel === val ||
                    btnText.includes(val.toLowerCase())
                );

                if (isMatch) {
                    console.log(`âœ… DuraÃ§Ã£o ${targetDuration} encontrada, clicando...`);
                    console.log('ðŸ” BotÃ£o HTML:', btn.outerHTML.substring(0, 150));
                    forceClick(btn);
                    await sleep(1000); // Aguardar mais para a seleÃ§Ã£o ser aplicada

                    // Verificar se a duraÃ§Ã£o foi selecionada (botÃ£o deve ter classe ativa)
                    const isSelected = btn.classList.contains('text-primary') ||
                        btn.classList.contains('font-semibold') ||
                        btn.getAttribute('aria-pressed') === 'true';

                    console.log(`ðŸ“Š BotÃ£o selecionado: ${isSelected}`);

                    // Fechar menu sem clicar no body (evita abrir /imagine/more por clique acidental)
                    closeOpenMenusSafely();
                    await sleep(300);

                    return true;
                }
            }

            console.warn(`âš ï¸ DuraÃ§Ã£o ${targetDuration} nÃ£o encontrada entre os botÃµes`);
            console.log('ðŸ” BotÃµes disponÃ­veis:', Array.from(durationButtons).map(b => ({
                text: normalizeText(b.textContent),
                ariaLabel: b.getAttribute('aria-label'),
                classes: b.className
            })));

            closeOpenMenusSafely();
            await sleep(300);
            return false;
        }

        // Helper: Select Resolution
        async function selectResolution(targetResolution) {
            const target = targetResolution || '480p'; // default 480p
            console.log(`🎯 Selecionando resolução: ${target}`);

            // Novo layout: radiogroup direto na barra (480p/720p).
            for (let i = 0; i < 6; i++) {
                const resolutionGroup = findAllElements('[role="radiogroup"]')
                    .find(g => {
                        const label = normalizeText(g.getAttribute('aria-label') || '');
                        const text = normalizeText(g.textContent || '');
                        return label.includes('resolucao') || label.includes('resolution') || text.includes('480p') || text.includes('720p');
                    });

                if (resolutionGroup) {
                    const buttons = Array.from(resolutionGroup.querySelectorAll('button[role="radio"], button'));
                    const targetBtn = buttons.find(btn => normalizeText(btn.textContent || '') === normalizeText(target));

                    if (targetBtn) {
                        if (targetBtn.getAttribute('aria-checked') === 'true') {
                            console.log(`✅ Resolução ${target} já estava selecionada.`);
                            return true;
                        }

                        forceClick(targetBtn);
                        await sleep(450);
                        if (targetBtn.getAttribute('aria-checked') === 'true') {
                            console.log(`✅ Resolução ${target} selecionada no radiogroup.`);
                            return true;
                        }
                    }
                }
                await sleep(250);
            }

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
                console.log(`âœ… BotÃ£o de resoluÃ§Ã£o ${target} encontrado! Clicando...`);
                forceClick(btn);
                await sleep(500);
                return true;
            }

            console.warn(`âš ï¸ BotÃ£o de resoluÃ§Ã£o ${target} nÃ£o encontrado na interface principal.`);

            // Fallback: verificar somente no menu de configurações do modelo
            const trigger = findModelOptionsTrigger();

            if (trigger) {
                console.log('ðŸ” Verificando menu de modelo para resoluÃ§Ã£o...');
                forceClick(trigger);
                await sleep(1000);

                const openMenu = findOpenAspectMenuForTrigger(trigger);
                const menuButtons = openMenu ? findAllElements('button', openMenu) : [];
                btn = Array.from(menuButtons).find(b =>
                    normalizeText(b.textContent) === target ||
                    b.getAttribute('aria-label') === target
                );

                if (btn) {
                    console.log(`âœ… BotÃ£o de resoluÃ§Ã£o ${target} encontrado no menu! Clicando...`);
                    forceClick(btn);
                    await sleep(500);
                    closeOpenMenusSafely();
                    return true;
                }

                closeOpenMenusSafely();
            }

            return false;
        }

        async function runImageToVideoAutomation() {
            if (imageToVideoRunLock) {
                console.log('WARN [image-to-video] Execucao ja em andamento. Ignorando chamada duplicada.');
                return;
            }
            imageToVideoRunLock = true;
            let willNavigate = false;
            try {
                if (!automationState.isRunning || !automationState.imageQueue || automationState.currentImageIndex >= automationState.imageQueue.length) {
                    handleAutomationComplete();
                    return;
                }

                // Check if we're on a post page - redirect to /imagine if so (post pages have no editor)
                const isPostPage = window.location.pathname.includes('/imagine/post/');

                if (isPostPage) {
                    console.log(`RETRY [image-to-video] Redirecionando para /imagine pois pagina de post nao tem editor`);
                    await saveAutomationState();
                    willNavigate = true;
                    window.location.href = 'https://grok.com/imagine';
                    return;
                }

                // Sync global index for observers
                automationState.currentIndex = automationState.currentImageIndex;

                const currentImage = automationState.imageQueue[automationState.currentImageIndex];
                console.log(`ðŸ“¸ Processando imagem ${automationState.currentImageIndex + 1}/${automationState.imageQueue.length}: ${currentImage.name}`);

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
                        throw new Error(`Imagem ${currentImage.id} nÃ£o encontrada no storage`);
                    }

                    const imgData = storedImage[currentImage.id];

                    // ========== STEP 0: Insert Prompt Text (if provided) - BEFORE upload ==========
                    const imagePrompt = automationState.settings?.imagePrompt;

                    // Wait for UI to be ready - look for the contenteditable editor
                    let editor = findEditor();
                    let attempts = 0;
                    while (!editor && attempts < 10) {
                        console.log(`â³ Aguardando editor... tentativa ${attempts + 1}/10`);
                        await sleep(800);
                        editor = findEditor();
                        attempts++;
                    }

                    if (!editor) {
                        throw new Error('Editor nÃ£o encontrado na pÃ¡gina apÃ³s 10 tentativas');
                    }

                    // Insert prompt text BEFORE uploading image
                    if (imagePrompt && imagePrompt.trim()) {
                        console.log(`ðŸ“ Step 0: Inserindo prompt no editor antes do upload...`);
                        updateOverlay({
                            status: 'Inserindo prompt...',
                            prompt: imagePrompt,
                            index: automationState.currentImageIndex + 1,
                            total: automationState.imageQueue.length
                        });

                        simulateTyping(editor, imagePrompt);
                        console.log('âœ… Prompt inserido no editor');
                        await sleep(800);
                    } else {
                        console.log('â„¹ï¸ Nenhum prompt para inserir (campo vazio)');
                    }

                    // ========== STEP 1: Select Aspect Ratio (Randomized or Fixed) ==========
                    let currentRatio = automationState.settings?.fixedRatio || '3:2';
                    if (automationState.settings?.randomize && automationState.settings?.aspectRatios?.length > 0) {
                        currentRatio = automationState.settings.aspectRatios[Math.floor(Math.random() * automationState.settings.aspectRatios.length)];
                        console.log(`ðŸŽ² [image-to-video] Item ${automationState.currentImageIndex + 1} -> Ratio: ${currentRatio}`);
                    }

                    updateOverlay({
                        status: `Configurando ProporÃ§Ã£o [${currentRatio}]...`,
                        prompt: `Imagem: ${currentImage.name}`,
                        index: automationState.currentImageIndex + 1,
                        total: automationState.imageQueue.length
                    });

                    await configureImageMode(currentRatio);
                    await sleep(1000); // 1s para o Grok atualizar os parÃ¢metros internos

                    // ========== STEP 2: Video params (duraÃ§Ã£o + resoluÃ§Ã£o) ==========
                    // No fluxo image-to-video, o modo Ã© definido por "Anexar > Animar imagem".
                    // NÃ£o alternar "Modo de GeraÃ§Ã£o" aqui para evitar regressÃ£o para imagem.
                    const genMode = 'video';
                    if (automationState.settings?.videoDuration) {
                        console.log(`â±ï¸ Step 3: Selecionando duraÃ§Ã£o ${automationState.settings.videoDuration}...`);
                        updateOverlay({
                            status: `Configurando duraÃ§Ã£o ${automationState.settings.videoDuration}...`,
                            prompt: `Imagem: ${currentImage.name}`,
                            index: automationState.currentImageIndex + 1,
                            total: automationState.imageQueue.length
                        });

                        // Garantir que o menu esteja fechado antes de selecionar duraÃ§Ã£o
                        closeOpenMenusSafely();
                        await sleep(500);

                        const durationSuccess = await selectVideoDuration(automationState.settings.videoDuration);
                        console.log(`ðŸ“Š Resultado seleÃ§Ã£o duraÃ§Ã£o (image-to-video): ${durationSuccess ? 'SUCESSO' : 'FALHA'}`);
                        await sleep(1000);
                    }

                    // ========== STEP 3.5: Select Resolution ==========
                    const resolution = automationState.settings?.resolution || '480p';
                    console.log(`â±ï¸ Step 3.5: Selecionando resoluÃ§Ã£o ${resolution}...`);
                    updateOverlay({
                        status: `Configurando resoluÃ§Ã£o ${resolution}...`,
                        prompt: `Imagem: ${currentImage.name}`,
                        index: automationState.currentImageIndex + 1,
                        total: automationState.imageQueue.length
                    });
                    await selectResolution(resolution);
                    await sleep(800);

                    // ========== STEP 3.8: Attach -> Animate Image -> Upload ==========
                    console.log('ðŸ“Ž Step 3.8: Abrindo Anexar > Animar imagem...');
                    const animateMenuOk = await openAttachAndChooseAnimateImage();
                    if (!animateMenuOk) {
                        throw new Error('NÃ£o foi possÃ­vel abrir Anexar e selecionar Animar imagem.');
                    }

                    console.log('ðŸ“¤ Step 3.9: Fazendo upload da imagem...');
                    console.log(`ðŸ“Š Progresso: ${automationState.currentImageIndex + 1}/${automationState.imageQueue.length} - ${currentImage.name}`);
                    try {
                        await uploadImageToGrok(imgData.data, currentImage.name);
                        console.log('âœ… Upload iniciado no input file');
                    } catch (uploadError) {
                        console.error('âŒ Erro no upload:', uploadError);
                        throw uploadError;
                    }

                    updateOverlay({
                        status: 'Aguardando processamento...',
                        prompt: `Imagem: ${currentImage.name}`,
                        index: automationState.currentImageIndex + 1,
                        total: automationState.imageQueue.length
                    });
                    await sleep(2200);

                    // ========== STEP 4: Submit ==========
                    console.log('ðŸš€ Step 4: Enviando...');
                    updateOverlay({
                        status: 'Enviando para geraÃ§Ã£o...',
                        prompt: `Imagem: ${currentImage.name}`,
                        index: automationState.currentImageIndex + 1,
                        total: automationState.imageQueue.length
                    });

                    const sectionsBefore = document.querySelectorAll('[id^="imagine-masonry-section"]').length;

                    let submitClicked = false;
                    const submitBtn = findSubmitButton();
                    if (submitBtn && !submitBtn.disabled) {
                        const label = submitBtn.getAttribute('aria-label') || '';
                        console.log(`OK Botao Enviar encontrado (label="${label}"), clicando...`);
                        safeSubmitClick(submitBtn);
                        submitClicked = true;
                    }

                    if (!submitClicked) {
                        // Fallback: try Enter key on editor
                        const editor = findEditor();
                        if (editor) {
                            console.log('âŒ¨ï¸ Tentando enviar com Enter no editor...');
                            editor.focus();
                            editor.dispatchEvent(new KeyboardEvent('keydown', {
                                bubbles: true, cancelable: true, key: 'Enter', code: 'Enter'
                            }));
                        }
                    }

                    // ========== STEP 5: Wait for Generation ==========
                    console.log(`â³ Step 5: Aguardando geraÃ§Ã£o de ${genMode}...`);
                    updateOverlay({
                        status: `Gerando ${genMode}...`,
                        prompt: `Imagem: ${currentImage.name}`,
                        index: automationState.currentImageIndex + 1,
                        total: automationState.imageQueue.length
                    });

                    if (genMode === 'video') {
                        const videoOk = await waitAndDownloadVideo(automationState.currentImageIndex, currentImage.name, sectionsBefore);
                        if (!videoOk) {
                            throw new Error('VÃ­deo nÃ£o finalizou dentro do tempo esperado.');
                        }
                    } else {
                        const outputCount = automationState.settings?.downloadMultiCount || 4;
                        await waitAndDownloadImages(automationState.currentImageIndex, currentImage.name, outputCount, sectionsBefore);
                    }

                    // ========== STEP 6: Next Image ==========
                    console.log('â­ï¸ AvanÃ§ando para prÃ³xima imagem...');
                    if (!automationState.imageToVideoRetries) automationState.imageToVideoRetries = {};
                    automationState.imageToVideoRetries[automationState.currentImageIndex] = 0;
                    automationState.currentImageIndex++;
                    await saveAutomationState();

                    // Sempre voltar para /imagine entre itens (somente lÃ¡ existe o fluxo de upload)
                    const waitDelay = Math.max(3, Math.min(automationState.delay, 10));
                    console.log(`â±ï¸ Aguardando ${waitDelay}s e voltando para /imagine...`);
                    updateOverlay({
                        status: 'Voltando para /imagine...',
                        prompt: `Delay: ${waitDelay}s...`,
                        index: automationState.currentImageIndex,
                        total: automationState.imageQueue.length
                    });

                    await sleep(waitDelay * 1000);
                    willNavigate = true;
                    window.location.href = 'https://grok.com/imagine';
                    return;

                } catch (error) {
                    console.error('âŒ Erro:', error);
                    if (!automationState.imageToVideoRetries) automationState.imageToVideoRetries = {};
                    const currentIdx = automationState.currentImageIndex;
                    const retries = (automationState.imageToVideoRetries[currentIdx] || 0) + 1;
                    automationState.imageToVideoRetries[currentIdx] = retries;

                    if (retries >= 3) {
                        console.warn(`âš ï¸ Item ${currentIdx + 1} falhou ${retries}x. Pulando para o prÃ³ximo.`);
                        automationState.imageToVideoRetries[currentIdx] = 0;
                        automationState.currentImageIndex++;
                    } else {
                        console.warn(`ðŸ” Repetindo item ${currentIdx + 1} (tentativa ${retries}/3)...`);
                    }
                    await saveAutomationState();

                    console.log('ðŸ”„ Erro no item atual. Voltando para /imagine em 5s...');
                    setTimeout(() => {
                        window.location.href = 'https://grok.com/imagine';
                    }, 5000);
                }
            } finally {
                if (!willNavigate) {
                    imageToVideoRunLock = false;
                }
            }
        }

        // --- Listeners ---
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            if (request.action === 'ping') {
                sendResponse({ status: 'ready' });
                return true;
            }

            if (request.action === 'startAutomation') {
                console.log('ðŸ“¨ Mensagem startAutomation recebida:', request);

                if (automationState.isRunning) {
                    sendResponse({ status: 'already_running' });
                    return true;
                }

                // Extract config from request
                const config = request.config || request;

                console.log('âš™ï¸ Config extraÃ­do:', config);

                // Validate prompts
                if (!config.prompts || config.prompts.length === 0) {
                    console.error('âŒ Nenhum prompt fornecido!');
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
                    console.log('â„¹ï¸ ResoluÃ§Ã£o 720p selecionada: Upscale desabilitado automaticamente.');
                }
                automationState.mode = config.mode || 'image';
                automationState.modeApplied = false;
                automationState.currentIndex = 0;
                automationState.startTime = Date.now();
                automationState.upscaledPrompts = new Set();
                automationState.processingPrompts = new Set();
                automationState.downloadedVideos = new Set();
                automationState.processedVideoUrls = new Set();
                automationState.imageDownloadInitiated = false;
                automationState.awaitingImageCompletion = false;
                automationState.imageToVideoRetries = {};
                automationState.promptsSinceLastBreak = 0;
                automationState.isOnBreak = false;
                automationState.breakEndTime = null;

                console.log('ðŸš€ AutomaÃ§Ã£o iniciada!', {
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
                console.log('ðŸ“¨ Mensagem startImageToVideo recebida:', request);

                if (automationState.isRunning) {
                    sendResponse({ status: 'already_running' });
                    return true;
                }

                const config = request.config || request;

                console.log('âš™ï¸ Config Image-to-Video extraÃ­do:', config);

                // Load image queue from storage
                chrome.storage.local.get(['automationQueue'], async (result) => {
                    const queue = result.automationQueue || [];

                    if (queue.length === 0) {
                        console.error('âŒ Fila de imagens vazia!');
                        sendResponse({ status: 'error', message: 'Nenhuma imagem na fila' });
                        return;
                    }

                    console.log(`ðŸ“¸ ${queue.length} imagens na fila para processar`);

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
                        imagePrompt: config.imagePrompt || '', // Prompt para enviar com as imagens
                        generationMode: 'video'
                    };

                    // Force disable upscale if resolution is 720p
                    if (automationState.settings.resolution === '720p') {
                        automationState.settings.upscale = false;
                        console.log('â„¹ï¸ ResoluÃ§Ã£o 720p selecionada: Upscale desabilitado automaticamente.');
                    }
                    automationState.mode = 'image-to-video';
                    automationState.modeApplied = false;
                    automationState.currentIndex = 0;
                    automationState.startTime = Date.now();
                    automationState.processedVideoUrls = new Set();
                    automationState.imageDownloadInitiated = false;
                    automationState.awaitingImageCompletion = false;
                    automationState.promptsSinceLastBreak = 0;
                    automationState.isOnBreak = false;
                    automationState.breakEndTime = null;

                    console.log('ðŸš€ AutomaÃ§Ã£o Image-to-Video iniciada!', {
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
                sendMessageToBackground({ action: 'updateStatus', message: 'AutomaÃ§Ã£o interrompida', type: 'stopped' });
                sendResponse({ status: 'stopped' });
                return true;
            }

            if (request.action === 'resetQueue') {
                resetAutomation();
                sendMessageToBackground({ action: 'updateStatus', message: 'Fila zerada e automaÃ§Ã£o parada', type: 'stopped' });
                sendResponse({ status: 'reset' });
                return true;
            }

            if (request.action === 'clearState') {
                console.log('ðŸ§¹ Limpando estado de automaÃ§Ã£o manualmente...');
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

        async function processVideoElement(video, promptIndex = null) {
            let currentPromptIndex;
            if (promptIndex !== null) {
                currentPromptIndex = promptIndex;
            } else if (automationState.mode === 'image-to-video') {
                currentPromptIndex = automationState.currentImageIndex;
            } else {
                currentPromptIndex = Math.max(0, (automationState.processedVideoUrls?.size || 0) - 1);
            }

            const shouldUpscale = automationState.settings?.upscale;
            const promptText = (automationState.prompts && automationState.prompts[currentPromptIndex]) || '';

            console.log(`ðŸ” [processVideoElement] Ãndice: ${currentPromptIndex}, Upscale: ${shouldUpscale}, Modo: ${automationState.mode}`);

            if (video.dataset.gpaVideoProcessed === 'true' || automationState.processingPrompts.has(currentPromptIndex) || automationState.downloadedVideos.has(currentPromptIndex)) {
                console.log(`â­ï¸ [processVideoElement] Prompt ${currentPromptIndex} jÃ¡ estÃ¡ sendo processado ou baixado. Ignorando.`);
                return;
            }

            // Lock synchronously
            video.dataset.gpaVideoProcessed = 'true';
            automationState.processingPrompts.add(currentPromptIndex);

            // Show status in overlay if upscaling
            if (shouldUpscale) {
                updateOverlay({
                    status: 'Upscale do vÃ­deo...',
                    prompt: promptText.substring(0, 40) + '...',
                    index: currentPromptIndex + 1,
                    total: automationState.prompts.length
                });
            }

            try {
                if (shouldUpscale) {
                    if (automationState.upscaledPrompts.has(currentPromptIndex)) {
                        return;
                    }

                    const result = await upscaleVideo(video);
                    if (result.success) {
                        automationState.upscaledPrompts.add(currentPromptIndex);
                        if (result.method === 'extension' && result.url) {
                            await triggerDownload(result.url, 'video', currentPromptIndex);
                        } else {
                            console.log('âš ï¸ URL de upscale nÃ£o acessÃ­vel, usando src do vÃ­deo.');
                            await triggerDownload(video.src, 'video', currentPromptIndex);
                        }
                    } else {
                        console.log('âš ï¸ Upscale falhou, baixando vÃ­deo SD.');
                        await triggerDownload(video.src, 'video', currentPromptIndex);
                    }
                } else {
                    await sleep(2000); // Wait for UI stability
                    if (!automationState.downloadedVideos.has(currentPromptIndex)) {
                        console.log('ðŸ“¥ Baixando vÃ­deo SD via direct link.');
                        await triggerDownload(video.src, 'video', currentPromptIndex);
                    }
                }

                // Check Completion
                const totalPrompts = automationState.mode === 'image-to-video'
                    ? (automationState.imageQueue?.length || 0)
                    : (automationState.prompts?.length || 0);

                if (currentPromptIndex >= totalPrompts - 1) {
                    console.log('ðŸ Processamento final concluÃ­do.');
                }
            } catch (error) {
                console.error('âŒ Erro no processVideoElement:', error);
            } finally {
                automationState.processingPrompts.delete(currentPromptIndex);
                console.log(`ðŸ”“ Lock removido para prompt ${currentPromptIndex}.`);
            }
        }

        // --- Helper to handle "Which video do you prefer?" popup ---
        function handlePreferencePopup() {
            // Look for the "Ignore" button in the specific popup structure
            // Context: h3 "Qual vÃ­deo..." -> p -> button "Ignorar"
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
                console.log('ðŸ›‘ Popup "Qual vÃ­deo vocÃª prefere" detectado. Clicando em Ignorar...');
                forceClick(ignoreButton);
                return true;
            }
            return false;
        }

        // Flag para evitar downloads duplicados simultÃ¢neos
        let isDownloadingAllImages = false;


        // Retorna a Ãšltima seÃ§Ã£o da masonry (mais recente) â€” igual ao .last() da extensÃ£o temp.
        // O Grok cria uma nova seÃ§Ã£o por prompt: #imagine-masonry-section-0, -1, -2...
        // Sempre usar a Ãºltima para nÃ£o pegar imagens antigas.
        function getMasonryRoot() {
            const sections = document.querySelectorAll('[id^="imagine-masonry-section"]');
            if (sections.length > 0) return sections[sections.length - 1]; // .last() da temp
            // Fallback: procurar container de masonry genÃ©rico
            return document.querySelector('[data-testid="masonry"], .masonry-grid, #imagine-masonry-section-0') || document;
        }

        function markExistingMasonryItemsAsProcessed() {
            const root = getMasonryRoot();
            const items = root.querySelectorAll('div[role="list"] > div[role="listitem"]');
            items.forEach(item => {
                item.dataset.gpaImageProcessed = 'true';
                item.dataset.gpaAllImagesProcessed = 'true';
            });
            console.log(`ðŸ§¹ Itens antigos marcados como processados: ${items.length}`);
        }

        function getGeneratedImageFromListItem(item) {
            if (!item || item.getAttribute('role') !== 'listitem') return null;

            // Aceitar apenas imagens geradas da masonry principal
            const candidates = Array.from(item.querySelectorAll('img[alt="Generated image"][src^="data:image/"]'));
            if (!candidates.length) return null;

            // Escolher a maior imagem visÃ­vel para evitar Ã­cones/miniaturas
            const best = candidates
                .filter(img => isVisible(img))
                .sort((a, b) => {
                    const areaA = (a.naturalWidth || a.clientWidth || 0) * (a.naturalHeight || a.clientHeight || 0);
                    const areaB = (b.naturalWidth || b.clientWidth || 0) * (b.naturalHeight || b.clientHeight || 0);
                    return areaB - areaA;
                })[0];

            if (!best) return null;
            const width = best.naturalWidth || best.clientWidth || 0;
            const height = best.naturalHeight || best.clientHeight || 0;
            if (width < 120 || height < 120) return null;

            return best;
        }

        function getListItemImageStatus(item) {
            const image = getGeneratedImageFromListItem(item);
            if (!image || !image.src) {
                return { hasImage: false, isPlaceholder: false, isFinal: false, srcLength: 0, src: '' };
            }

            const src = image.src;
            const isDataImage = src.startsWith('data:image/');
            const isPng = src.startsWith('data:image/png');
            const isFinal = isDataImage && src.length >= FINAL_IMAGE_SRC_MIN_LENGTH;

            return {
                hasImage: true,
                isPlaceholder: isPng,
                isFinal,
                srcLength: src.length,
                src
            };
        }

        async function waitForCurrentImageFinalization(timeoutMs) {
            // Mesma lÃ³gica da extensÃ£o de referÃªncia (temp):
            // Faz polling a cada 2s procurando imagens data:image com src.length >= 130000
            // NÃƒO usa MutationObserver para src (que interferiria com a geraÃ§Ã£o do Grok)
            const start = Date.now();
            let lastLogAt = 0;
            const maxImages = automationState.settings?.downloadAllImages
                ? (automationState.settings?.downloadMultiCount || 4)
                : 1;

            while (Date.now() - start < timeoutMs) {
                if (!automationState.isRunning) return false;
                if (automationState.imageDownloadInitiated) return true;

                // Buscar direto as imagens finalizadas na masonry (src data:image/jpeg = final)
                // PNG = placeholder/borrado, JPEG = imagem concluÃ­da
                const root = getMasonryRoot();
                const allImgs = Array.from(root.querySelectorAll('img[alt="Generated image"]'));
                const finalImgs = allImgs.filter(img => {
                    const src = img.src || '';
                    return src.startsWith('data:image/jpeg') && src.length >= FINAL_IMAGE_SRC_MIN_LENGTH;
                });

                const now = Date.now();
                if (now - lastLogAt >= 3000) {
                    console.log(`â³ Aguardando imagens JPEG: ${finalImgs.length}/${maxImages} finalizadas`);
                    lastLogAt = now;
                }

                if (finalImgs.length >= maxImages) {
                    console.log(`âœ… ${finalImgs.length} imagem(ns) finalizada(s) detectada(s) via polling!`);
                    return true;
                }

                await sleep(2000); // Polling a cada 2s, igual Ã  extensÃ£o de referÃªncia
            }

            return false;
        }

        // FunÃ§Ã£o para baixar todas as imagens vÃ¡lidas de uma vez
        async function downloadAllImagesFromItems() {
            if (!automationState.isRunning || !automationState.settings?.downloadAllImages) return;
            if (isDownloadingAllImages) {
                console.log('â³ Download de todas as imagens jÃ¡ em andamento, ignorando...');
                return;
            }

            isDownloadingAllImages = true;

            try {
                // Obter o Ã­ndice do prompt atual
                // Usar lastPromptSentIndex se disponÃ­vel, senÃ£o calcular baseado em currentIndex
                const currentPromptIdx = automationState.lastPromptSentIndex >= 0
                    ? automationState.lastPromptSentIndex
                    : Math.max(0, automationState.currentIndex - 1);
                const currentPrompt = automationState.prompts[currentPromptIdx];

                if (!currentPrompt) {
                    console.log('âš ï¸ Prompt atual nÃ£o encontrado, cancelando download...');
                    isDownloadingAllImages = false;
                    return;
                }

                const masonryRoot = getMasonryRoot();
                const allItems = Array.from(masonryRoot.querySelectorAll('div[role="list"] > div[role="listitem"]:not([data-gpa-all-images-processed="true"])'));
                if (allItems.length === 0) {
                    isDownloadingAllImages = false;
                    return;
                }

                console.log(`ðŸ–¼ï¸ Modo 'Baixar Todas': Prompt[${currentPromptIdx}] "${currentPrompt.substring(0, 30)}..." - Verificando ${allItems.length} itens...`);

                // FunÃ§Ã£o para verificar se a imagem Ã© vÃ¡lida
                function checkImageValid(item) {
                    const image = getGeneratedImageFromListItem(item);
                    if (!image || !image.src) return null;

                    const src = image.src;
                    const isDataImage = src.startsWith('data:image/');
                    const isPng = src.startsWith('data:image/png');
                    const hasFinalLength = src.length >= FINAL_IMAGE_SRC_MIN_LENGTH;

                    const base64Length = src.split(',')[1]?.length || 0;
                    const approxSizeBytes = base64Length * 0.75;
                    const approxSizeKB = approxSizeBytes / 1024;

                    return {
                        valid: isDataImage && hasFinalLength && !isPng, // PNG = placeholder, nunca baixar
                        isPlaceholder: isPng,
                        isJpeg: src.startsWith('data:image/jpeg') || src.startsWith('data:image/jpg'),
                        isWebp: src.startsWith('data:image/webp'),
                        sizeKB: approxSizeKB,
                        src: src,
                        item: item
                    };
                }

                // Verificar se jÃ¡ atingimos o limite de downloads para este prompt
                const maxImagesPerPrompt = automationState.settings?.downloadMultiCount || 4;
                const alreadyDownloaded = automationState.imagesDownloadedCount || 0;
                if (alreadyDownloaded >= maxImagesPerPrompt) {
                    console.log(`âœ… Limite de ${maxImagesPerPrompt} imagens jÃ¡ atingido para este prompt.`);
                    isDownloadingAllImages = false;
                    return;
                }

                console.log(`ðŸ“Š Limite de imagens configurado: ${maxImagesPerPrompt}, jÃ¡ baixadas: ${alreadyDownloaded}`);

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

                        console.log(`â¬‡ï¸ Baixando imagem ${imageNumber}: ${check.sizeKB.toFixed(1)}KB | Prompt[${currentPromptIdx}]: "${promptName.substring(0, 30)}..." [${imageNumber}/${maxImagesPerPrompt}]`);
                        await sleep(350);

                        // Revalidar depois de alguns ms para evitar baixar placeholder em transiÃ§Ã£o
                        const recheck = checkImageValid(item);
                        if (!recheck || !recheck.valid || recheck.isPlaceholder) {
                            console.log(`â³ Item ${i}: ainda em transiÃ§Ã£o apÃ³s espera curta, pulando por agora...`);
                            continue;
                        }
                        item.dataset.gpaAllImagesProcessed = 'true';
                        automationState.imagesDownloadedCount = downloadedCount + 1;

                        // Usar triggerDownload com sufixo para mÃºltiplas imagens do mesmo prompt
                        // Temporariamente modificar o prompt para incluir nÃºmero da imagem
                        const originalPrompt = automationState.prompts[currentPromptIdx];
                        automationState.prompts[currentPromptIdx] = `${originalPrompt}_${imageNumber}`;
                        await triggerDownload(check.src, 'image', currentPromptIdx);
                        // Restaurar prompt original
                        automationState.prompts[currentPromptIdx] = originalPrompt;

                        downloadedCount++;

                        // Pequeno delay entre downloads para nÃ£o sobrecarregar
                        await sleep(300);
                    } else if (check.isPlaceholder) {
                        console.log(`â³ Item ${i}: Placeholder PNG (${check.sizeKB.toFixed(1)}KB), aguardando...`);
                    } else {
                        console.log(`â³ Item ${i}: Imagem muito pequena (${check.sizeKB.toFixed(1)}KB), aguardando...`);
                    }
                }

                if (downloadedCount > 0) {
                    console.log(`âœ… ${downloadedCount} imagens baixadas no modo 'Todas' do prompt[${currentPromptIdx}]`);
                }
                if (downloadedCount >= maxImagesPerPrompt) {
                    console.log(`âœ… Todas as ${maxImagesPerPrompt} imagens do prompt atual baixadas.`);
                }
                // Marcar que o download foi iniciado para este prompt
                automationState.imageDownloadInitiated = true;
            } finally {
                isDownloadingAllImages = false;
            }
        }

        function handleImageGeneration(mutations) {
            if (!automationState.isRunning) return;

            // Observer agora sÃ³ dispara para childList (sem attributes).
            // Imagens: detecÃ§Ã£o via polling em waitForCurrentImageFinalization.
            // VÃ­deos: detectados quando o elemento <video> Ã© adicionado ao DOM.
            const hasAddedNodes = mutations.some(m => m.type === 'childList' && m.addedNodes.length > 0);
            if (!hasAddedNodes) return;

            // Check for preference popup on every mutation
            handlePreferencePopup();

            // --- Modo Baixar Todas as Imagens ---
            if (automationState.mode === 'image' && automationState.settings?.downloadAllImages && automationState.settings?.autoDownload) {
                downloadAllImagesFromItems();
                return; // NÃ£o executar o modo de imagem Ãºnica
            }

            // --- Image Mode (Ãºnica imagem) ---
            // Download agora tratado por polling direto em runAutomation apÃ³s waitForCurrentImageFinalization.


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
                                    console.log('ðŸŽ¬ VÃ­deo gerado detectado:', videoUrl);
                                    // Calcular Ã­ndice correto antes de chamar processVideoElement
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
                        console.log('ðŸŽ¬ VÃ­deo atualizado detectado:', videoUrl);
                        // Calcular Ã­ndice correto antes de chamar processVideoElement
                        const videoIndex = automationState.mode === 'image-to-video'
                            ? automationState.currentImageIndex
                            : Math.max(0, automationState.processedVideoUrls.size - 1);
                        processVideoElement(target, videoIndex);
                    }
                }
            }
        }


        function initialize() {
            const observer = new MutationObserver(handleImageGeneration);
            // Observar APENAS novos nÃ³s (childList) - NÃƒO observar atributos src.
            // O Grok atualiza o src de imagens progressivamente durante a geraÃ§Ã£o,
            // o que causava milhares de callbacks no observer e interferia na geraÃ§Ã£o.
            // A detecÃ§Ã£o de imagem finalizada agora Ã© feita por polling (waitForCurrentImageFinalization).
            // Apenas vÃ­deos precisam do observer (detectados por childList quando o <video> Ã© adicionado ao DOM).
            observer.observe(document.body, {
                childList: true,
                subtree: true
                // SEM attributes: true - crucial para nÃ£o interferir com geraÃ§Ã£o de imagens
            });
            sendMessageToBackground({ action: 'contentScriptReady' });
            loadAutomationState();
            console.log('ðŸš€ Grok Prompt Automator carregado!');
        }

        if (document.readyState === 'complete') {
            initialize();
        } else {
            window.addEventListener('load', initialize);
        }
    } catch (e) {
        console.error('Fatal initialization error:', e);
    }
})();


