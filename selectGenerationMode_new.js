async function selectGenerationMode(mode) {
    console.log(`🎯 Tentando selecionar modo: ${mode}`);

    const trigger = document.getElementById('model-select-trigger');
    if (!trigger) {
        console.warn('❌ Botão model-select-trigger não encontrado.');
        return false;
    }

    const targetIsVideo = mode === 'video';

    for (let attempt = 0; attempt < 5; attempt++) {
        console.log(`🔄 Tentativa ${attempt + 1}/5 de selecionar modo...`);

        forceClick(trigger);
        await sleep(500);

        const menuItems = findAllElements('[role="menuitem"]');
        console.log(`📋 ${menuItems.length} itens de menu encontrados`);

        if (menuItems.length < 2) {
            await sleep(300);
            continue;
        }

        let targetOption = null;

        for (let i = 0; i < menuItems.length; i++) {
            const item = menuItems[i];
            const itemText = normalizeText(item.textContent || '');

            // Check for video/image keywords in multiple languages
            const videoPattern = /v[ií]deo|video|vid[eé]o|gerar.*v[ií]deo/i;
            const imagePattern = /imag[em]|image|bild|foto|picture/i;

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

        // Fallback por índice: Image=0, Video=1
        if (!targetOption && menuItems.length >= 2) {
            console.log('⚠️ Usando fallback por índice...');
            targetOption = menuItems[targetIsVideo ? 1 : 0];
        }

        if (targetOption) {
            forceClick(targetOption);
            await sleep(600);
            console.log(`✅ Modo ${targetIsVideo ? 'VÍDEO' : 'IMAGEM'} selecionado!`);
            return true;
        }

        await sleep(300);
    }

    console.warn(`❌ Falhou ao selecionar modo ${targetIsVideo ? 'VÍDEO' : 'IMAGEM'}`);
    return false;
}
