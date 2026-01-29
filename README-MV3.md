# Whisk Prompt Automator - Manifest V3

## Descrição
Versão atualizada da extensão para Firefox usando Manifest Version 3 (MV3). Automatiza o envio de prompts para o Google Whisk com lista personalizada e controle de delay.

## Principais Mudanças do MV2 para MV3

### 1. Manifest.json
- **manifest_version**: Atualizado de 2 para 3
- **browser_action**: Substituído por **action**
- **background.scripts**: Substituído por **background.service_worker**
- **permissions**: Separado em **permissions** e **host_permissions**
- **web_accessible_resources**: Agora requer formato de objeto com matches

### 2. Background Script
- Convertido de script persistente para **Service Worker**
- Adicionado tratamento de erros com `.catch()`
- Mantém compatibilidade com APIs de messaging

### 3. APIs de Storage e Messaging
- **chrome.storage.local.get()**: Agora retorna Promise
- **chrome.storage.local.set()**: Agora retorna Promise
- **chrome.runtime.sendMessage()**: Agora retorna Promise
- Adicionado tratamento de erros para todas as operações assíncronas

### 4. Popup Script
- Convertido callbacks para async/await
- Adicionado tratamento de erros com try/catch
- Mantém funcionalidade idêntica ao MV2

### 5. Content Script
- Adicionado tratamento de erros para messaging
- Mantém toda a funcionalidade de automação
- Compatível com Service Worker

## Funcionalidades (Inalteradas)
- ✅ Interface intuitiva para gerenciar lista de prompts
- ✅ Configuração de delay personalizável entre envios
- ✅ Armazenamento local dos prompts e configurações
- ✅ Automação robusta com detecção de elementos DOM
- ✅ Simulação de digitação humana
- ✅ Controles de iniciar/parar automação
- ✅ Feedback em tempo real do progresso
- ✅ Tratamento de erros e recuperação

## Estrutura dos Arquivos MV3
```
whisk-extension-mv3/
├── manifest.json          # Manifest V3
├── popup.html             # Interface (inalterada)
├── popup.css              # Estilos (inalterados)
├── popup.js               # Lógica MV3 com Promises
├── content.js             # Script MV3 com error handling
├── background.js          # Service Worker MV3
└── icons/                 # Ícones (inalterados)
    ├── icon-16.png
    ├── icon-32.png
    ├── icon-48.png
    └── icon-128.png
```

## Instalação MV3

### Firefox (Manifest V3)
1. Abra o Firefox
2. Digite `about:debugging` na barra de endereços
3. Clique em "Este Firefox"
4. Clique em "Carregar extensão temporária..."
5. Selecione o arquivo `manifest.json` da pasta `whisk-extension-mv3`

### Chrome/Edge (Manifest V3)
1. Abra Chrome/Edge
2. Vá para `chrome://extensions/` ou `edge://extensions/`
3. Ative o "Modo do desenvolvedor"
4. Clique em "Carregar sem compactação"
5. Selecione a pasta `whisk-extension-mv3`

## Compatibilidade
- **Firefox**: Suporte completo ao MV3
- **Chrome**: Suporte completo ao MV3
- **Edge**: Suporte completo ao MV3
- **Safari**: Não testado (requer adaptações específicas)

## Benefícios do MV3
- **Segurança aprimorada**: Service Workers são mais seguros
- **Performance melhor**: Menor uso de memória
- **Compatibilidade futura**: Suporte garantido até 2030+
- **APIs modernas**: Promises nativas em todas as APIs

## Migração de Dados
A extensão MV3 é totalmente compatível com dados salvos pela versão MV2. Não é necessário reconfigurar prompts ou settings.

## Troubleshooting MV3
- **Service Worker inativo**: Normal, ativa automaticamente quando necessário
- **Promises rejeitadas**: Verificar console para detalhes do erro
- **Messaging falha**: Verificar se content script está carregado
- **Storage não funciona**: Verificar permissões de storage

## Diferenças Técnicas Principais

### Callbacks → Promises
```javascript
// MV2 (Callback)
chrome.storage.local.get(['prompts'], function(result) {
    console.log(result.prompts);
});

// MV3 (Promise)
chrome.storage.local.get(['prompts']).then((result) => {
    console.log(result.prompts);
});
```

### Background Script → Service Worker
```javascript
// MV2 (Background Script)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Lógica
});

// MV3 (Service Worker)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Lógica + error handling
    return true; // Manter canal aberto
});
```

