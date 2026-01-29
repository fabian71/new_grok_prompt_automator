
// Popup.js - Grok Prompt Automator
document.addEventListener('DOMContentLoaded', async () => {
    // Load version
    const manifest = chrome.runtime.getManifest();
    document.getElementById('version-badge').textContent = `v${manifest.version}`;
    document.getElementById('version-footer').textContent = `Version ${manifest.version}`;

    // Verificar estado da automação no storage
    const { automationActive: isActive } = await chrome.storage.local.get('automationActive');

    // Se não está ativo, garantir que UI está em estado inicial
    if (!isActive) {
        document.querySelectorAll('[id$="-btn"]').forEach(btn => {
            if (btn.id === 'start-btn' || btn.id === 'reset-btn') {
                btn.disabled = false;
            } else if (btn.id === 'stop-btn') {
                btn.disabled = true;
            }
        });
    }

    // Elements
    const promptsTextarea = document.getElementById('prompts-textarea');
    const delayInput = document.getElementById('delay-input');
    const delayInputImage = document.getElementById('delay-input-image'); // Delay para Image-to-Video
    const aspectRatioSelect = document.getElementById('aspect-ratio-select');
    const videoDurationSelect = document.getElementById('video-duration-select');
    const videoDurationContainer = document.getElementById('video-duration-container');
    const videoDelayWarningImage = document.getElementById('video-delay-warning-image');
    const toggleRandomize = document.getElementById('toggle-randomize');
    const randomizeSection = document.getElementById('randomize-section');
    const startBtn = document.getElementById('start-btn');
    const stopBtn = document.getElementById('stop-btn');
    const resetBtn = document.getElementById('reset-btn');
    const statusText = document.getElementById('status-text');
    const progressInfo = document.getElementById('progress-info');
    const autoDownloadCheckbox = document.getElementById('auto-download-checkbox');
    const autoDownloadPromptCheckbox = document.getElementById('auto-download-prompt-checkbox');
    const downloadAllImagesCheckbox = document.getElementById('download-all-images-checkbox');
    const downloadAllImagesContainer = document.getElementById('download-all-images-container');
    const downloadMultiCountContainer = document.getElementById('download-multi-count-container');
    const downloadMultiCount = document.getElementById('download-multi-count');
    const downloadSubfolderName = document.getElementById('downloadSubfolderName');
    const saveDownloadFolder = document.getElementById('saveDownloadFolder');
    const downloadFolderStatus = document.getElementById('downloadFolderStatus');
    const toggleUpscale = document.getElementById('toggle-upscale');
    const upscaleContainer = document.getElementById('upscale-container');
    const toggleBreak = document.getElementById('toggle-break');
    const breakSettings = document.getElementById('break-settings');
    const breakPrompts = document.getElementById('break-prompts');
    const breakMin = document.getElementById('break-min');
    const breakMax = document.getElementById('break-max');
    const breakBadge = document.getElementById('break-badge');

    // Atualizar badge quando inputs mudam
    function updateBreakBadge() {
        if (breakMin && breakMax && breakBadge) {
            breakBadge.textContent = `${breakMin.value} - ${breakMax.value} min`;
        }
    }
    if (breakMin) breakMin.addEventListener('input', updateBreakBadge);
    if (breakMax) breakMax.addEventListener('input', updateBreakBadge);

    // 💾 SISTEMA COMPLETO DE PERSISTÊNCIA DE CONFIGURAÇÕES

    // Função para salvar TODAS as configurações
    function saveAllSettings() {
        const settings = {
            // Checkboxes
            toggleRandomize: toggleRandomize.checked,
            toggleBreak: toggleBreak.checked,
            autoDownload: autoDownloadCheckbox.checked,
            savePromptTxt: autoDownloadPromptCheckbox ? autoDownloadPromptCheckbox.checked : false,
            downloadAllImages: downloadAllImagesCheckbox ? downloadAllImagesCheckbox.checked : false,
            downloadMultiCount: downloadMultiCount ? parseInt(downloadMultiCount.value) : 4,
            autoUpscale: toggleUpscale.checked,

            // Inputs
            delay: delayInput.value,
            aspectRatio: aspectRatioSelect.value,
            videoDuration: videoDurationSelect ? videoDurationSelect.value : '6s',
            downloadSubfolder: downloadSubfolderName.value,
            breakPrompts: breakPrompts.value,
            breakMin: breakMin.value,
            breakMax: breakMax.value,

            // Random options (checkboxes individuais)
            randomOptions: Array.from(document.querySelectorAll('.random-option')).map(cb => ({
                value: cb.value,
                checked: cb.checked
            }))
        };

        chrome.storage.local.set({ popupSettings: settings });
    }

    // Função para carregar TODAS as configurações
    async function loadAllSettings() {
        const { popupSettings } = await chrome.storage.local.get('popupSettings');

        if (popupSettings) {
            // Checkboxes
            if (popupSettings.toggleRandomize !== undefined) {
                toggleRandomize.checked = popupSettings.toggleRandomize;
                randomizeSection.style.display = popupSettings.toggleRandomize ? 'block' : 'none';
                aspectRatioSelect.disabled = popupSettings.toggleRandomize;
            }

            if (popupSettings.toggleBreak !== undefined) {
                toggleBreak.checked = popupSettings.toggleBreak;
                breakSettings.style.display = popupSettings.toggleBreak ? 'block' : 'none';
            }

            if (popupSettings.autoDownload !== undefined) {
                autoDownloadCheckbox.checked = popupSettings.autoDownload;
            }

            if (popupSettings.savePromptTxt !== undefined && autoDownloadPromptCheckbox) {
                autoDownloadPromptCheckbox.checked = popupSettings.savePromptTxt;
            }

            if (popupSettings.downloadAllImages !== undefined && downloadAllImagesCheckbox) {
                downloadAllImagesCheckbox.checked = popupSettings.downloadAllImages;
            }

            if (popupSettings.downloadMultiCount !== undefined && downloadMultiCount) {
                downloadMultiCount.value = popupSettings.downloadMultiCount;
            }

            if (popupSettings.autoUpscale !== undefined) {
                toggleUpscale.checked = popupSettings.autoUpscale;
            }

            // Inputs
            if (popupSettings.delay) {
                delayInput.value = popupSettings.delay;
                if (delayInputImage) delayInputImage.value = popupSettings.delay;
            }
            if (popupSettings.aspectRatio) aspectRatioSelect.value = popupSettings.aspectRatio;
            if (popupSettings.videoDuration && videoDurationSelect) videoDurationSelect.value = popupSettings.videoDuration;
            if (popupSettings.downloadSubfolder) downloadSubfolderName.value = popupSettings.downloadSubfolder;
            if (popupSettings.breakPrompts) breakPrompts.value = popupSettings.breakPrompts;
            if (popupSettings.breakMin) breakMin.value = popupSettings.breakMin;
            if (popupSettings.breakMax) breakMax.value = popupSettings.breakMax;

            // Random options
            if (popupSettings.randomOptions) {
                popupSettings.randomOptions.forEach(opt => {
                    const checkbox = document.querySelector(`.random-option[value="${opt.value}"]`);
                    if (checkbox) checkbox.checked = opt.checked;
                });
            }

            updateBreakBadge();
        }

        // ⚡ Atualizar visibilidade do upscale APÓS carregar configurações
        // Usar setTimeout para garantir que o DOM está atualizado
        setTimeout(() => {
            if (typeof updateUpscaleVisibility === 'function') {
                updateUpscaleVisibility();
            }
        }, 150);
    }

    // Carregar configurações ao abrir popup
    loadAllSettings();

    // Salvar quando qualquer campo mudar
    toggleRandomize.addEventListener('change', saveAllSettings);
    toggleBreak.addEventListener('change', saveAllSettings);
    autoDownloadCheckbox.addEventListener('change', saveAllSettings);
    if (autoDownloadPromptCheckbox) autoDownloadPromptCheckbox.addEventListener('change', saveAllSettings);
    toggleUpscale.addEventListener('change', saveAllSettings);
    delayInput.addEventListener('change', saveAllSettings);
    if (delayInputImage) delayInputImage.addEventListener('change', saveAllSettings);
    aspectRatioSelect.addEventListener('change', saveAllSettings);
    if (videoDurationSelect) videoDurationSelect.addEventListener('change', saveAllSettings);
    downloadSubfolderName.addEventListener('change', saveAllSettings);
    breakPrompts.addEventListener('change', saveAllSettings);
    breakMin.addEventListener('change', saveAllSettings);
    breakMax.addEventListener('change', saveAllSettings);

    // Salvar random options
    document.querySelectorAll('.random-option').forEach(cb => {
        cb.addEventListener('change', saveAllSettings);
    });

    const videoDelayWarning = document.getElementById('video-delay-warning');
    const imageCountLabel = document.getElementById('image-count-label');

    // Tab system
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');
    const resetControlsContainer = document.getElementById('reset-controls-container');

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const targetTab = btn.dataset.tab;

            // Remove active from all
            tabBtns.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));

            // Add active to clicked
            btn.classList.add('active');
            document.getElementById(targetTab).classList.add('active');

            // Mostrar/esconder "Zerar Fila" baseado na aba
            if (targetTab === 'text-tab') {
                resetControlsContainer.style.display = 'block';
            } else {
                resetControlsContainer.style.display = 'none';
            }

            // Save active tab
            chrome.storage.local.set({ activeTab: targetTab });
        });
    });

    // Load savePromptTxt directly from storage (for background.js compatibility)
    let { savePromptTxt } = await chrome.storage.local.get('savePromptTxt');
    // Initialize with default value if not set
    if (savePromptTxt === undefined) {
        savePromptTxt = false;
        await chrome.storage.local.set({ savePromptTxt: false });
        console.log('💾 savePromptTxt inicializado com padrão:', false);
    }
    if (autoDownloadPromptCheckbox) {
        autoDownloadPromptCheckbox.checked = savePromptTxt;
        console.log('💾 savePromptTxt carregado:', savePromptTxt);
    }
    
    // Load active tab
    const { activeTab } = await chrome.storage.local.get('activeTab');
    if (activeTab) {
        const targetBtn = document.querySelector(`[data-tab="${activeTab}"]`);
        if (targetBtn) targetBtn.click();
    } else {
        // Se não tem aba salva, a aba padrão é text-tab, mostrar zerar fila
        resetControlsContainer.style.display = 'block';
    }

    // --- Upscale Visibility Logic ---
    function updateUpscaleVisibility() {
        if (!upscaleContainer) {
            console.warn('⚠️ upscaleContainer não encontrado');
            return;
        }

        const activeTabBtn = document.querySelector('.tab-btn.active');
        if (!activeTabBtn) return;

        const activeTab = activeTabBtn.dataset.tab;

        if (activeTab === 'image-video-tab') {
            // Em Image-to-Video, SEMPRE é vídeo, então upscale faz sentido
            console.log('📹 Image-to-Video tab: Mostrando upscale');
            upscaleContainer.style.display = 'flex';
            if (videoDurationContainer) {
                videoDurationContainer.style.display = 'block';
            }
        } else {
            // Check text generation mode
            const modeRadio = document.querySelector('input[name="generation-mode"]:checked');
            const mode = modeRadio ? modeRadio.value : 'image';

            console.log(`🎯 Modo selecionado: ${mode}`);

            if (mode === 'video') {
                console.log('✅ Modo Vídeo: Mostrando upscale');
                upscaleContainer.style.display = 'flex';
                if (videoDurationContainer) {
                    videoDurationContainer.style.display = 'block';
                }
            } else {
                console.log('❌ Modo Imagem: Escondendo upscale');
                upscaleContainer.style.display = 'none';
                if (videoDurationContainer) {
                    videoDurationContainer.style.display = 'none';
                }
            }
        }
    }

    // Connect to Tab clicks (já adicionamos listener antes, mas precisamos garantir que rode depois da troca)
    tabBtns.forEach(btn => btn.addEventListener('click', () => setTimeout(updateUpscaleVisibility, 50)));

    // Connect to Radio inputs
    const genModeRadios = document.querySelectorAll('input[name="generation-mode"]');
    genModeRadios.forEach(radio => radio.addEventListener('change', updateUpscaleVisibility));

    // Image upload functionality
    const dropzone = document.getElementById('dropzone');
    const imageInput = document.getElementById('image-input');
    const imagePreviewContainer = document.getElementById('image-preview-container');
    const clearImagesBtn = document.getElementById('clear-images-btn');
    const imageControls = document.querySelector('.image-controls');

    let uploadedImages = [];

    // Carregar imagens salvas do storage
    const { savedImages } = await chrome.storage.local.get('savedImages');
    if (savedImages && savedImages.length > 0) {
        uploadedImages = savedImages;
        savedImages.forEach(img => {
            addImagePreview(img);
        });
        imageControls.style.display = 'flex';
    }

    // Dropzone click
    dropzone.addEventListener('click', () => {
        imageInput.click();
    });

    // Drag and drop
    dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.style.borderColor = '#4facfe';
        dropzone.style.background = 'rgba(79, 172, 254, 0.05)';
    });

    dropzone.addEventListener('dragleave', () => {
        dropzone.style.borderColor = '#e1e5e9';
        dropzone.style.background = 'transparent';
    });

    dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.style.borderColor = '#e1e5e9';
        dropzone.style.background = 'transparent';

        const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
        handleImageFiles(files);
    });

    // File input change
    imageInput.addEventListener('change', (e) => {
        const files = Array.from(e.target.files);
        handleImageFiles(files);
        imageInput.value = ''; // Reset input
    });

    // Handle image files
    function handleImageFiles(files) {
        const MAX_TOTAL_SIZE_MB = 200; // Limite global de 200MB (seguro para RAM)
        const MAX_FILE_SIZE_MB = 15;   // Arquivo individual máx 15MB

        let currentTotalBytes = uploadedImages.reduce((acc, img) => acc + (img.size || 0), 0);
        let skippedSizeCount = 0;
        let skippedFullCount = 0;

        files.forEach(file => {
            // Verificar tamanho individual
            if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
                console.warn(`Imagem ignorada (muito grande): ${file.name}`);
                skippedSizeCount++;
                return;
            }

            // Verificar se cabe no total acumulado
            if ((currentTotalBytes + file.size) > (MAX_TOTAL_SIZE_MB * 1024 * 1024)) {
                skippedFullCount++;
                return;
            }

            const reader = new FileReader();
            reader.onload = (e) => {
                const imageData = {
                    name: file.name,
                    data: e.target.result,
                    size: file.size
                };
                uploadedImages.push(imageData);
                addImagePreview(imageData);

                // Otimização: Salvar no storage apenas a cada 5 imagens ou na última
                if (uploadedImages.length % 5 === 0 || file === files[files.length - 1]) {
                    updateImageControls();
                    chrome.storage.local.set({ savedImages: uploadedImages });
                }
            };
            reader.readAsDataURL(file);
            currentTotalBytes += file.size; // Adicionar ao contador
        });

        // Feedback final
        setTimeout(() => {
            updateImageControls();
            chrome.storage.local.set({ savedImages: uploadedImages });

            if (skippedFullCount > 0) {
                alert(`⚠️ Limite de memória atingido! ${skippedFullCount} imagens não couberam pois o total de 200MB foi excedido.\n\nDica: Use imagens mais leves (WebP) para adicionar mais quantidade!`);
            } else if (skippedSizeCount > 0) {
                alert(`⚠️ ${skippedSizeCount} imagens ignoradas por serem maiores que ${MAX_FILE_SIZE_MB}MB individualmente.`);
            }
        }, 1000);
    }

    // Add image preview
    function addImagePreview(imageData) {
        const preview = document.createElement('div');
        preview.className = 'image-preview-item';
        preview.innerHTML = `
            <img src="${imageData.data}" alt="${imageData.name}">
            <button class="remove-image-btn" data-name="${imageData.name}">×</button>
            <span class="image-name">${imageData.name}</span>
        `;

        imagePreviewContainer.appendChild(preview);

        // Remove button
        preview.querySelector('.remove-image-btn').addEventListener('click', () => {
            uploadedImages = uploadedImages.filter(img => img.name !== imageData.name);
            preview.remove();
            updateImageControls();
            // Salvar no storage
            chrome.storage.local.set({ savedImages: uploadedImages });
        });
    }

    // Update image controls visibility
    function updateImageControls() {
        if (uploadedImages.length > 0) {
            imageControls.style.display = 'block';
            imageCountLabel.style.display = 'block';
            // Calcular total em MB
            const totalMb = (uploadedImages.reduce((acc, img) => acc + (img.size || 0), 0) / 1024 / 1024).toFixed(1);
            imageCountLabel.textContent = `${uploadedImages.length} imagens (Total: ${totalMb} MB)`;

            // Tentar recuperar status de progresso
            chrome.runtime.sendMessage({ action: 'checkStatus' }, (response) => {
                if (response && response.currentIndex !== undefined) {
                    highlightImages(response.currentIndex);
                }
            });
        } else {
            imageControls.style.display = 'none';
            imageCountLabel.style.display = 'none';
        }
    }

    function highlightImages(currentIndex) {
        const previews = document.querySelectorAll('.image-preview-item');
        previews.forEach((preview, index) => {
            preview.classList.remove('processed', 'processing');
            // Remove checkmark if exists
            const existingCheck = preview.querySelector('.checkmark-overlay');
            if (existingCheck) existingCheck.remove();

            if (index < currentIndex) {
                preview.classList.add('processed');
                // Add green checkmark overlay
                const check = document.createElement('div');
                check.className = 'checkmark-overlay';
                check.innerHTML = '✅';
                preview.appendChild(check);
            } else if (index === currentIndex) {
                preview.classList.add('processing');
            }
        });
    }

    // Ouvir atualizações de progresso
    chrome.runtime.onMessage.addListener((message) => {
        if (message.action === 'updateStatus' && typeof message.index === 'number') {
            // message.index é 1-based no content script, converter para 0-based
            // Mas espere, content manda index+1 como current. Se index=1, é a primeira imagem (array 0).
            // Vamos ver o content.js
            // No content: index: automationState.currentIndex + 1
            // Entao para array, usamos message.index - 1
            highlightImages(message.index - 1);
        }
    });

    // Clear images
    clearImagesBtn.addEventListener('click', () => {
        uploadedImages = [];
        imagePreviewContainer.innerHTML = '';
        updateImageControls();
        // Salvar no storage
        chrome.storage.local.set({ savedImages: [] });
    });

    // Generation mode radio buttons
    const modeRadios = document.querySelectorAll('input[name="generation-mode"]');
    modeRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            const mode = e.target.value;

            // 🕐 Ajustar delay automaticamente baseado no modo
            if (mode === 'image') {
                delayInput.value = 12; // Imagem: 12 segundos
            } else if (mode === 'video') {
                delayInput.value = 12; // Vídeo: 12 segundos (padrão)
            }

            // Upscale sempre visível para ambos modos
            upscaleContainer.style.display = 'flex';
            if (videoDurationContainer) {
                videoDurationContainer.style.display = mode === 'video' ? 'block' : 'none';
            }
            
            // Save mode
            chrome.storage.local.set({ generationMode: mode });
            
            // updateAutoDownloadOptions será chamado pelo listener adicionado depois
        });
    });

    // Load saved mode
    const { generationMode } = await chrome.storage.local.get('generationMode');
    if (generationMode) {
        const radio = document.querySelector(`input[value="${generationMode}"]`);
        if (radio) {
            radio.checked = true;
            radio.dispatchEvent(new Event('change'));
        }
    } else {
        // Se não tem modo salvo, garantir que upscale está visível
        upscaleContainer.style.display = 'flex';
    }

    // Garantir visibilidade correta da duração ao carregar
    if (videoDurationContainer) {
        const currentMode = document.querySelector('input[name="generation-mode"]:checked')?.value || 'video';
        videoDurationContainer.style.display = currentMode === 'video' ? 'block' : 'none';
    }

    // Randomize aspect ratio
    toggleRandomize.addEventListener('change', () => {
        randomizeSection.style.display = toggleRandomize.checked ? 'block' : 'none';
        aspectRatioSelect.disabled = toggleRandomize.checked;
    });

    // Break settings
    toggleBreak.addEventListener('change', () => {
        breakSettings.style.display = toggleBreak.checked ? 'block' : 'none';
    });

    // Sincronizar inputs de delay entre abas
    function syncDelayInputs(source, target) {
        target.value = source.value;
    }
    
    if (delayInput && delayInputImage) {
        delayInput.addEventListener('input', () => {
            syncDelayInputs(delayInput, delayInputImage);
        });
        delayInputImage.addEventListener('input', () => {
            syncDelayInputs(delayInputImage, delayInput);
        });
    }

    // Delay warning
    delayInput.addEventListener('input', () => {
        const delay = parseInt(delayInput.value);
        const mode = document.querySelector('input[name="generation-mode"]:checked').value;

        if (mode === 'video' && delay < 60) {
            videoDelayWarning.style.display = 'block';
        } else {
            videoDelayWarning.style.display = 'none';
        }


    });
    
    // Delay warning para Image-to-Video
    if (delayInputImage) {
        delayInputImage.addEventListener('input', () => {
            const delay = parseInt(delayInputImage.value);
            if (videoDelayWarningImage) {
                if (delay < 60) {
                    videoDelayWarningImage.style.display = 'block';
                } else {
                    videoDelayWarningImage.style.display = 'none';
                }
            }
        });
    }

    // Save prompts on input
    promptsTextarea.addEventListener('input', () => {
        chrome.storage.local.set({ promptsContent: promptsTextarea.value });
    });
    
    // Save savePromptTxt immediately when changed
    if (autoDownloadPromptCheckbox) {
        autoDownloadPromptCheckbox.addEventListener('change', async () => {
            await chrome.storage.local.set({ savePromptTxt: autoDownloadPromptCheckbox.checked });
            console.log('💾 savePromptTxt salvo:', autoDownloadPromptCheckbox.checked);
        });
    }

    // Save downloadAllImages immediately when changed
    if (downloadAllImagesCheckbox) {
        downloadAllImagesCheckbox.addEventListener('change', async () => {
            await chrome.storage.local.set({ downloadAllImages: downloadAllImagesCheckbox.checked });
            console.log('🖼️ downloadAllImages salvo:', downloadAllImagesCheckbox.checked);
            
            // Mostrar/esconder selectbox de quantidade
            if (downloadMultiCountContainer) {
                const mode = document.querySelector('input[name="generation-mode"]:checked')?.value || 'video';
                downloadMultiCountContainer.style.display = (downloadAllImagesCheckbox.checked && mode === 'image') ? 'block' : 'none';
            }
            
            saveAllSettings();
        });
    }
    
    // Save downloadMultiCount immediately when changed
    if (downloadMultiCount) {
        downloadMultiCount.addEventListener('change', async () => {
            await chrome.storage.local.set({ downloadMultiCount: parseInt(downloadMultiCount.value) });
            console.log('🖼️ downloadMultiCount salvo:', downloadMultiCount.value);
            saveAllSettings();
        });
    }

    // Auto download checkbox
    const autoDownloadOptions = document.getElementById('auto-download-options');
    
    function updateAutoDownloadOptions() {
        const isChecked = autoDownloadCheckbox.checked;
        const mode = document.querySelector('input[name="generation-mode"]:checked')?.value || 'video';
        
        // Mostrar/esconder opções condicionais
        if (autoDownloadOptions) {
            autoDownloadOptions.style.display = isChecked ? 'block' : 'none';
        }
        
        // Atualizar visibilidade específica do "Baixar várias" baseado no modo
        if (downloadAllImagesContainer) {
            downloadAllImagesContainer.style.display = (isChecked && mode === 'image') ? 'flex' : 'none';
        }
        
        // Mostrar/esconder selectbox de quantidade
        if (downloadMultiCountContainer) {
            downloadMultiCountContainer.style.display = (isChecked && mode === 'image' && downloadAllImagesCheckbox?.checked) ? 'block' : 'none';
        }

    }
    
    autoDownloadCheckbox.addEventListener('change', updateAutoDownloadOptions);
    
    // Atualizar quando mudar de modo também
    modeRadios.forEach(radio => {
        radio.addEventListener('change', updateAutoDownloadOptions);
    });
    
    // Inicializar estado
    updateAutoDownloadOptions();

    // Save download folder
    saveDownloadFolder.addEventListener('click', async () => {
        const folderName = downloadSubfolderName.value.trim();
        await chrome.storage.local.set({ downloadSubfolder: folderName });
        downloadFolderStatus.textContent = folderName ? `Salvo: ${folderName}` : 'Pasta padrão';
        downloadFolderStatus.style.color = '#28a745';
        setTimeout(() => {
            downloadFolderStatus.textContent = '';
        }, 3000);
    });

    // Load saved folder
    const { downloadSubfolder } = await chrome.storage.local.get('downloadSubfolder');
    if (downloadSubfolder) {
        downloadSubfolderName.value = downloadSubfolder;
    }

    // Start automation
    startBtn.addEventListener('click', async () => {
        const activeTab = document.querySelector('.tab-content.active').id;

        if (activeTab === 'text-tab') {
            // Text to Image/Video mode
            const prompts = promptsTextarea.value.trim().split('\n').filter(p => p.trim());

            if (prompts.length === 0) {
                alert('Por favor, insira pelo menos um prompt!');
                return;
            }

            const modeValue = document.querySelector('input[name="generation-mode"]:checked').value;
            const aspectRatios = Array.from(document.querySelectorAll('.random-option:checked')).map(cb => cb.value);

            const config = {
                prompts,
                delay: parseInt(delayInput.value),
                aspectRatio: aspectRatioSelect.value,
                randomizeAspectRatio: toggleRandomize.checked,
                aspectRatios,
                mode: modeValue,
                videoDuration: modeValue === 'video' && videoDurationSelect ? videoDurationSelect.value : null,
                autoDownload: autoDownloadCheckbox.checked,
                savePromptTxt: autoDownloadPromptCheckbox ? autoDownloadPromptCheckbox.checked : false,
                downloadAllImages: downloadAllImagesCheckbox ? downloadAllImagesCheckbox.checked : false,
                downloadMultiCount: downloadMultiCount ? parseInt(downloadMultiCount.value) : 4,
                downloadSubfolder: downloadSubfolderName.value.trim(),
                autoUpscale: toggleUpscale.checked,
                breakEnabled: toggleBreak.checked,
                breakPrompts: parseInt(breakPrompts.value),
                breakDurationMin: parseInt(breakMin.value),
                breakDurationMax: parseInt(breakMax.value)
            };

            await chrome.storage.local.set({
                automationConfig: config,
                automationActive: true,
                // Salvar também as configs individuais que o background.js usa
                autoDownload: config.autoDownload,
                downloadSubfolder: config.downloadSubfolder
            });

            // Send message to content script
            try {
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

                if (!tab || !tab.id) {
                    alert('Nenhuma tab ativa encontrada!');
                    return;
                }

                if (!tab.url || !tab.url.includes('grok.com')) {
                    const proceed = confirm('Você não está na página do Grok. Deseja abrir o Grok agora?');
                    if (proceed) {
                        await chrome.tabs.update(tab.id, { url: 'https://grok.com/imagine' });
                        alert('Aguarde a página carregar e clique em Iniciar novamente.');
                    }
                    return;
                }

                // Salvar ID da aba para poder parar depois
                await chrome.storage.local.set({ activeTabId: tab.id });

                // 🔍 PING CHECK: Verificar se o content script está pronto
                const checkContentScript = () => {
                    return new Promise((resolve) => {
                        chrome.tabs.sendMessage(tab.id, { action: 'ping' }, (response) => {
                            if (chrome.runtime.lastError || !response) {
                                resolve(false);
                            } else {
                                resolve(true);
                            }
                        });
                    });
                };

                // Tentar até 3 vezes com delay
                let attempts = 0;
                let scriptReady = false;

                while (attempts < 3 && !scriptReady) {
                    scriptReady = await checkContentScript();
                    if (!scriptReady) {
                        attempts++;
                        console.log(`⏳ Content script não pronto, tentativa ${attempts}/3...`);
                        await new Promise(resolve => setTimeout(resolve, 500)); // Aguardar 500ms
                    }
                }

                if (!scriptReady) {
                    alert('O content script não está carregado. Tente recarregar a página (F5) e clique em Iniciar novamente.');
                    return;
                }

                // ✅ Content script está pronto, enviar mensagem
                chrome.tabs.sendMessage(tab.id, { action: 'startAutomation', config }, (response) => {
                    if (chrome.runtime.lastError) {
                        console.log('Content script não respondeu:', chrome.runtime.lastError.message);
                    }
                });

                updateUIState(true);
                statusText.textContent = 'Automação iniciada...';
                progressInfo.textContent = `0/${prompts.length} prompts enviados`;
            } catch (error) {
                console.error('Erro:', error);
                alert('Erro ao iniciar automação: ' + error.message);
            }

        } else if (activeTab === 'image-video-tab') {
            // Image to Video mode
            if (uploadedImages.length === 0) {
                alert('Por favor, faça upload de pelo menos uma imagem!');
                return;
            }

            // Feedback visual
            startBtn.disabled = true;
            statusText.textContent = 'Salvando imagens...';

            // Estratégia "Chunked Storage"
            // 1. Limpar storage antigo
            await chrome.storage.local.remove(['automationImages', 'automationQueue']);

            // 2. Preparar fila e salvar
            const imageQueue = [];
            const timestamp = Date.now();

            const savePromises = uploadedImages.map(async (img, index) => {
                const imageId = `autom_img_${timestamp}_${index}`;
                imageQueue.push({
                    id: imageId,
                    name: img.name
                });
                // Salvar dado da imagem
                await chrome.storage.local.set({ [imageId]: img });
            });

            await Promise.all(savePromises);

            // 3. Salvar fila
            await chrome.storage.local.set({
                automationQueue: imageQueue
            });

            // Delay de segurança
            await new Promise(r => setTimeout(r, 800));
            statusText.textContent = 'Iniciando...';

            const aspectRatios = Array.from(document.querySelectorAll('.random-option:checked')).map(cb => cb.value);
            const config = {
                imageCount: uploadedImages.length, // Enviar apenas a contagem
                delay: parseInt(delayInputImage ? delayInputImage.value : delayInput.value),
                aspectRatio: aspectRatioSelect.value,
                randomizeAspectRatio: toggleRandomize.checked,
                aspectRatios,
                videoDuration: videoDurationSelect ? videoDurationSelect.value : null,
                autoDownload: autoDownloadCheckbox.checked,
                downloadSubfolder: downloadSubfolderName.value.trim(),
                autoUpscale: toggleUpscale.checked,
                breakEnabled: toggleBreak.checked,
                breakPrompts: parseInt(breakPrompts.value),
                breakDurationMin: parseInt(breakMin.value),
                breakDurationMax: parseInt(breakMax.value)
            };

            await chrome.storage.local.set({
                automationConfig: config,
                automationActive: true,
                // Salvar também as configs individuais que o background.js usa
                autoDownload: config.autoDownload,
                downloadSubfolder: config.downloadSubfolder
            });

            // Send message to content script
            try {
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

                if (!tab || !tab.id) {
                    alert('Nenhuma tab ativa encontrada!');
                    return;
                }

                if (!tab.url || !tab.url.includes('grok.com')) {
                    const proceed = confirm('Você não está na página do Grok. Deseja abrir o Grok agora?');
                    if (proceed) {
                        await chrome.tabs.update(tab.id, { url: 'https://grok.com/imagine' });
                        alert('Aguarde a página carregar e clique em Iniciar novamente.');
                    }
                    return;
                }

                // Salvar ID da aba para poder parar depois
                await chrome.storage.local.set({ activeTabId: tab.id });

                chrome.tabs.sendMessage(tab.id, { action: 'startImageToVideo', config }, (response) => {
                    if (chrome.runtime.lastError) {
                        // Isso é normal se a página foi recarregada
                        console.log('Content script não respondeu:', chrome.runtime.lastError.message);
                    }
                });

                updateUIState(true);
                statusText.textContent = 'Automação de imagem para vídeo iniciada...';
                progressInfo.textContent = `0/${uploadedImages.length} imagens processadas`;
            } catch (error) {
                console.error('Erro:', error);
                alert('Erro ao iniciar automação: ' + error.message);
            }
        }
    });

    // Stop automation
    stopBtn.addEventListener('click', async () => {
        await chrome.storage.local.set({ automationActive: false });

        // Tentar encontrar a aba correta
        const { activeTabId } = await chrome.storage.local.get('activeTabId');
        let tabId = activeTabId;

        // Fallback para aba atual se não tiver ID salvo
        if (!tabId) {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab) tabId = tab.id;
        }

        if (tabId) {
            chrome.tabs.sendMessage(tabId, { action: 'stopAutomation' }, () => {
                // Ignorar erro se a aba fechou ou content script não responde
                if (chrome.runtime.lastError) {
                    console.log('Aviso ao parar (ignorado):', chrome.runtime.lastError.message);
                }
            });
        }

        updateUIState(false);
        statusText.textContent = 'Automação parada';
    });

    // Reset queue
    resetBtn.addEventListener('click', async () => {
        if (confirm('Tem certeza que deseja zerar a fila? Isso não pode ser desfeito.')) {
            await chrome.storage.local.remove(['automationConfig', 'automationActive', 'automationProgress']);

            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab && tab.id) {
                chrome.tabs.sendMessage(tab.id, { action: 'resetQueue' }, () => {
                    if (chrome.runtime.lastError) {
                        console.log('Content script não respondeu (esperado se página foi recarregada):', chrome.runtime.lastError.message);
                    }
                });
            }

            updateUIState(false);
            statusText.textContent = 'Fila zerada';
            progressInfo.textContent = '';
        }
    });

    // Get random aspect ratio
    function getRandomAspectRatio() {
        const checkedOptions = Array.from(document.querySelectorAll('.random-option:checked'));
        if (checkedOptions.length === 0) return '3:2';
        const randomOption = checkedOptions[Math.floor(Math.random() * checkedOptions.length)];
        return randomOption.value;
    }

    // Update UI state
    function updateUIState(isRunning) {
        startBtn.disabled = isRunning;
        stopBtn.disabled = !isRunning;
        promptsTextarea.disabled = isRunning;
        delayInput.disabled = isRunning;
        if (delayInputImage) delayInputImage.disabled = isRunning;
        aspectRatioSelect.disabled = isRunning || toggleRandomize.checked;

        if (isRunning) {
            statusText.parentElement.classList.add('running');
        } else {
            statusText.parentElement.classList.remove('running');
        }
    }

    // Listen for progress updates
    chrome.runtime.onMessage.addListener((message) => {
        if (message.action === 'updateProgress') {
            progressInfo.textContent = message.text;
        } else if (message.action === 'automationComplete') {
            updateUIState(false);
            statusText.textContent = 'Automação concluída!';
        } else if (message.action === 'automationError') {
            updateUIState(false);
            statusText.textContent = `Erro: ${message.error}`;
        }
    });

    // Load saved state
    const { automationActive, automationProgress, promptsContent } = await chrome.storage.local.get(['automationActive', 'automationProgress', 'promptsContent']);

    if (promptsContent) {
        promptsTextarea.value = promptsContent;
    }

    if (automationActive) {
        updateUIState(true);
        statusText.textContent = 'Automação em andamento...';
        if (automationProgress) {
            progressInfo.textContent = automationProgress;
        }
    }
});
