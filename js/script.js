// ========== 解析 AT 指令 ==========
parseATCommand = function(text) {
    const cleanedText = text.trim();
    const result = { command: '', params: [], original: text };
    if (!cleanedText.toUpperCase().startsWith('AT')) return undefined;
    const pattern = /^AT\+([A-Z]+)=([^,]+(?:,[^,]+)*)$/i;
    const match = cleanedText.match(pattern);
    if (!match) {
        const noParamsPattern = /^AT\+([A-Z]+)$/i;
        const noParamsMatch = cleanedText.match(noParamsPattern);
        if (noParamsMatch) {
            result.command = noParamsMatch[1].toUpperCase();
            return result;
        }
        return undefined;
    }
    result.command = match[1].toUpperCase();
    result.params = match[2].split(',').map(param => {
        const trimmedParam = param.trim();
        const num = parseFloat(trimmedParam);
        return isNaN(num) ? trimmedParam : num;
    });
    return result;
}

// ========== 全局变量 ==========
let serialPort = null;
let reader = null;
let writer = null;
let isConnected = false;

// ========== 热成像显示常量 ==========
// 子车将 32×24 原始温度帧下采样为 16×12（2×2 块平均），每格 1 字节强度
// （温度 20~40℃ 映射为 0~255）。
// 帧格式（二进制）：0xAA 0x55 + 192 字节载荷，共 194 字节/帧。
// 9600bps 下每帧约 202ms，1Hz 回传不会积压。
const FRAME_HEADER = [0xAA, 0x55];             // 帧头
const FRAME_LENGTH = 194;                      // 2 字节帧头 + 192 字节载荷
const FRAME_PAYLOAD_OFFSET = 2;                // 载荷起始偏移
const HEAT_COLS = 16;                          // 显示列数
const HEAT_ROWS = 12;                          // 显示行数
const HEAT_PIXELS = HEAT_COLS * HEAT_ROWS;     // 192 个强度值

// ========== 摇杆控制类 ==========
class JoystickController {
    constructor(joystickId, commandPrefix) {
        this.joystick = document.getElementById(joystickId);
        this.handle = this.joystick.querySelector('.joystick-handle');
        this.commandPrefix = commandPrefix;
        this.isDragging = false;
        this.centerX = 0;
        this.centerY = 0;
        this.radius = 0;
        this.lastSendTime = 0;
        this.init();
    }

    init() {
        this.joystick.addEventListener('mousedown', this.startDrag.bind(this));
        this.joystick.addEventListener('touchstart', this.startDrag.bind(this));
        document.addEventListener('mousemove', this.drag.bind(this));
        document.addEventListener('touchmove', this.drag.bind(this));
        document.addEventListener('mouseup', this.endDrag.bind(this));
        document.addEventListener('touchend', this.endDrag.bind(this));
    }

    startDrag(e) {
        e.preventDefault();
        this.isDragging = true;
        this.updatePosition(e);
    }

    drag(e) {
        if (!this.isDragging) return;
        e.preventDefault();
        this.updatePosition(e);
    }

    endDrag() {
        if (!this.isDragging) return;
        this.isDragging = false;
        this.handle.style.transform = 'translate(-50%, -50%)';
        this.sendCommand(0, 0.5);
    }

    updatePosition(e) {
        const rect = this.joystick.getBoundingClientRect();
        this.centerX = rect.width / 2;
        this.centerY = rect.height / 2;
        this.radius = rect.width / 2;
        let clientX, clientY;
        if (e.type.includes('touch')) {
            clientX = e.touches[0].clientX;
            clientY = e.touches[0].clientY;
        } else {
            clientX = e.clientX;
            clientY = e.clientY;
        }
        const x = clientX - rect.left - this.centerX;
        const y = clientY - rect.top - this.centerY;
        const distance = Math.sqrt(x * x + y * y);
        const limitedDistance = Math.min(distance, this.radius);
        const angle = Math.atan2(y, x);
        const limitedX = limitedDistance * Math.cos(angle);
        const limitedY = limitedDistance * Math.sin(angle);
        this.handle.style.transform = `translate(calc(-50% + ${limitedX}px), calc(-50% + ${limitedY}px))`;
        const speed = Math.round(-limitedY / this.radius * 255);
        const weight = Math.round((limitedX / this.radius + 1) / 2 * 100) / 100;
        const currentTime = Date.now();
        if (!(window.app && typeof window.app.sendData === 'function') || currentTime - this.lastSendTime >= window.app.getSetting('throttleInterval')) {
            this.sendCommand(speed, weight);
            this.lastSendTime = currentTime;
        }
    }

    sendCommand(speed, weight) {
        const command = `AT+${this.commandPrefix}=${speed},${weight}\r\n`;
        if (window.app && typeof window.app.sendData === 'function') {
            window.app.sendData(command);
        }
    }
}

// ========== 主应用类 ==========
class App {
    constructor() {
        this.buffer = new Uint8Array(0);  // 串口二进制累积缓冲
        this.heatMapData = null;          // 热成像强度数据 Uint8Array(192)，0~255
        this.heatOpacity = 0.65;          // 热成像覆盖层透明度（0~1）
        this.init();
    }

    init() {
        this.initEventListeners();
        this.restoreSettings();
        this.updateNavigation();
        this.updateTextContent();
        new JoystickController('joystick-small', 'MOVES');
    }

    initEventListeners() {
        document.querySelectorAll('.nav-item').forEach(item => {
            item.addEventListener('click', (e) => this.handlePageSwitch(e));
        });
        document.getElementById('language-selector').addEventListener('change', (e) => {
            this.setLanguage(e.target.value);
        });
        document.getElementById('theme-selector').addEventListener('change', (e) => {
            this.setTheme(e.target.value);
        });
        document.getElementById('throttle-selector').addEventListener('change', (e) => {
            this.setThrottleInterval(e.target.value);
        });
        document.getElementById('debug-toggle').addEventListener('change', (e) => {
            this.setDebugMode(e.target.checked);
        });
        document.getElementById('heat-opacity').addEventListener('input', (e) => {
            this.setHeatOpacity(e.target.value);
        });
        document.getElementById('connect-btn').addEventListener('click', () => {
            this.handleSerialConnection();
        });
        var openedCamera = false;
        document.getElementById('camera-blocker').addEventListener('click', () => {
            if (!openedCamera) {
                this.openCamera();
                openedCamera = true;
            }
        });
        document.getElementById('door-open-btn').addEventListener('click', () => {
            this.sendData('AT+DOOR=1\r\n');
        });
        document.getElementById('door-close-btn').addEventListener('click', () => {
            this.sendData('AT+DOOR=0\r\n');
        });
        document.getElementById('brake-small-btn').addEventListener('click', () => {
            this.sendData('AT+BRAKES\r\n');
        });
        window.addEventListener('resize', () => this.updateNavigation());
        window.addEventListener('orientationchange', () => this.updateNavigation());
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
            const savedTheme = this.getSetting('theme') || CONFIG.defaultTheme;
            if (savedTheme === 'auto') {
                this.setTheme('auto');
            }
        });
    }

    // ========== 相机与热力图叠加 ==========
    async openCamera() {
        this.heatMapData = null;
        const blockerElement = document.getElementById('camera-blocker');
        const videoElement = document.getElementById('camera-showcase');
        const canvasElement = document.getElementById('camera-canvas');
        const canvasContext = canvasElement.getContext('2d');
        const constraints = {
            video: {
                facingMode: { ideal: 'environment' },
                width: { ideal: 1280 },
                height: { ideal: 720 }
            },
            audio: false
        };
        try {
            videoElement.srcObject = await navigator.mediaDevices.getUserMedia(constraints);
            await new Promise((resolve) => {
                videoElement.onloadedmetadata = () => {
                    canvasElement.width = videoElement.videoWidth;
                    canvasElement.height = videoElement.videoHeight;
                    resolve();
                };
            });
            await videoElement.play();
            const draw = (_this) => {
                canvasContext.clearRect(0, 0, canvasElement.width, canvasElement.height);
                canvasContext.drawImage(videoElement, 0, 0, canvasElement.width, canvasElement.height);
                // 纯方块像素叠加：16×12 网格，每个强度值画一个实心色块
                if (_this.heatMapData && _this.heatMapData.length === HEAT_PIXELS) {
                    const cellWidth = canvasElement.width / HEAT_COLS;
                    const cellHeight = canvasElement.height / HEAT_ROWS;
                    canvasContext.globalAlpha = _this.heatOpacity;
                    for (let y = 0; y < HEAT_ROWS; y++) {
                        for (let x = 0; x < HEAT_COLS; x++) {
                            const intensity = _this.heatMapData[y * HEAT_COLS + x];
                            canvasContext.fillStyle = _this.getThermalColor(intensity);
                            canvasContext.fillRect(x * cellWidth, y * cellHeight, cellWidth, cellHeight);
                        }
                    }
                    canvasContext.globalAlpha = 1;
                }
                requestAnimationFrame(() => draw(_this));
            };
            draw(this);
            blockerElement.classList.add('hidden');
        } catch (error) {
            console.error('无法打开相机:', error);
            blockerElement.textContent = LanguageUtils.getTranslation('device.camera.blocker.error');
        }
    }

    handlePageSwitch(event) {
        const target = event.currentTarget;
        const page = target.getAttribute('data-page');
        document.querySelectorAll('.nav-item').forEach(nav => nav.classList.remove('active'));
        target.classList.add('active');
        document.querySelectorAll('.page').forEach(pageEl => pageEl.classList.remove('active'));
        document.getElementById(`${page}-page`).classList.add('active');
    }

    setLanguage(lang) {
        if (LanguageUtils.setCurrentLanguage(lang)) {
            document.documentElement.lang = lang;
            this.updateTextContent();
            this.saveSetting('lang', lang);
        }
    }

    updateTextContent() {
        const currentLang = LanguageUtils.getCurrentLanguage();
        document.title = LanguageUtils.getTranslation('title', currentLang);
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            const translation = LanguageUtils.getTranslation(key, currentLang);
            if (translation !== key) el.textContent = translation;
        });
        document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
            const key = el.getAttribute('data-i18n-placeholder');
            const translation = LanguageUtils.getTranslation(key, currentLang);
            if (translation !== key) el.placeholder = translation;
        });
        document.querySelectorAll('option[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            const translation = LanguageUtils.getTranslation(key, currentLang);
            if (translation !== key) el.textContent = translation;
        });
        this.updateConnectionUI(isConnected);
    }

    setTheme(theme) {
        const html = document.documentElement;
        if (theme === 'auto') {
            if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
                html.setAttribute('data-theme', 'dark');
            } else {
                html.setAttribute('data-theme', 'light');
            }
        } else {
            html.setAttribute('data-theme', theme);
        }
        this.saveSetting('theme', theme);
    }

    setThrottleInterval(interval) {
        this.saveSetting('throttleInterval', interval);
    }

    // 设置热成像覆盖层透明度（0~100）
    setHeatOpacity(value) {
        const opacity = Math.max(0, Math.min(100, parseInt(value, 10) || 0));
        this.heatOpacity = opacity / 100;
        document.getElementById('heat-opacity-value').textContent = `${opacity}%`;
        this.saveSetting('heatOpacity', opacity);
    }

    setDebugMode(debug) {
        document.getElementById('data-monitor-card').style.display = debug ? 'block' : 'none';
        if (debug) console.log('调试模式已启用');
        this.saveSetting('debug', debug);
    }

    async handleSerialConnection() {
        if (isConnected) {
            await this.disconnectSerial();
        } else {
            await this.connectSerial();
        }
    }

    async connectSerial() {
        try {
            if (!('serial' in navigator)) {
                alert(LanguageUtils.getTranslation('browserNotSupported'));
                return;
            }
            const port = await navigator.serial.requestPort();
            const baudRate = parseInt(document.getElementById('baudrate-selector').value);
            await port.open({ baudRate });
            serialPort = port;
            isConnected = true;
            this.updateConnectionUI(true);
            this.readSerialData();
        } catch (error) {
            console.error('连接串口失败:', error);
        }
    }

    async disconnectSerial() {
        if (reader) {
            reader.cancel();
            reader = null;
        }
        if (writer) {
            await writer.close();
            writer = null;
        }
        if (serialPort) {
            await serialPort.close();
            serialPort = null;
        }
        isConnected = false;
        this.updateConnectionUI(false);
    }

    updateConnectionUI(connected) {
        const statusElement = document.getElementById('connection-status');
        const connectButton = document.getElementById('connect-btn');
        if (connected) {
            statusElement.className = 'status-indicator status-connected';
            statusElement.querySelector('span').textContent =
                LanguageUtils.getTranslation('device.status.connected');
            connectButton.querySelector('.btn-text').textContent =
                LanguageUtils.getTranslation('device.serial.disconnect');
            document.querySelectorAll('[data-show-when-connected]').forEach(el => {
                el.style.display = 'block';
            });
        } else {
            statusElement.className = 'status-indicator status-disconnected';
            statusElement.querySelector('span').textContent =
                LanguageUtils.getTranslation('device.status.disconnected');
            connectButton.querySelector('.btn-text').textContent =
                LanguageUtils.getTranslation('device.serial.connect');
            document.querySelectorAll('[data-show-when-connected]').forEach(el => {
                el.style.display = 'none';
            });
        }
    }

async readSerialData() {
    if (!serialPort || !serialPort.readable) return;
    reader = serialPort.readable.getReader();
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) {
                const newBuffer = new Uint8Array(this.buffer.length + value.length);
                newBuffer.set(this.buffer);
                newBuffer.set(value, this.buffer.length);
                this.buffer = newBuffer;
                this.processThermalFrames();
            }
        }
    } catch (error) {
        console.error('读取数据失败:', error);
    } finally {
        reader.releaseLock();
    }
}

findFrameHeader(buf, startIdx = 0) {
    for (let i = startIdx; i <= buf.length - 2; i++) {
        if (buf[i] === FRAME_HEADER[0] && buf[i + 1] === FRAME_HEADER[1]) {
            return i;
        }
    }
    return -1;
}

// ---------- 帧解析主循环（防止错位与丢帧） ----------
processThermalFrames() {
    const buf = this.buffer;
    let start = 0;

    while (start <= buf.length - FRAME_LENGTH) {
        const headerIdx = this.findFrameHeader(buf, start);
        
        // 找不到帧头：保留最后1个字节（防止0xAA被截断），其余丢弃
        if (headerIdx === -1) {
            this.buffer = buf.length > 0 ? buf.slice(buf.length - 1) : new Uint8Array(0);
            return;
        }

        // 找到帧头但数据不够：保留从帧头开始的所有数据
        if (headerIdx + FRAME_LENGTH > buf.length) {
            this.buffer = buf.slice(headerIdx);
            return;
        }

        // 提取完整帧并解析
        const frame = buf.slice(headerIdx, headerIdx + FRAME_LENGTH);
        this.parseThermalFrame(frame);
        
        if (window.app && typeof window.app.displayData === 'function') {
            this.displayData(`[HEAT frame ${frame.length} bytes]`, 'received');
        }

        // 跳过已处理的数据
        start = headerIdx + FRAME_LENGTH;
    }

    // 处理完所有完整帧后，保留剩余不完整数据
    this.buffer = start < buf.length ? buf.slice(start) : new Uint8Array(0);
}

parseThermalFrame(frame) {
    // 载荷即 192 个强度字节（行优先），水平翻转以匹配模块视角（Col1 在右上角）
    const data = new Uint8Array(HEAT_PIXELS);
    for (let gy = 0; gy < HEAT_ROWS; gy++) {
        for (let gx = 0; gx < HEAT_COLS; gx++) {
            const intensity = frame[FRAME_PAYLOAD_OFFSET + gy * HEAT_COLS + gx];
            const x = HEAT_COLS - 1 - gx;
            data[gy * HEAT_COLS + x] = intensity;
        }
    }
    this.heatMapData = data;
}

// ---------- 颜色映射：蓝(0,0,255) → 红(255,0,0)，透明度由绘制循环的 globalAlpha 统一控制 ----------
getThermalColor(value) {
    const normalized = Math.max(0, Math.min(255, value)) / 255; // 0~1
    const r = Math.round(normalized * 255);
    const b = Math.round((1 - normalized) * 255);
    return `rgb(${r}, 0, ${b})`;
}

    processLine(line) {
        // 2. 其他 AT 指令
        const command = parseATCommand(line);
        if (command) {
            switch (command.command) {
                case 'LOCATION':
                    document.getElementById('location-map-frame').contentWindow.postMessage({
                        type: 'addTrackPoint',
                        lon: command.params[0],
                        lat: command.params[1]
                    }, '*');
                    document.getElementById('map-location').textContent = `(${command.params[0]}, ${command.params[1]})`;
                    document.getElementById('map-lastUpdate').textContent = new Date().toLocaleTimeString();
                    break;
                case 'ENVIRONMENT':
                    document.getElementById('environmentSensor-temperature').textContent = command.params[0];
                    document.getElementById('environmentSensor-humidity').textContent = command.params[1];
                    document.getElementById('environmentSensor-lastUpdate').textContent = new Date().toLocaleTimeString();
                    break;
            }
            this.displayData(line, 'received');
        }
    }

    // 发送文本指令（摇杆、门控等）
    async sendData(data) {
        if (!data.trim()) return;
        if (!serialPort || !serialPort.writable) {
            alert(LanguageUtils.getTranslation('serialNotConnected'));
            return;
        }
        try {
            const textEncoder = new TextEncoder();
            const dataArray = textEncoder.encode(data);
            writer = serialPort.writable.getWriter();
            await writer.write(dataArray);
            await writer.releaseLock();
            writer = null;
            this.displayData(data, 'sent');
        } catch (error) {
            console.error(error);
        }
    }

    displayData(data, type) {
        const dataMonitor = document.getElementById('data-monitor');
        if (!dataMonitor) return;
        const timestamp = new Date().toLocaleTimeString();
        const color = type === 'sent' ? 'var(--primary-color)' : 'var(--text-color)';
        dataMonitor.innerHTML += `<div style="color: ${color};">${timestamp}: ${data}</div>`;
        dataMonitor.scrollTop = dataMonitor.scrollHeight;
    }

    saveSetting(key, value) {
        localStorage.setItem(CONFIG.storagePrefix + key, value.toString());
    }

    getSetting(key) {
        return localStorage.getItem(CONFIG.storagePrefix + key);
    }

    restoreSettings() {
        const savedLang = this.getSetting('lang') || CONFIG.defaultLanguage;
        document.getElementById('language-selector').value = savedLang;
        this.setLanguage(savedLang);

        const savedTheme = this.getSetting('theme') || CONFIG.defaultTheme;
        document.getElementById('theme-selector').value = savedTheme;
        this.setTheme(savedTheme);

        const savedThrottle = this.getSetting('throttleInterval') || 200;
        document.getElementById('throttle-selector').value = savedThrottle;
        this.setThrottleInterval(savedThrottle);

        const savedDebug = this.getSetting('debug') === 'true';
        document.getElementById('debug-toggle').checked = savedDebug;
        this.setDebugMode(savedDebug);

        const savedHeatOpacity = this.getSetting('heatOpacity') !== null
            ? parseInt(this.getSetting('heatOpacity'), 10) : 65;
        document.getElementById('heat-opacity').value = savedHeatOpacity;
        this.setHeatOpacity(savedHeatOpacity);
    }

    updateNavigation() {
        const isLandscape = window.matchMedia("(orientation: landscape) and (min-width: 768px)").matches;
        const navSide = document.querySelector('.navigation');
        const navBottom = document.querySelector('.nav-bottom');
        if (isLandscape) {
            navSide.style.display = 'flex';
            if (navBottom) navBottom.style.display = 'none';
        } else {
            navSide.style.display = 'none';
            if (navBottom) navBottom.style.display = 'flex';
        }
    }
}

// 应用启动
document.addEventListener('DOMContentLoaded', () => {
    window.app = new App();
});