# Grok Prompt Automator 3.3

Extensão para automatizar envios no Grok Imagine (`https://grok.com/imagine`) com suporte a geração de imagens e vídeos. A extensão envia prompts em lote, aplica proporções, faz download automático e inclui o fluxo de Image-to-Video.

## Funcionalidades

### Interface
- Display de versão no header e no footer
- Botões para iniciar, parar e zerar fila
- Estado persistente mesmo após reabrir o popup

### Modos de geração
- Modo imagem com download automático
- Modo vídeo com upscale opcional
- Modo Image-to-Video com upload em lote de imagens

### Configurações
- Proporções fixas: `1:1`, `2:3`, `3:2`, `9:16`, `16:9`
- Randomização entre proporções selecionadas
- Delay configurável entre envios
- Pausa programada para lotes longos
- Subpasta personalizada para downloads

### Automação
- Overlay flutuante com status, prompt atual, progresso e tempo decorrido
- Persistência local de prompts e configurações
- Retomada automática após recarregamento da página
- Prevenção de downloads duplicados

## Requisitos

- Chrome ou Edge com suporte a Manifest V3
- Permissões: `storage`, `activeTab`, `scripting`, `downloads`
- Host permitido: `https://grok.com/*`

## Instalação

1. Clone ou baixe este repositório.
2. Abra `chrome://extensions` ou `edge://extensions`.
3. Ative o modo desenvolvedor.
4. Clique em `Carregar sem compactação`.
5. Selecione a pasta do projeto.

## Uso

1. Abra `https://grok.com/imagine`.
2. Abra o popup da extensão.
3. Escolha o modo de geração.
4. Informe a lista de prompts ou a fila de imagens.
5. Ajuste delay, proporção, resolução e duração conforme o modo.
6. Clique em `Iniciar automação`.

## Download automático

### Vídeo
- Detecta o vídeo gerado
- Aguarda upscale quando habilitado
- Tenta usar o botão oficial de download
- Faz fallback para download direto quando necessário

### Imagem
- Detecta a imagem gerada
- Aguarda o tempo de renderização
- Baixa a imagem no formato original

## Dicas

- Use a página `https://grok.com/imagine`
- Se a interface do Grok mudar, pode ser necessário atualizar seletores
- Para vídeos, prefira delays maiores
- Para lotes grandes, configure pausas automáticas

## Privacidade

- Os dados ficam em `chrome.storage.local`
- Nenhum dado é enviado para servidores externos
- A extensão não coleta informações pessoais

## Doação

Se a ferramenta te ajuda, você pode apoiar o projeto:

**[ko-fi.com/dentparanoide](https://ko-fi.com/dentparanoide)**

---

**Versão 3.3** | Desenvolvido com ❤️

## Changelog

### v3.3 (2026-03-30)
- Corrigido o fluxo de Image-to-Video para o novo layout do Grok
- Melhorada a detecção do botão de upload e da tray `Upload or drop images`

### v3.2
- Ajustes na interface e no badge de versão

### v1.4.0 (2025-12-29)
- Novas proporções `9:16` e `16:9`
- Suporte ampliado às proporções disponíveis no Grok

### v1.3.1 (2025-12-14)
- Corrigido download duplicado de vídeos
- Corrigido salvamento em subpasta configurada
- Corrigido download de vídeos SD
- Overlay agora limpa completamente ao zerar fila

### v1.3.0 (2025-12-14)
- Adicionado display de versão no header e no footer
- Adicionado botão `Zerar Fila`
- Melhorada a persistência do estado da automação
