// ==UserScript==
// @name         DeadLine Scanner: Anjun Express Edition (Mira Dinâmica + Auto-Clear Vue.js)
// @namespace    http://tampermonkey.net/
// @version      5.0
// @description  Aimbot focado no portal Vue.js da Anjun. Detecta automaticamente se o alvo é o Pacote ou a Saca (Lacre) e burla a reatividade do framework.
// @match        *://manage.anjunexpress.com/*
// @updateURL    https://raw.githubusercontent.com/IsaqueAmancio/anjunScanner/main/anjunScanner.user.js
// @downloadURL  https://raw.githubusercontent.com/IsaqueAmancio/anjunScanner/main/anjunScanner.user.js
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // Variáveis clássicas da sua arquitetura mantidas intactas
    let scannerContainer = null;
    let panelContainer = null;
    let videoElement = null;
    let scanAreaElement = null;
    let stream = null;
    let scanAnimation = null;
    let hardwareDetector = null;
    let hudInterval = null;

    let lockedTargetInputs = []; // Depreciado, mas mantido por legado tático
    let originalInputModes = [];
    let currentInputIndex = 0;   // Usaremos para lógica de fallback
    let lockedTargetButton = null;

    let lastScanTime = 0;
    const COOLDOWN_MS = 2000;

    const CONFIG = {
        // Como interceptamos TUDO que for JSON, deixamos a string vazia para pegar qualquer endpoint da API
        TARGET_URL_PART: '',
        DELAY_LIMPEZA_MS: 300
    };

    const hiddenCanvas = document.createElement('canvas');
    const ctx = hiddenCanvas.getContext('2d', { willReadFrequently: true });

    // ==========================================
    // MIRA DINÂMICA (NOVO CORE TÁTICO)
    // ==========================================
    // O Vue.js esconde e mostra elementos. Esta função acha o alvo que está REALMENTE visível.
    function obterAlvoDinamico() {
        // 1. Tenta achar o input do Lacre (Saca)
        const inputLacre = document.querySelector('input[placeholder="Escanear ou Inserir o número do saca"]');
        if (inputLacre) {
            // Verifica se o popup (dialog) pai dele está visível
            const dialog = inputLacre.closest('.el-dialog__wrapper');
            if (dialog && window.getComputedStyle(dialog).display !== 'none') {
                return { elemento: inputLacre, tipo: 'LACRE' };
            }
        }

        // 2. Se o Lacre não está visível, procura o input de Pacote
        const inputPacote = document.querySelector('input[placeholder="Favor de escanear"]');
        if (inputPacote) {
            return { elemento: inputPacote, tipo: 'PACOTE' };
        }

        return null; // Nenhum alvo na mira
    }

    // ==========================================
    // SISTEMA DE ALERTAS E AUTO-CLEAR
    // ==========================================
    const exibirPopupErro = (mensagem) => {
        const existente = document.getElementById('deadline-erro-popup');
        if (existente) existente.remove();

        const popup = document.createElement('div');
        popup.id = 'deadline-erro-popup';

        let cssBase = `
            background-color: #dc3545; color: white; padding: 15px 20px;
            border-radius: 8px; box-shadow: 0 4px 15px rgba(0,0,0,0.8);
            z-index: 9999999; font-size: 14px; font-family: Arial, sans-serif; font-weight: bold;
            transition: opacity 0.3s ease; border-left: 5px solid #881c24;
            pointer-events: none; width: 85%; max-width: 400px; text-align: center;
        `;

        if (scannerContainer) {
            popup.style.cssText = cssBase + `position: absolute; top: 20px; left: 50%; transform: translateX(-50%);`;
            scannerContainer.appendChild(popup);
        } else {
            popup.style.cssText = cssBase + `position: fixed; top: 20px; left: 50%; transform: translateX(-50%);`;
            document.body.appendChild(popup);
        }
        popup.innerHTML = `⚠️ <b>SISTEMA REJEITOU:</b><br>${mensagem}`;

        setTimeout(() => {
            popup.style.opacity = '0';
            setTimeout(() => popup.remove(), 300);
        }, 4000);
    };

    const limparCampoAtivoVue = () => {
        const alvo = obterAlvoDinamico();
        if (alvo && alvo.elemento) {
            const input = alvo.elemento;
            input.value = '';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }
    };

    // ==========================================
    // ESPIÃO DE REDE DUPLO (XHR + FETCH)
    // ==========================================
    const processarRespostaAnjun = (textoResposta) => {
        if (!textoResposta) return;
        try {
            const data = JSON.parse(textoResposta);
            // Verifica se a API da Anjun xingou a gente (code diferente de 200 é erro)
            if (data && data.code && data.code !== 200) {
                console.warn("[DeadLine Auto-Clear] Erro detetado: " + data.msg);
                setTimeout(() => {
                    exibirPopupErro(data.msg || "Erro misterioso no servidor.");
                    if (navigator.vibrate) navigator.vibrate([300, 200, 300]);
                    limparCampoAtivoVue();
                }, CONFIG.DELAY_LIMPEZA_MS);
            }
        } catch (e) {
            // Ignora se não for JSON válido
        }
    };

    // Intercepta Axios / XHR (Padrão em projetos Vue.js legados)
    const XHR_Open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
        this.addEventListener('load', function() {
            processarRespostaAnjun(this.responseText);
        });
        XHR_Open.apply(this, arguments);
    };

    // Intercepta Fetch (Projetos modernos)
    const fetchOriginal = window.fetch;
    window.fetch = async function(...args) {
        try {
            const response = await fetchOriginal.apply(this, args);
            const clone = response.clone();
            clone.text().then(processarRespostaAnjun).catch(() => {});
            return response;
        } catch (error) {
            setTimeout(() => {
                exibirPopupErro("Falha de conexão (Internet caiu).");
                if (navigator.vibrate) navigator.vibrate([300, 200, 300]);
                limparCampoAtivoVue();
            }, 300);
            throw error;
        }
    };

    // ==========================================
    // INTERFACE PRINCIPAL DO SCANNER
    // ==========================================
    function createControlPanel() {
        if (document.getElementById('deadline-control-panel')) return;

        panelContainer = document.createElement('div');
        panelContainer.id = 'deadline-control-panel';

        Object.assign(panelContainer.style, {
            position: 'fixed', bottom: '20px', right: '20px', zIndex: '999998',
            padding: '15px', backgroundColor: '#1e1e1e', border: '2px solid #555',
            borderRadius: '8px', boxShadow: '0 4px 15px rgba(0,0,0,0.5)',
            fontFamily: 'sans-serif', color: '#fff', display: 'flex',
            flexDirection: 'column', gap: '10px', width: '250px'
        });

        const titleText = document.createElement('div');
        titleText.innerHTML = '🎯 <b>DeadLine: Anjun Vue</b><br><small>Alvo Dinâmico Automático</small>';
        titleText.style.fontSize = '12px';
        titleText.style.textAlign = 'center';

        const scanBtn = document.createElement('button');
        scanBtn.innerText = '📸 Iniciar Câmera';
        Object.assign(scanBtn.style, {
            padding: '10px', cursor: 'pointer', backgroundColor: '#00ff00', color: '#000', border: 'none', borderRadius: '4px', fontWeight: 'bold'
        });

        scanBtn.onclick = () => {
            panelContainer.style.display = 'none';
            showScannerUI();
            initScannerLogic();
        };

        panelContainer.appendChild(titleText);
        panelContainer.appendChild(scanBtn);
        document.body.appendChild(panelContainer);
    }

    function showScannerUI() {
        if (document.getElementById('deadline-qr-wrapper')) return;

        scannerContainer = document.createElement('div');
        scannerContainer.id = 'deadline-qr-wrapper';
        Object.assign(scannerContainer.style, {
            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
            width: '90vw', maxWidth: '450px', height: '80vh', maxHeight: '750px',
            backgroundColor: '#000', borderRadius: '16px', zIndex: '999999',
            boxShadow: '0 10px 30px rgba(0,0,0,0.8)', overflow: 'hidden',
            display: 'flex', flexDirection: 'column'
        });

        const feedbackTop = document.createElement('div');
        feedbackTop.id = 'deadline-seq-feedback';
        feedbackTop.innerText = `Analisando alvos na tela...`;
        Object.assign(feedbackTop.style, {
            backgroundColor: '#3700b3', color: '#fff', fontWeight: 'bold',
            padding: '12px', textAlign: 'center', fontSize: '15px', zIndex: '2'
        });

        const videoWrapper = document.createElement('div');
        Object.assign(videoWrapper.style, { position: 'relative', flex: '1', width: '100%', overflow: 'hidden' });

        videoElement = document.createElement('video');
        videoElement.id = 'deadline-qr-video';
        Object.assign(videoElement.style, { width: '100%', height: '100%', objectFit: 'cover' });
        videoElement.autoplay = true;
        videoElement.playsInline = true;

        scanAreaElement = document.createElement('div');
        Object.assign(scanAreaElement.style, {
            position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
            width: '80%', aspectRatio: '2 / 1',
            boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.65)',
            border: '2px solid rgba(255,255,255,0.4)',
            zIndex: '1'
        });

        const closeBtn = document.createElement('button');
        closeBtn.innerText = 'ENCERRAR MISSÃO';
        Object.assign(closeBtn.style, {
            width: '100%', padding: '12px', cursor: 'pointer', backgroundColor: '#ff4500',
            color: '#fff', border: 'none', fontWeight: 'bold', fontSize: '14px', zIndex: '2'
        });
        closeBtn.onclick = stopScanner;

        videoWrapper.appendChild(videoElement);
        videoWrapper.appendChild(scanAreaElement);

        scannerContainer.appendChild(feedbackTop);
        scannerContainer.appendChild(videoWrapper);
        scannerContainer.appendChild(closeBtn);
        document.body.appendChild(scannerContainer);
    }

    async function initScannerLogic() {
        try {
            if (!('BarcodeDetector' in window)) {
                alert("DeadLine informa: Navegador sem API de BarcodeDetector nativa.");
                stopScanner();
                return;
            }

            hardwareDetector = new BarcodeDetector({ formats: ['qr_code', 'ean_13', 'code_128', 'code_39'] });

            stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 }, focusMode: "continuous" }
            });

            videoElement.srcObject = stream;

            videoElement.addEventListener('loadeddata', () => {
                scanFrameNative();
                hudInterval = setInterval(() => {
                    const alvo = obterAlvoDinamico();
                    const fb = document.getElementById('deadline-seq-feedback');
                    if (fb) {
                        fb.innerText = alvo ? `MIRA TRAVADA: ${alvo.tipo}` : `AGUARDANDO ALVO...`;
                        fb.style.backgroundColor = alvo ? (alvo.tipo === 'LACRE' ? '#ff9800' : '#00a551') : '#3700b3';
                    }
                }, 500);
            });
        } catch (err) {
            alert("Erro de Hardware: " + err.message);
            stopScanner();
        }
    }

    async function scanFrameNative() {
        if (!videoElement || videoElement.readyState !== videoElement.HAVE_ENOUGH_DATA) {
            scanAnimation = requestAnimationFrame(scanFrameNative);
            return;
        }

        try {
            const vWidth = videoElement.videoWidth;
            const vHeight = videoElement.videoHeight;
            const minDim = Math.min(vWidth, vHeight);

            const cropWidth = minDim * 0.85;
            const cropHeight = cropWidth * 0.5;

            const sx = (vWidth - cropWidth) / 2;
            const sy = (vHeight - cropHeight) / 2;

            hiddenCanvas.width = cropWidth;
            hiddenCanvas.height = cropHeight;
            ctx.drawImage(videoElement, sx, sy, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

            const barcodes = await hardwareDetector.detect(hiddenCanvas);

            if (barcodes.length > 0) {
                const resultText = barcodes[0].rawValue;
                const currentTime = Date.now();

                // Procura quem é o alvo atual na tela (Pacote ou Lacre)
                const alvo = obterAlvoDinamico();

                if (currentTime - lastScanTime >= COOLDOWN_MS && alvo) {
                    lastScanTime = currentTime;

                    if (navigator.vibrate) navigator.vibrate(150);

                    let targetElement = alvo.elemento;

                    // Magia Negra Vue.js: Força o setter nativo para burlar o Virtual DOM
                    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
                    if (nativeInputValueSetter) {
                        nativeInputValueSetter.call(targetElement, resultText);
                    } else {
                        targetElement.value = resultText;
                    }

                    // Dispara eventos para o Vue processar a mudança
                    targetElement.dispatchEvent(new Event('input', { bubbles: true }));
                    targetElement.dispatchEvent(new Event('change', { bubbles: true }));

                    // Simula o Enter
                    targetElement.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', keyCode: 13 }));
                    targetElement.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter', keyCode: 13 }));

                    targetElement.blur();
                    if(document.activeElement) document.activeElement.blur();

                    // Feedback Visual na Câmera
                    const originalBorder = scanAreaElement.style.borderColor;
                    scanAreaElement.style.border = '2px solid #00ff00';
                    setTimeout(() => { scanAreaElement.style.border = '2px solid rgba(255,255,255,0.4)'; }, 400);
                }
            }
        } catch (err) {
            // Ignorado por desempenho
        }

        scanAnimation = requestAnimationFrame(scanFrameNative);
    }

    function stopScanner() {
        if (scanAnimation) cancelAnimationFrame(scanAnimation);
        if (hudInterval) clearInterval(hudInterval);
        if (stream) stream.getTracks().forEach(track => track.stop());
        if (scannerContainer) scannerContainer.remove();
        if (panelContainer) panelContainer.style.display = 'flex';

        stream = null;
        scannerContainer = null;
        hardwareDetector = null;
    }

    if (document.readyState === 'complete') {
        createControlPanel();
    } else {
        window.addEventListener('load', createControlPanel);
    }

})();