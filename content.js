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

        function findAspectRatioOption(targetRatio) {
            const normalizedTarget = normalizeAspectRatio(targetRatio);
            if (!normalizedTarget) return null;

            // 1. Tentar busca global primeiro (caso os botões estejam expostos na barra lateral/ferramentas)
            const allButtons = Array.from(document.querySelectorAll('button'));
            const directMatch = allButtons.find(btn => {
                const aria = btn.getAttribute('aria-label') || '';
                const text = btn.textContent || '';
                return (normalizeAspectRatio(aria) === normalizedTarget || normalizeAspectRatio(text) === normalizedTarget) && isVisible(btn);
            });
            if (directMatch) return directMatch;

            // 2. Se não achou direto, procurar em menus abertos
            const openMenus = findAllElements('[role="menu"][data-state="open"], [data-radix-menu-content][data-state="open"]');
            for (const menu of openMenus) {
                const option = Array.from(menu.querySelectorAll('button')).find(btn => {
                    const aria = btn.getAttribute('aria-label') || '';
                    const text = btn.textContent || '';
                    return normalizeAspectRatio(aria) === normalizedTarget || normalizeAspectRatio(text) === normalizedTarget;
                });
                if (option) return option;
            }

            return null;
        }

        function isAspectRatioSelected(optionButton) {
            if (!optionButton) return false;

            // 1. Atributos padrão ARIA
            if (optionButton.getAttribute('aria-checked') === 'true' ||
                optionButton.getAttribute('aria-selected') === 'true' ||
                optionButton.dataset.state === 'on') return true;

            // 2. Classes de estilo do Grok (Texto e Fundo Primário)
            const hasPrimaryText = !!optionButton.querySelector('.text-primary, [class*="text-primary"]');
            const hasPrimaryBg = !!optionButton.querySelector('.bg-primary, [class*="bg-primary"]');
            const hasFontSemibold = !!optionButton.querySelector('.font-semibold');

            // 3. Checar o próprio botão
            const btnClasses = optionButton.className || '';
            const isPrimaryBtn = btnClasses.includes('text-primary') || btnClasses.includes('bg-primary');

            // No HTML que você enviou, o botão ativo tem text-primary e font-semibold
            return (hasPrimaryText && hasFontSemibold) || hasPrimaryBg || isPrimaryBtn;
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
            console.log(`🎯 [selectGenerationMode] Alvo: ${mode}`);

            // ── 1. Encontrar o Trigger (Botão que abre o menu) ───────────────────
            let trigger = null;
            for (let i = 0; i < 15; i++) {
                // Estratégia multi-idioma e multi-page (Imagine vs Chat)
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
                console.warn('⚠️ Trigger de modo não encontrado. Tentando prosseguir...');
                return true;
            }

            // ── 2. Tentar abrir o menu e selecionar o item ─────────────────────
            for (let attempt = 0; attempt < 3; attempt++) {
                if (trigger.getAttribute('aria-expanded') !== 'true') {
                    forceClick(trigger);
                    await sleep(800);
                }

                // Detectar o container do menu
                const modeGroup = Array.from(document.querySelectorAll('[role="group"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]'))
                    .find(el => el.querySelectorAll('[role="menuitemradio"]').length >= 2);

                if (!modeGroup) {
                    console.warn(`⏳ Menu de modo não detectado (t- ${attempt + 1}/3).`);
                    forceClick(trigger); // Tentar clicar novamente para forçar abertura
                    await sleep(1000);
                    continue;
                }

                const items = Array.from(modeGroup.querySelectorAll('[role="menuitemradio"]'));
                console.log(`📋 Encontrados ${items.length} itens no menu de modo.`);

                let targetBtn = null;
                if (mode === 'video') {
                    // Prioridade: SVG Path de vídeo (Câmera)
                    targetBtn = items.find(el => {
                        const d = Array.from(el.querySelectorAll('path')).map(p => p.getAttribute('d') || '').join(' ');
                        return d.includes('M22.5 19') || d.includes('M18.375') || d.includes('M16.5 8.5V15.5');
                    }) || items[1]; // Fallback: index 1 é vídeo
                } else {
                    // Prioridade: SVG Path de imagem (Paisagem)
                    targetBtn = items.find(el => {
                        const d = Array.from(el.querySelectorAll('path')).map(p => p.getAttribute('d') || '').join(' ');
                        return d.includes('M14.0996') || d.includes('M4.50586') || d.includes('M15 7C13');
                    }) || items[0]; // Fallback: index 0 é imagem
                }

                if (targetBtn) {
                    const isSelected = targetBtn.getAttribute('aria-checked') === 'true';
                    if (!isSelected) {
                        console.log(`✅ Aplicando modo: ${mode}`);
                        forceClick(targetBtn);
                        await sleep(600);
                    }
                    document.body.click(); // Fechar menu
                    await sleep(300);
                    return true;
                }
            }

            console.warn('⚠️ Não foi possível garantir a seleção do modo.');
            document.body.click();
            return true;
        }


        async function selectAspectRatio(aspectRatio) {
            const target = normalizeAspectRatio(aspectRatio);
            if (!target) return false;

            console.log(`🎯 Tentando selecionar proporção: ${target}`);

            // 1. Tentar seleção direta primeiro (sem abrir menu)
            const directOption = findAspectRatioOption(target);
            if (directOption && isVisible(directOption)) {
                if (isAspectRatioSelected(directOption)) {
                    console.log(`✅ Proporção ${target} já selecionada.`);
                    return true;
                }
                console.log(`🖱️ Clicando diretamente no botão de proporção ${target}`);
                forceClick(directOption);
                await sleep(500);
                if (isAspectRatioSelected(directOption)) return true;
            }

            // 2. Se falhou direto, tentar via menu de opções do modelo
            for (let i = 0; i < 3; i++) {
                const trigger = findModelOptionsTrigger();
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

                const option = Array.from(menu.querySelectorAll('button')).find(btn => {
                    const aria = btn.getAttribute('aria-label') || '';
                    const text = btn.textContent || '';
                    return normalizeAspectRatio(aria) === target || normalizeAspectRatio(text) === target;
                });

                if (option) {
                    if (isAspectRatioSelected(option)) {
                        console.log(`✅ [Menu] Proporção ${target} já selecionada.`);
                        document.body.click();
                        return true;
                    }
                    forceClick(option);
                    await sleep(500);
                    document.body.click();
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

            console.log(`📥 [triggerDownload] type=${type}, actualIndex=${actualIndex}, mode=${automationState.mode}`);

            // Bloqueio Síncrono Imediato
            if (type === 'video') {
                if (automationState.downloadedVideos.has(actualIndex)) {
                    console.log(`✅ [triggerDownload] Já marcado como baixado para índice ${actualIndex}, abortando.`);
                    return;
                }
                automationState.downloadedVideos.add(actualIndex);
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

            const sendToBackground = async (finalUrl) => {
                console.log(`🚀 [triggerDownload] Enviando para background: ${filename}`);
                try {
                    const response = await new Promise((resolve) => {
                        chrome.runtime.sendMessage({
                            action: 'DOWNLOAD_IMAGE',
                            type: 'DOWNLOAD_IMAGE',
                            url: finalUrl,
                            filename: filename,
                            prompt: promptText,
                            savePromptTxt: automationState.settings?.savePromptTxt || false
                        }, (resp) => {
                            if (chrome.runtime.lastError) {
                                console.warn(`⚠️ [triggerDownload] Erro:`, chrome.runtime.lastError.message);
                                resolve(null);
                            } else {
                                resolve(resp);
                            }
                        });
                    });
                    if (response && response.success) {
                        console.log(`✅ [triggerDownload] Resposta do background:`, response);
                    }
                } catch (error) {
                    console.error('❌ Erro no triggerDownload:', error);
                }
            };

            // Se o vídeo vier como blob:, converte para data URL para o background script ter acesso
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
                    await sendToBackground(dataUrl);
                } catch (err) {
                    console.warn('⚠️ Falha ao converter blob, tentando URL original...', err);
                    await sendToBackground(url);
                }
            } else {
                await sendToBackground(url);
            }
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
                            console.warn(`⚠️ Falha ao aplicar aspect ratio ${aspectRatio} (tentativa ${attempt + 1}/2).`);
                            await sleep(300);
                        }
                    }

                    if (!aspectApplied) {
                        throw new Error(`Não foi possível aplicar a proporção ${aspectRatio} antes do envio.`);
                    }
                }

                const submitButton = findSubmitButton();
                if (!submitButton || submitButton.disabled) {
                    // Fallback agnóstico de idioma: tenta Enter no editor
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
                forceClick(submitButton);

            } catch (error) {
                console.error('Erro ao enviar prompt:', error);
                throw error;
            }
        }

        // =========================================================================
        // FLUXO DE IMAGEM — espelho exato da extensão de referência (pasta temp)
        // =========================================================================

        /**
         * PASSO 1 — Configurar proporção da imagem.
         * NOTA: Já estamos na página /imagine (modo imagem).
         * O menu de configuração é para selecionar modelo (Aurora, etc.), não Image vs Video.
         * Portanto não existe botão "Image Mode" para clicar — apenas selecionar a proporção.
         */
        async function configureImageMode(aspectRatio) {
            console.log(`🎨 [configureImageMode] Alvo: ${aspectRatio}`);

            if (!aspectRatio) return true;

            const target = normalizeAspectRatio(aspectRatio);

            // 1. Tentar seleção direta (Muitas vezes os botões já estão na tela)
            const directBtn = findAspectRatioOption(target);
            if (directBtn && isVisible(directBtn)) {
                if (isAspectRatioSelected(directBtn)) {
                    console.log(`✅ Proporção ${target} já está selecionada (direto).`);
                    return true;
                }
                console.log(`🖱️ Clicando no botão de proporção direto: ${target}`);
                forceClick(directBtn);
                await sleep(1000);
                if (isAspectRatioSelected(directBtn)) return true;
                console.log('⚠️ Clique direto não parece ter funcionado, tentando via menu...');
            }

            // 2. Tentar via menu de configurações
            const applied = await selectAspectRatio(target);
            if (!applied) {
                console.warn(`⚠️ Não foi possível aplicar proporção ${target}, prosseguindo.`);
            }

            return true;
        }

        /**
         * PASSO 2 — Inserir prompt e enviar via keydown Enter.
         * Replica a função E() da extensão temp:
         *   - textContent = prompt  (não innerHTML)
         *   - dispatch: input + change
         *   - keydown Enter com keyCode 13
         * NÃO usa forceClick no botão submit — isso interferia com a geração.
         */
        async function insertAndSubmitPromptImage(prompt) {
            console.log(`📝 [insertAndSubmitPromptImage] "${prompt.substring(0, 40)}..."`);

            let editor = null;
            for (let i = 0; i < 15; i++) {
                editor = findEditor();
                if (editor) break;
                await sleep(500);
            }
            if (!editor) throw new Error('Editor não encontrado após 7.5s');

            editor.focus();
            await sleep(200);

            // Inserir texto — igual à extensão temp: textContent para contenteditable
            if (editor.isContentEditable) {
                editor.textContent = prompt;
            } else {
                editor.value = prompt;
            }

            // Disparar eventos para React reconhecer a mudança
            editor.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
            editor.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
            await sleep(500);

            // Enviar via keydown Enter (keyCode 13) — EXATAMENTE como a extensão temp
            editor.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
                bubbles: true, cancelable: true
            }));

            console.log('🚀 Prompt enviado via keydown Enter');
            await sleep(300);
            return true;
        }

        /**
         * PASSO 3 — Aguardar e baixar imagens finalizadas.
         * Replica o loop k() da extensão temp para textToImage:
         *   - Polling a cada 2s, máximo 150 iterações (5 min)
         *   - Procura img[alt="Generated image"] com src.length >= 130000
         *   - Quando outputCount imagens prontas, baixa todas
         */
        async function waitAndDownloadImages(promptIndex, prompt, outputCount, sectionsBefore = -1) {
            console.log(`🔍 [waitAndDownloadImages] Aguardando ${outputCount} imagem(ns)... (prompt ${promptIndex + 1})`);
            const maxIterations = 150; // 150 × 2s = 5 minutos

            // Se sectionsBefore não foi passado, capturar agora (pode já incluir a nova seção)
            if (sectionsBefore < 0) {
                sectionsBefore = document.querySelectorAll('[id^="imagine-masonry-section"]').length;
            }

            // Nome seguro para arquivo — igual à função v() da extensão temp
            const safePromptName = (prompt || 'imagem')
                .replace(/\s+/g, '-')
                .replace(/[^a-zA-Z0-9\-]/g, '')
                .replace(/-+/g, '-')
                .replace(/^-+|-+$/g, '')
                .substring(0, 50) || 'imagem';

            const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');

            // ── PASSO A: Aguardar nova seção masonry aparecer ─────────────────────────
            // A extensão temp usa h(r.imagineMasonrySection).last() — pega a Última seção.
            // Quando o Grok recebe o prompt, cria uma nova seção masonry.
            // Só começamos a polling NAS IMAGENS depois que essa nova seção existir.
            console.log(`📊 Seções masonry antes: ${sectionsBefore}`);

            // Aguardar nova seção (máx 30s = 15 iterações de 2s)
            let newSectionFound = false;
            for (let i = 0; i < 15; i++) {
                if (!automationState.isRunning) return false;
                await sleep(2000);
                const sectionsNow = document.querySelectorAll('[id^="imagine-masonry-section"]').length;
                if (sectionsNow > sectionsBefore) {
                    console.log(`✅ Nova seção masonry detectada! (${sectionsNow} seções)`);
                    newSectionFound = true;
                    break;
                }
                console.log(`⏳ Aguardando nova seção... (${sectionsNow}/${sectionsBefore + 1})`);
            }

            if (!newSectionFound) {
                console.warn('⚠️ Nenhuma nova seção masonry apareceu. Usando última seção existente.');
            }

            // ── PASSO B: Polling na ÚLTIMA seção (= geração atual) ────────────────
            let iteration = 0;
            while (iteration < maxIterations) {
                if (!automationState.isRunning) {
                    console.log('🛑 Automação parada');
                    return false;
                }

                // Sempre pegar a última seção (mais recente = geração atual)
                // IGUAL ao .last() da extensão temp
                const root = getMasonryRoot();
                const allImgs = Array.from(root.querySelectorAll('img[alt="Generated image"]'));
                const finalImgs = allImgs.filter(img => {
                    const src = img.src || '';
                    // PNG = placeholder (gerado durante a geração)
                    // JPEG = imagem final (concluída)
                    return src.startsWith('data:image/jpeg') && src.length >= FINAL_IMAGE_SRC_MIN_LENGTH;
                });

                if (iteration % 5 === 0) {
                    const pngs = allImgs.filter(i => (i.src || '').startsWith('data:image/png')).length;
                    const jpegs = allImgs.filter(i => (i.src || '').startsWith('data:image/jpeg')).length;
                    console.log(`⏳ [img poll] iter=${iteration} root=${root.id || 'doc'} png=${pngs} jpeg=${jpegs} finais=${finalImgs.length}/${outputCount}`);
                }

                // Quando atingir o número esperado E a primeira tiver src — baixar tudo
                if (finalImgs.length >= outputCount && finalImgs[0].src) {
                    console.log(`✅ ${finalImgs.length} imagem(ns) finalizada(s)! Iniciando downloads...`);

                    const toDownload = finalImgs.slice(0, outputCount);

                    for (let i = 0; i < toDownload.length; i++) {
                        const src = toDownload[i].src;
                        if (!src) continue;

                        const letter = letters[i] || `_${i + 1}`;
                        // Filename exatamente igual à extensão temp:
                        //   {promptIndex}_{safePromptName}_{letter}.jpg
                        const filename = `${promptIndex}_${safePromptName}_${letter}.jpg`;

                        console.log(`📥 Download [${i + 1}/${toDownload.length}]: ${filename}`);

                        try {
                            const result = await chrome.runtime.sendMessage({
                                type: 'DOWNLOAD_IMAGE',
                                url: src,
                                filename: filename,
                                prompt: prompt,
                                autoChangeFileName: true
                            });

                            if (result && result.success) {
                                console.log(`✅ Download iniciado: ${filename} (id=${result.downloadId})`);
                            } else {
                                console.warn(`⚠️ Download falhou: ${result?.error || 'sem resposta'}`);
                            }
                        } catch (err) {
                            console.error(`❌ Erro ao enviar DOWNLOAD_IMAGE:`, err);
                        }

                        if (i < toDownload.length - 1) await sleep(500);
                    }

                    automationState.imageDownloadInitiated = true;
                    return true;
                }

                await sleep(2000); // Polling a cada 2s — idêntico à extensão temp
                iteration++;
            }

            console.warn('⚠️ Timeout (5min) aguardando imagens. Prosseguindo sem download.');
            return false;
        }

        /**
         * Função principal do modo imagem — replica exatamente o fluxo da extensão temp.
         */

        async function waitAndDownloadVideo(promptIndex, prompt, sectionsBefore = -1) {
            console.log(`🎬 [waitAndDownloadVideo] Aguardando vídeo... (prompt ${promptIndex + 1}) sectionsBefore=${sectionsBefore}`);
            const maxIterations = 150; // 5 min

            if (sectionsBefore < 0) {
                sectionsBefore = document.querySelectorAll('[id^="imagine-masonry-section"]').length;
            }

            let newSectionFound = false;
            for (let i = 0; i < 20; i++) {
                if (!automationState.isRunning) return false;
                const sectionsNow = document.querySelectorAll('[id^="imagine-masonry-section"]').length;
                if (sectionsNow > sectionsBefore) {
                    console.log(`✅ Nova seção detectada (seção ${sectionsNow})`);
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
                // Se o MutationObserver já tiver baixado o vídeo, podemos prosseguir
                if (automationState.downloadedVideos.has(promptIndex)) {
                    console.log(`⏩ [waitAndDownloadVideo] Vídeo ${promptIndex + 1} já baixado (via Observer), prosseguindo.`);
                    return true;
                }
                const root = getMasonryRoot();
                const videos = Array.from(root.querySelectorAll('video'));
                const readyVideos = videos.filter(v => v.src && v.src.length > 50);

                if (iteration % 5 === 0) {
                    console.log(`⏳ [video poll] iter=${iteration} ready=${readyVideos.length}`);
                    updateOverlay({ status: 'Gerando vídeo...', prompt, index: promptIndex + 1, total: automationState.prompts.length });
                }

                if (readyVideos.length > 0 && readyVideos[0].src) {
                    console.log(`✅ Vídeo pronto! Chamando processVideoElement (prompt ${promptIndex + 1})`);
                    await processVideoElement(readyVideos[0], promptIndex);
                    return true;
                }
                await sleep(1000); // Polling mais rápido (1s)
                iteration++;
            }
            return false;
        }

        function handleAutomationComplete() {
            console.log('🏁 handleAutomationComplete chamado');
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
                status: 'Concluído',
                prompt: `Todas as ${itemType} processadas`,
                index: totalItems,
                total: totalItems,
                elapsedSeconds: elapsed
            });

            resetAutomation({ keepOverlay: true, stopTimer: true });
            console.log('🏁 Automação finalizada');
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
                console.log('🔄 Redirecionando para /imagine...');
                await saveAutomationState();
                window.location.href = 'https://grok.com/imagine';
                return;
            }

            automationState.restoredFromReload = false;
            const currentPrompt = (automationState.prompts && automationState.prompts[automationState.currentIndex]) || '';
            let currentAspectRatio = null;
            if (automationState.settings?.randomize && automationState.settings?.aspectRatios?.length > 0) {
                currentAspectRatio = automationState.settings.aspectRatios[Math.floor(Math.random() * automationState.settings.aspectRatios.length)];
                console.log(`🎲 Proporção randomizada: ${currentAspectRatio}`);
            } else {
                currentAspectRatio = automationState.settings?.fixedRatio || (automationState.settings?.aspectRatio) || '3:2';
            }

            // --- Configurações Iniciais do Modelo (Duração, Resolução, Proporção) ---
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

            // Aplicar Proporção SEMPRE, inclusive para vídeo text-to
            if (currentAspectRatio) {
                console.log(`🎰 [Prompt ${automationState.currentIndex + 1}] Proporção alvo: ${currentAspectRatio}`);
                updateOverlay({
                    status: `Configurando Proporção [${currentAspectRatio}]...`,
                    prompt: currentPrompt,
                    index: automationState.currentIndex + 1,
                    total: automationState.prompts.length
                });
                await configureImageMode(currentAspectRatio);
                await sleep(500); // Aguardar estabilização após config
            }

            updateOverlay({
                status: automationState.mode === 'video' ? 'Gerando vídeo' : 'Gerando imagem',
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
                        updateOverlay({ status: '☕ Pausa', prompt: `Descansando...`, index: automationState.currentIndex, total: automationState.prompts.length });
                        await sleep(breakMs);
                        automationState.isOnBreak = false;
                        automationState.promptsSinceLastBreak = 0;
                    }
                    const delaySeconds = automationState.settings?.promptDelaySeconds != null
                        ? parseInt(automationState.settings.promptDelaySeconds)
                        : (automationState.delay || 45);
                    const delayMs = Math.max(2, delaySeconds) * 1000;
                    console.log(`⏱️ Aguardando ${delayMs / 1000}s para o próximo prompt...`);
                    await sleep(delayMs);
                    automationState.timeoutId = setTimeout(runAutomation, 100);
                } else {
                    handleAutomationComplete();
                }
            } catch (error) {
                console.error('❌ Erro na automação:', error);
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

            // Abrir o menu de modelo (usando a mesma robustez de selectGenerationMode)
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
                console.warn('⚠️ Trigger de modelo não encontrado para selecionar duração');
                return false;
            }

            if (trigger.getAttribute('aria-expanded') !== 'true') {
                console.log('🔔 Abrindo menu de modelo...');
                forceClick(trigger);
                await sleep(1000);
            }

            // Procurar o container que contém "Duração" ou os botões de tempo
            const groupItems = Array.from(document.querySelectorAll('[role="group"], [role="menuitem"], [data-radix-popper-content-wrapper] div'));
            let durationMenuItem = null;

            for (const item of groupItems) {
                const itemText = normalizeText(item.textContent);
                // Detectar pelo título (multi-idioma) OU se contém botões específicos de tempo (6s, 10s)
                const hasDurationTitle = /duracao|duration|duración|tempo/i.test(itemText);
                const hasTimeButtons = item.querySelector('button[aria-label*="s"], button[aria-label*="s"]');

                if (hasDurationTitle || (hasTimeButtons && item.querySelectorAll('button').length >= 2)) {
                    durationMenuItem = item;
                    console.log('🎯 Container de duração encontrado:', itemText.substring(0, 50));
                    break;
                }
            }

            if (!durationMenuItem) {
                console.warn('⚠️ Menu de duração não encontrado no menu aberto. Tentando busca global por botões...');
                // Fallback: se não achar o container, tenta pegar qualquer botão que pareça ser de duração
                const allButtons = Array.from(document.querySelectorAll('button[aria-label]'));
                const possibleButtons = allButtons.filter(b => /^(6s|10s)$/i.test(b.getAttribute('aria-label') || ''));
                if (possibleButtons.length > 0) {
                    console.log('🎯 Encontrados botões de duração via busca global.');
                    durationMenuItem = possibleButtons[0].parentElement;
                }
            }

            if (!durationMenuItem) {
                console.warn('⚠️ Menu de duração realmente não encontrado.');
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

            // Check if we're on a post page - redirect to /imagine if so (post pages have no editor)
            const isPostPage = window.location.pathname.includes('/imagine/post/');

            if (isPostPage) {
                console.log(`🔄 [image-to-video] Redirecionando para /imagine pois página de post não tem editor`);
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

                // ========== STEP 1.5: Select Aspect Ratio (Randomized or Fixed) ==========
                let currentRatio = automationState.settings?.fixedRatio || '3:2';
                if (automationState.settings?.randomize && automationState.settings?.aspectRatios?.length > 0) {
                    currentRatio = automationState.settings.aspectRatios[Math.floor(Math.random() * automationState.settings.aspectRatios.length)];
                    console.log(`🎲 [image-to-video] Item ${automationState.currentImageIndex + 1} -> Ratio: ${currentRatio}`);
                }

                updateOverlay({
                    status: `Configurando Proporção [${currentRatio}]...`,
                    prompt: `Imagem: ${currentImage.name}`,
                    index: automationState.currentImageIndex + 1,
                    total: automationState.imageQueue.length
                });

                await configureImageMode(currentRatio);
                await sleep(1000); // 1s para o Grok atualizar os parâmetros internos

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

                // Short pause before next prompt - delay reduzido para modo image-to-video
                const waitDelay = Math.max(3, Math.min(automationState.delay, 10)); // Max 10s, min 3s
                console.log(`⏱️ Aguardando ${waitDelay}s antes do próximo...`);
                updateOverlay({
                    status: 'Aguardando próximo...',
                    prompt: `Delay: ${waitDelay}s...`,
                    index: automationState.currentImageIndex,
                    total: automationState.imageQueue.length
                });

                await sleep(waitDelay * 1000);

                console.log('🔄 Continuando com a próxima imagem sem recarregar...');
                // Chamar a função novamente para o próximo item sem reload
                processImageToVideoQueue();
                return;

            } catch (error) {
                console.error('❌ Erro:', error);
                automationState.currentImageIndex++;
                await saveAutomationState();

                console.log('🔄 Ignorando erro e continuando em 5s...');
                setTimeout(() => {
                    processImageToVideoQueue();
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
                automationState.imageDownloadInitiated = false;
                automationState.awaitingImageCompletion = false;
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
                    automationState.imageDownloadInitiated = false;
                    automationState.awaitingImageCompletion = false;
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

            console.log(`🔍 [processVideoElement] Índice: ${currentPromptIndex}, Upscale: ${shouldUpscale}, Modo: ${automationState.mode}`);

            if (video.dataset.gpaVideoProcessed === 'true' || automationState.processingPrompts.has(currentPromptIndex) || automationState.downloadedVideos.has(currentPromptIndex)) {
                console.log(`⏭️ [processVideoElement] Prompt ${currentPromptIndex} já está sendo processado ou baixado. Ignorando.`);
                return;
            }

            // Lock synchronously
            video.dataset.gpaVideoProcessed = 'true';
            automationState.processingPrompts.add(currentPromptIndex);

            // Show status in overlay if upscaling
            if (shouldUpscale) {
                updateOverlay({
                    status: 'Upscale do vídeo...',
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
                            console.log('⚠️ URL de upscale não acessível, usando src do vídeo.');
                            await triggerDownload(video.src, 'video', currentPromptIndex);
                        }
                    } else {
                        console.log('⚠️ Upscale falhou, baixando vídeo SD.');
                        await triggerDownload(video.src, 'video', currentPromptIndex);
                    }
                } else {
                    await sleep(2000); // Wait for UI stability
                    if (!automationState.downloadedVideos.has(currentPromptIndex)) {
                        console.log('📥 Baixando vídeo SD via direct link.');
                        await triggerDownload(video.src, 'video', currentPromptIndex);
                    }
                }

                // Check Completion
                const totalPrompts = automationState.mode === 'image-to-video'
                    ? (automationState.imageQueue?.length || 0)
                    : (automationState.prompts?.length || 0);

                if (currentPromptIndex >= totalPrompts - 1) {
                    console.log('🏁 Processamento final concluído.');
                }
            } catch (error) {
                console.error('❌ Erro no processVideoElement:', error);
            } finally {
                automationState.processingPrompts.delete(currentPromptIndex);
                console.log(`🔓 Lock removido para prompt ${currentPromptIndex}.`);
            }
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

        const FINAL_IMAGE_SRC_MIN_LENGTH = 130000;

        // Retorna a Última seção da masonry (mais recente) — igual ao .last() da extensão temp.
        // O Grok cria uma nova seção por prompt: #imagine-masonry-section-0, -1, -2...
        // Sempre usar a última para não pegar imagens antigas.
        function getMasonryRoot() {
            const sections = document.querySelectorAll('[id^="imagine-masonry-section"]');
            if (sections.length > 0) return sections[sections.length - 1]; // .last() da temp
            // Fallback: procurar container de masonry genérico
            return document.querySelector('[data-testid="masonry"], .masonry-grid, #imagine-masonry-section-0') || document;
        }

        function markExistingMasonryItemsAsProcessed() {
            const root = getMasonryRoot();
            const items = root.querySelectorAll('div[role="list"] > div[role="listitem"]');
            items.forEach(item => {
                item.dataset.gpaImageProcessed = 'true';
                item.dataset.gpaAllImagesProcessed = 'true';
            });
            console.log(`🧹 Itens antigos marcados como processados: ${items.length}`);
        }

        function getGeneratedImageFromListItem(item) {
            if (!item || item.getAttribute('role') !== 'listitem') return null;

            // Aceitar apenas imagens geradas da masonry principal
            const candidates = Array.from(item.querySelectorAll('img[alt="Generated image"][src^="data:image/"]'));
            if (!candidates.length) return null;

            // Escolher a maior imagem visível para evitar ícones/miniaturas
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
            // Mesma lógica da extensão de referência (temp):
            // Faz polling a cada 2s procurando imagens data:image com src.length >= 130000
            // NÃO usa MutationObserver para src (que interferiria com a geração do Grok)
            const start = Date.now();
            let lastLogAt = 0;
            const maxImages = automationState.settings?.downloadAllImages
                ? (automationState.settings?.downloadMultiCount || 4)
                : 1;

            while (Date.now() - start < timeoutMs) {
                if (!automationState.isRunning) return false;
                if (automationState.imageDownloadInitiated) return true;

                // Buscar direto as imagens finalizadas na masonry (src data:image/jpeg = final)
                // PNG = placeholder/borrado, JPEG = imagem concluída
                const root = getMasonryRoot();
                const allImgs = Array.from(root.querySelectorAll('img[alt="Generated image"]'));
                const finalImgs = allImgs.filter(img => {
                    const src = img.src || '';
                    return src.startsWith('data:image/jpeg') && src.length >= FINAL_IMAGE_SRC_MIN_LENGTH;
                });

                const now = Date.now();
                if (now - lastLogAt >= 3000) {
                    console.log(`⏳ Aguardando imagens JPEG: ${finalImgs.length}/${maxImages} finalizadas`);
                    lastLogAt = now;
                }

                if (finalImgs.length >= maxImages) {
                    console.log(`✅ ${finalImgs.length} imagem(ns) finalizada(s) detectada(s) via polling!`);
                    return true;
                }

                await sleep(2000); // Polling a cada 2s, igual à extensão de referência
            }

            return false;
        }

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

                const masonryRoot = getMasonryRoot();
                const allItems = Array.from(masonryRoot.querySelectorAll('div[role="list"] > div[role="listitem"]:not([data-gpa-all-images-processed="true"])'));
                if (allItems.length === 0) {
                    isDownloadingAllImages = false;
                    return;
                }

                console.log(`🖼️ Modo 'Baixar Todas': Prompt[${currentPromptIdx}] "${currentPrompt.substring(0, 30)}..." - Verificando ${allItems.length} itens...`);

                // Função para verificar se a imagem é válida
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
                        await sleep(350);

                        // Revalidar depois de alguns ms para evitar baixar placeholder em transição
                        const recheck = checkImageValid(item);
                        if (!recheck || !recheck.valid || recheck.isPlaceholder) {
                            console.log(`⏳ Item ${i}: ainda em transição após espera curta, pulando por agora...`);
                            continue;
                        }
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

            // Observer agora só dispara para childList (sem attributes).
            // Imagens: detecção via polling em waitForCurrentImageFinalization.
            // Vídeos: detectados quando o elemento <video> é adicionado ao DOM.
            const hasAddedNodes = mutations.some(m => m.type === 'childList' && m.addedNodes.length > 0);
            if (!hasAddedNodes) return;

            // Check for preference popup on every mutation
            handlePreferencePopup();

            // --- Modo Baixar Todas as Imagens ---
            if (automationState.mode === 'image' && automationState.settings?.downloadAllImages && automationState.settings?.autoDownload) {
                downloadAllImagesFromItems();
                return; // Não executar o modo de imagem única
            }

            // --- Image Mode (única imagem) ---
            // Download agora tratado por polling direto em runAutomation após waitForCurrentImageFinalization.


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


        function initialize() {
            const observer = new MutationObserver(handleImageGeneration);
            // Observar APENAS novos nós (childList) - NÃO observar atributos src.
            // O Grok atualiza o src de imagens progressivamente durante a geração,
            // o que causava milhares de callbacks no observer e interferia na geração.
            // A detecção de imagem finalizada agora é feita por polling (waitForCurrentImageFinalization).
            // Apenas vídeos precisam do observer (detectados por childList quando o <video> é adicionado ao DOM).
            observer.observe(document.body, {
                childList: true,
                subtree: true
                // SEM attributes: true - crucial para não interferir com geração de imagens
            });
            sendMessageToBackground({ action: 'contentScriptReady' });
            loadAutomationState();
            console.log('🚀 Grok Prompt Automator carregado!');
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
