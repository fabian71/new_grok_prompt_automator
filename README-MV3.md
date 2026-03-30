# Grok Prompt Automator - Manifest V3

## Descrição

Versão da extensão baseada em Manifest Version 3 (MV3). Automatiza o envio de prompts para o Grok Imagine com lista personalizada, controle de delay e suporte ao fluxo atual da interface.

## Principais mudanças do MV2 para MV3

### Manifest
- `manifest_version` atualizado de 2 para 3
- `browser_action` substituído por `action`
- `background.scripts` substituído por `background.service_worker`
- `permissions` separado de `host_permissions`
- `web_accessible_resources` adaptado para o formato de objetos com `matches`

### Background script
- Conversão para Service Worker
- Tratamento de erros mais consistente
- Compatibilidade mantida com messaging

### Storage e messaging
- Uso de Promises nas APIs principais
- Melhor tratamento de falhas assíncronas

### Popup e content script
- Conversão para `async/await`
- Tratamento de erros com `try/catch`
- Compatibilidade com o fluxo atual do Grok

## Estrutura

```text
grok-prompt-automator4/
├── manifest.json
├── popup.html
├── popup.css
├── popup.js
├── content.js
├── background.js
└── icons/
```

## Instalação

### Firefox
1. Abra `about:debugging`.
2. Clique em `Este Firefox`.
3. Clique em `Carregar extensão temporária...`.
4. Selecione o arquivo `manifest.json` da pasta `grok-prompt-automator4`.

### Chrome/Edge
1. Abra `chrome://extensions/` ou `edge://extensions/`.
2. Ative o modo desenvolvedor.
3. Clique em `Carregar sem compactação`.
4. Selecione a pasta `grok-prompt-automator4`.

## Compatibilidade

- Firefox: suporte a MV3
- Chrome: suporte a MV3
- Edge: suporte a MV3

## Benefícios do MV3

- Melhor segurança
- Menor uso de memória
- Compatibilidade com o modelo atual de extensões
- APIs mais modernas

## Migração de dados

Os dados salvos localmente continuam compatíveis, então não é necessário reconfigurar prompts ou settings ao migrar.
