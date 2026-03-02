# Grok Prompt Automator 3.0

Extensão para automatizar envios no Grok Imagine (`https://grok.com/imagine`) com suporte completo para **geração de imagens e vídeos**: envia prompts em lote, aplica proporções, faz upscale de vídeos e baixa os arquivos gerados automaticamente.

## ✨ Funcionalidades

### Interface
- **Display de Versão**: Badge no header e versão no footer
- **Controles Aprimorados**: Botões para Iniciar, Parar e Zerar Fila
- **Estado Persistente**: Botão "Parar" funciona mesmo após reabrir o popup

### Modos de Geração
- **Modo Vídeo**: Geração de vídeos com upscale opcional (Beta)
- **Modo Imagem**: Geração de imagens com download automático

### Configurações de Proporção
- Proporção fixa: **1:1 (Square)**, **2:3 (Portrait)**, **3:2 (Landscape)**, **9:16 (Vertical)**, **16:9 (Widescreen)**
- **Randomização**: Sorteia automaticamente entre as proporções selecionadas

### Download Automático
- Download automático de vídeos e imagens gerados via extensão
- Garante salvamento na subpasta configurada
- Previne downloads duplicados
- Salva prompt em arquivo .txt (opcional)
- Subpasta personalizável dentro de Downloads

### Upscale de Vídeo (Beta)
- Ativa automaticamente o upscale do vídeo após geração
- Aguarda a conclusão do upscale antes de baixar

### ⚙️ Configurações Especiais
- **Pausa Programada**: A cada X prompts, o script pausa por Y minutos
- Padrão: Pausa de 3 minutos a cada 90 prompts
- Ideal para longas sessões de geração, evitando sobrecarga
- **Botão Zerar Fila**: Para a automação e limpa completamente a fila

### Overlay Flutuante
- Exibe em tempo real na página do Grok:
  - Status atual (gerando, upscale, pausa, concluído)
  - Prompt sendo processado
  - Progresso (X de Y prompts)
  - Tempo decorrido
  - Barra de progresso visual
  - Informação de próxima pausa (quando aplicável)
  - Contagem regressiva durante pausas
  - Limpa automaticamente ao zerar fila

### Persistência
- Prompts e configurações salvos localmente
- Retoma automação após recarregamento da página

## ⚠️ Avisos Inteligentes

- **Modo Vídeo**: Alerta se delay < 40 segundos (recomendado para upscale)
- **Modo Imagem**: Alerta se delay < 20 segundos (pode causar falha no download)

## 📋 Requisitos

- Chrome/Edge com suporte a Manifest V3
- Permissões: `storage`, `activeTab`, `scripting`, `downloads`
- Host: `https://grok.com/*`

## 🔧 Instalação (Modo Desenvolvedor)

1. Baixe/clone este repositório para uma pasta local
2. Abra `chrome://extensions` (ou `edge://extensions`)
3. Ative o **"Modo do desenvolvedor"**
4. Clique em **"Carregar sem compactação"** e selecione a pasta do projeto

## 🚀 Como Usar

1. Abra `https://grok.com/imagine` e aguarde carregar
2. Clique no ícone da extensão para abrir o popup
3. Selecione o **Modo de Geração**: Imagem ou Vídeo
4. Cole sua lista de prompts (um por linha)
5. Ajuste o **Delay entre envios**:
   - Vídeo com upscale: recomendado ≥45s
   - Vídeo sem upscale: recomendado ≥40s
   - Imagem: recomendado ≥20s
6. Configure a proporção (fixa ou aleatória)
7. (Opcional) Ative **Upscale Vídeo (Beta)** no modo vídeo
8. (Opcional) Configure **Pausas Programadas** para sessões longas
9. (Opcional) Defina uma subpasta para downloads
10. Clique em **"Iniciar automação"**
11. Acompanhe o progresso no overlay flutuante

## 📥 Como o Download Funciona

### Vídeo
- Detecta vídeos via `generated_video.mp4` no src
- Se upscale ativo: aguarda conclusão do upscale
- Tenta clicar no botão oficial "BAIXAR"
- Fallback: baixa via src do vídeo (blob:/data:)
- Arquivo salvo como `.mp4`

### Imagem
- Detecta imagens geradas no container
- Aguarda tempo de renderização (delay - 8 segundos)
- Baixa automaticamente a imagem em formato original
- Nome baseado no prompt + timestamp

## 💡 Dicas e Solução de Problemas

- Certifique-se de estar em `https://grok.com/imagine`
- Se nada acontecer, recarregue a página e tente novamente
- Verifique se o popup mostra "Conectado à página do Grok Imagine"
- Para vídeos com upscale, use delays maiores (≥45s)
- Configure pausas programadas para lotes grandes (>90 prompts)
- Console do Service Worker: `chrome://extensions` > Detalhes > Service Worker

## ⚡ Limitações Conhecidas

- Seletores dependem da estrutura atual do Grok Imagine
- Se o Grok alterar o DOM, pode ser necessário atualizar seletores
- Upscale de vídeo depende da disponibilidade do recurso no Grok

## 🔒 Privacidade

- Todos os dados ficam no `chrome.storage.local` do navegador
- Nenhum dado é enviado para servidores externos
- A extensão não coleta informações pessoais

## ☕ Doação

Se esta ferramenta te ajuda, considere apoiar o projeto:

**[ko-fi.com/dentparanoide](https://ko-fi.com/dentparanoide)**

---

**Versão 1.4.0** | Desenvolvido com ❤️

## 📝 Changelog

### v1.4.0 (2025-12-29)
- ✨ Novas proporções: **9:16 (Vertical)** e **16:9 (Widescreen)**
- 🎨 Atualizado para suportar todas as proporções disponíveis no Grok

### v1.3.1 (2025-12-14)
- 🐛 Corrigido download duplicado de vídeos
- 🐛 Corrigido vídeos não sendo salvos na subpasta configurada
- 🐛 Corrigido vídeos SD não sendo baixados
- 🐛 Overlay flutuante agora limpa completamente ao zerar fila

### v1.3.0 (2025-12-14)
- ✨ Display de versão no header (badge) e footer
- ✨ Botão "🔄 Zerar Fila" para limpar completamente a automação
- ✨ Estado de automação persistente (botão "Parar" funciona após reabrir popup)
- 🔧 Melhorias na lógica de download para garantir pasta correta
