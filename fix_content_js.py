import os

PATH = r'c:\lab\extencao_navegador\grok-prompt-automator4\content.js'

with open(PATH, 'r', encoding='utf-8') as f:
    lines = f.readlines()

new_lines = []
skip = False

# We will search for uploadImageToGrok and replace it and openAttachAndChooseAnimateImage completely.
# Line 2068 is where uploadImageToGrok starts.
# Line 2246 is where selectVideoDuration starts (mostly safe).

for i, line in enumerate(lines):
    if 'async function uploadImageToGrok' in line:
        new_lines.append(line)
        # Add the body of uploadImageToGrok
        new_lines.append("            console.log('📁 Procurando input[type=\"file\"] na página...');\n")
        new_lines.append("            let fileInput = document.querySelector('input[type=\"file\"]');\n")
        new_lines.append("            if (!fileInput) {\n")
        new_lines.append("                const queryBar = document.querySelector('.query-bar') || document.querySelector('div[class*=\"query\"]');\n")
        new_lines.append("                if (queryBar) fileInput = queryBar.querySelector('input[type=\"file\"]');\n")
        new_lines.append("            }\n")
        new_lines.append("            if (!fileInput) {\n")
        new_lines.append("                const allInputs = document.querySelectorAll('input[type=\"file\"]');\n")
        new_lines.append("                if (allInputs.length > 0) fileInput = allInputs[0];\n")
        new_lines.append("            }\n")
        new_lines.append("            if (!fileInput) {\n")
        new_lines.append("                console.log('⚠️ Input de arquivo não encontrado, tentando clicar no botão Anexar...');\n")
        new_lines.append("                const attachBtn = document.querySelector('button[aria-label=\"Anexar\"]') || document.querySelector('button[aria-label=\"Upload\"]');\n")
        new_lines.append("                if (attachBtn) {\n")
        new_lines.append("                    forceClick(attachBtn);\n")
        new_lines.append("                    await sleep(1000);\n")
        new_lines.append("                    fileInput = document.querySelector('input[type=\"file\"]');\n")
        new_lines.append("                }\n")
        new_lines.append("            }\n")
        new_lines.append("            if (!fileInput) throw new Error('Input de arquivo não encontrado na página');\n")
        new_lines.append("            const file = dataURLtoFile(imageData, filename);\n")
        new_lines.append("            const dataTransfer = new DataTransfer();\n")
        new_lines.append("            dataTransfer.items.add(file);\n")
        new_lines.append("            fileInput.files = dataTransfer.files;\n")
        new_lines.append("            fileInput.dispatchEvent(new Event('change', { bubbles: true }));\n")
        new_lines.append("            return true;\n")
        new_lines.append("        }\n\n")
        
        # Add openAttachAndChooseAnimateImage
        new_lines.append("        async function openAttachAndChooseAnimateImage() {\n")
        new_lines.append("            const findAttachButton = () => {\n")
        new_lines.append("                const editor = findEditor();\n")
        new_lines.append("                const scope = editor?.closest('form, [class*=\"query\"], [class*=\"composer\"], [class*=\"chat\"]') || document;\n")
        new_lines.append("                const iconPathFragments = ['M19 17H22V19H19V22H17V19H14V17H17V14H19V17Z', 'M6 6L18 18M18 6L6 18'];\n")
        new_lines.append("                const byIcon = Array.from(scope.querySelectorAll('button')).find(btn => iconPathFragments.some(frag => !!btn.querySelector(`path[d*=\"${frag}\"]`)) && isVisible(btn) && !btn.disabled);\n")
        new_lines.append("                if (byIcon) return byIcon;\n")
        new_lines.append("                const byLabel = Array.from(scope.querySelectorAll('button')).find(btn => {\n")
        new_lines.append("                    const label = normalizeText(btn.getAttribute('aria-label') || btn.getAttribute('title') || '');\n")
        new_lines.append("                    return (label.includes('anex') || label.includes('attach') || label.includes('upload')) && isVisible(btn) && !btn.disabled;\n")
        new_lines.append("                });\n")
        new_lines.append("                return byLabel || null;\n")
        new_lines.append("            };\n\n")
        new_lines.append("            const findAnimateItem = (menu) => {\n")
        new_lines.append("                const items = Array.from(menu.querySelectorAll('[role=\"menuitem\"]'));\n")
        new_lines.append("                if (!items.length) return null;\n")
        new_lines.append("                const scored = items.map(item => {\n")
        new_lines.append("                    const text = normalizeText(item.textContent || '');\n")
        new_lines.append("                    let score = 0;\n")
        new_lines.append("                    if ((text.includes('anim') && text.includes('imag')) || (text.includes('video') && text.includes('transform'))) score += 10;\n")
        new_lines.append("                    if (item.querySelector('path[d*=\"M14.5 15.7158\"]')) score += 8;\n")
        new_lines.append("                    return { item, score };\n")
        new_lines.append("                }).sort((a, b) => b.score - a.score);\n")
        new_lines.append("                return scored[0]?.score > 0 ? scored[0].item : null;\n")
        new_lines.append("            };\n\n")
        new_lines.append("            for (let attempt = 0; attempt < 4; attempt++) {\n")
        new_lines.append("                const attachBtn = findAttachButton();\n")
        new_lines.append("                if (!attachBtn) { await sleep(350); continue; }\n")
        new_lines.append("                const isTrayAlreadyOpen = () => Array.from(document.querySelectorAll('button')).some(btn => {\n")
        new_lines.append("                    const txt = normalizeText(btn.textContent || '');\n")
        new_lines.append("                    return txt.includes('upload or drop') || txt.includes('carregar ou soltar');\n")
        new_lines.append("                });\n")
        new_lines.append("                if (!isTrayAlreadyOpen()) {\n")
        new_lines.append("                    console.log('🖱️ Clicando no botão Anexar...');\n")
        new_lines.append("                    forceClick(attachBtn); \n")
        new_lines.append("                }\n")
        new_lines.append("                for (let poll = 0; poll < 16; poll++) {\n")
        new_lines.append("                    await sleep(250);\n")
        new_lines.append("                    let menu = document.querySelector('[role=\"menu\"][data-state=\"open\"]');\n")
        new_lines.append("                    if (menu) {\n")
        new_lines.append("                        const animateItem = findAnimateItem(menu);\n")
        new_lines.append("                        if (animateItem) { forceClick(animateItem); await sleep(600); return true; }\n")
        new_lines.append("                    }\n")
        new_lines.append("                    const anyUploadBtn = Array.from(document.querySelectorAll('button')).find(btn => {\n")
        new_lines.append("                        const t = normalizeText(btn.textContent || '');\n")
        new_lines.append("                        return (t.includes('upload or drop') || t.includes('carregar ou soltar')) && !btn.disabled;\n")
        new_lines.append("                    });\n")
        new_lines.append("                    if (anyUploadBtn) { forceClick(anyUploadBtn); await sleep(600); return true; }\n")
        new_lines.append("                }\n")
        new_lines.append("            }\n")
        new_lines.append("            console.warn('⚠️ Falha ao abrir menu de anexo');\n")
        new_lines.append("            return false;\n")
        new_lines.append("        }\n")
        
        skip = True
        continue
    
    # Re-enable adding lines when we hit selectVideoDuration
    if 'async function selectVideoDuration' in line:
        skip = False
    
    if not skip:
        new_lines.append(line)

with open(PATH, 'w', encoding='utf-8') as f:
    f.writelines(new_lines)

print("File fixed successfully!")
