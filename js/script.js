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
const HEAT_COLS = 32;              // 温度点阵列数
const HEAT_ROWS = 24;              // 温度点阵行数
const HEAT_PIXELS = HEAT_COLS * HEAT_ROWS; // 768 个温度点
const HEAT_TEMP_MIN = 20;          // 显示映射温度下限（℃）
const HEAT_TEMP_MAX = 45;          // 显示映射温度上限（℃）
const HEAT_RENDER_SCALE = 8;       // 热成像离屏渲染放大倍数（32×24 → 256×192）

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
        this.buffer = '';               // 文本行缓冲区
        this.heatMapData = null;        // 热成像温度数据 Float32Array(768)，单位 ℃
        this.heatOpacity = 0.65;        // 热成像覆盖层透明度（0~1）
        this.heatCanvas = null;         // 热成像离屏画布（双线性插值渲染结果）
        this.heatCtx = null;
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
            // 初始化热成像离屏画布：先用双线性插值渲染到低分辨率，
            // 再在绘制时平滑放大到视频尺寸，兼顾平滑度与性能
            this.heatCanvas = document.createElement('canvas');
            this.heatCanvas.width = HEAT_COLS * HEAT_RENDER_SCALE;
            this.heatCanvas.height = HEAT_ROWS * HEAT_RENDER_SCALE;
            this.heatCtx = this.heatCanvas.getContext('2d');
            if (this.heatMapData) this.renderHeatCanvas();
            canvasContext.imageSmoothingEnabled = true;
            const draw = (_this) => {
                canvasContext.clearRect(0, 0, canvasElement.width, canvasElement.height);
                canvasContext.drawImage(videoElement, 0, 0, canvasElement.width, canvasElement.height);
                if (_this.heatCanvas) {
                    canvasContext.globalAlpha = _this.heatOpacity;
                    canvasContext.drawImage(_this.heatCanvas, 0, 0, canvasElement.width, canvasElement.height);
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

    // ========== 串口数据读取（文本模式） ==========
    async readSerialData() {
        if (!serialPort || !serialPort.readable) return;
        const textDecoder = new TextDecoder();
        reader = serialPort.readable.getReader();
        let incompleteLine = '';
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                if (value) {
                    const text = textDecoder.decode(value, { stream: true });
                    incompleteLine += text;
                    const lines = incompleteLine.split(/\r?\n/);
                    incompleteLine = lines.pop(); // 保留不完整行
                    for (const line of lines) {
                        if (line.trim()) this.processLine(line.trim());
                    }
                }
            }
        } catch (error) {
            console.error('读取数据失败:', error);
        } finally {
            reader.releaseLock();
        }
    }

    processLine(line) {
        // 1. 热成像指令：AT+HEAT=<3072个十六进制字符>（768 点 × 2 字节，温度放大 100 倍）
        const heatMatch = line.match(/^AT\+HEAT=(.+)$/i);
        if (heatMatch) {
            this.handleHeatData(heatMatch[1]);
            this.displayData(`[HEAT] ${heatMatch[1].substring(0, 20)}...`, 'received');
            return;
        }
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

    // 将 3072 个 hex 字符（768 点 × 2 字节，低字节在前）解析为温度数组（℃）
    handleHeatData(hexData) {
        try {
            if (hexData.length < HEAT_PIXELS * 2) {
                console.error('热源数据长度不足:', hexData.length);
                return;
            }
            const data = new Float32Array(HEAT_PIXELS);
            for (let i = 0; i < HEAT_PIXELS; i++) {
                const low  = parseInt(hexData.substr(i * 2, 2), 16);
                const high = parseInt(hexData.substr(i * 2 + 2, 2), 16);
                if (isNaN(low) || isNaN(high)) {
                    console.error('热源数据解析失败:', hexData.substr(i * 2, 2));
                    return;
                }
                const raw = (high << 8) | low;
                data[i] = raw / 100.0; // 原始数据为实际温度的 100 倍
            }
            this.heatMapData = data;
            this.renderHeatCanvas();
        } catch (e) {
            console.error('热源数据解析失败:', e);
        }
    }

    // 在离屏画布上用双线性插值渲染热成像，使点与点之间的过渡更平滑
    renderHeatCanvas() {
        if (!this.heatMapData || !this.heatCtx) return;
        const w = this.heatCanvas.width;
        const h = this.heatCanvas.height;
        const imageData = this.heatCtx.createImageData(w, h);
        const px = imageData.data;
        let idx = 0;
        for (let py = 0; py < h; py++) {
            const ny = py / (h - 1) * (HEAT_ROWS - 1);
            for (let cx = 0; cx < w; cx++) {
                const nx = cx / (w - 1) * (HEAT_COLS - 1);
                const temp = this.bilinearSample(nx, ny);
                const t = this.getThermalIntensity(temp) / 255;
                px[idx++] = Math.round(t * 255);       // R
                px[idx++] = 0;                          // G
                px[idx++] = Math.round((1 - t) * 255); // B
                px[idx++] = 255;                        // A
            }
        }
        this.heatCtx.putImageData(imageData, 0, 0);
    }

    // 双线性插值：在 32×24 温度网格上按浮点坐标取邻近四点加权平均
    bilinearSample(nx, ny) {
        const x0 = Math.floor(nx);
        const y0 = Math.floor(ny);
        const x1 = Math.min(x0 + 1, HEAT_COLS - 1);
        const y1 = Math.min(y0 + 1, HEAT_ROWS - 1);
        const fx = nx - x0;
        const fy = ny - y0;
        const d = this.heatMapData;
        const t00 = d[y0 * HEAT_COLS + x0];
        const t10 = d[y0 * HEAT_COLS + x1];
        const t01 = d[y1 * HEAT_COLS + x0];
        const t11 = d[y1 * HEAT_COLS + x1];
        return t00 * (1 - fx) * (1 - fy)
             + t10 * fx * (1 - fy)
             + t01 * (1 - fx) * fy
             + t11 * fx * fy;
    }

    // 温度（℃）→ 显示强度（0~255）
    getThermalIntensity(temp) {
        let intensity = (temp - HEAT_TEMP_MIN) / (HEAT_TEMP_MAX - HEAT_TEMP_MIN) * 255;
        return Math.max(0, Math.min(255, intensity));
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