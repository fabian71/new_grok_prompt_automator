import sys

with open('popup.html', 'r', encoding='utf-8') as f:
    html = f.read()

target = """            <div id="image-video-tab" class="tab-content">
                <div class="section" id="video-duration-container-image">
                    <label for="video-duration-select-image" class="label">Duracao do Video:</label>
                    <select id="video-duration-select-image" class="input">
                        <option value="6s">6s</option>
                        <option value="10s">10s</option>
                    </select>
                </div>"""

replacement = """            <div id="image-video-tab" class="tab-content">
                <div class="section">
                    <label class="label">Modo de Geração:</label>
                    <div class="radio-group" style="display: flex; gap: 15px; margin-bottom: 10px;">
                        <div class="radio-container">
                            <input type="radio" id="mode-image-image" name="generation-mode-image" value="image">
                            <label for="mode-image-image">Imagem</label>
                        </div>
                        <div class="radio-container">
                            <input type="radio" id="mode-video-image" name="generation-mode-image" value="video" checked>
                            <label for="mode-video-image">Vídeo</label>
                        </div>
                    </div>
                </div>

                <div class="section">
                    <label class="label">Proporção (Aspect Ratio):</label>
                    <select id="aspect-ratio-select-image" class="input" style="margin-bottom: 10px;">
                        <option value="1:1">Square (1:1)</option>
                        <option value="2:3">Portrait (2:3)</option>
                        <option value="3:2" selected>Landscape (3:2)</option>
                        <option value="9:16">Vertical (9:16)</option>
                        <option value="16:9">Widescreen (16:9)</option>
                    </select>

                    <div class="checkbox-container">
                        <input type="checkbox" id="toggle-randomize-image">
                        <label for="toggle-randomize-image" class="label">Randomizar proporção</label>
                    </div>

                    <div id="randomize-section-image"
                        style="display: none; margin-top: 10px; padding: 10px; border: 1px solid #ddd; border-radius: 4px;">
                        <label class="label" style="margin-bottom: 5px; display: block;">Incluir no sorteio:</label>
                        <div class="checkbox-container">
                            <input type="checkbox" class="random-option-image" value="1:1" id="random-image-1-1" checked>
                            <label for="random-image-1-1" class="label-small">Square (1:1)</label>
                        </div>
                        <div class="checkbox-container">
                            <input type="checkbox" class="random-option-image" value="2:3" id="random-image-2-3" checked>
                            <label for="random-image-2-3" class="label-small">Portrait (2:3)</label>
                        </div>
                        <div class="checkbox-container">
                            <input type="checkbox" class="random-option-image" value="3:2" id="random-image-3-2" checked>
                            <label for="random-image-3-2" class="label-small">Landscape (3:2)</label>
                        </div>
                        <div class="checkbox-container">
                            <input type="checkbox" class="random-option-image" value="9:16" id="random-image-9-16" checked>
                            <label for="random-image-9-16" class="label-small">Vertical (9:16)</label>
                        </div>
                        <div class="checkbox-container">
                            <input type="checkbox" class="random-option-image" value="16:9" id="random-image-16-9" checked>
                            <label for="random-image-16-9" class="label-small">Widescreen (16:9)</label>
                        </div>
                    </div>
                </div>

                <div class="section" id="video-duration-container-image">
                    <label for="video-duration-select-image" class="label">Duracao do Video:</label>
                    <select id="video-duration-select-image" class="input">
                        <option value="6s">6s</option>
                        <option value="10s">10s</option>
                    </select>
                </div>"""

if target in html:
    html = html.replace(target, replacement)
elif target.replace("\n", "\r\n") in html:
    html = html.replace(target.replace("\n", "\r\n"), replacement)
else:
    print("Nao encontrado")
    sys.exit(1)

with open('popup.html', 'w', encoding='utf-8') as f:
    f.write(html)
print("Sucesso")
