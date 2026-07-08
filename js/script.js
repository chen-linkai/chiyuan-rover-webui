// ========== 解析 AT 指令（不变） ==========
parseATCommand = function(text) {
    const cleanedText = text.trim();
    const result = {
        command: '',
        params: [],
        original: text
    };
    if (!cleanedText.toUpperCase().startsWith('AT')) {
        return undefined;
    }
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

// ========== 摇杆控制类（不变） ==========
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
        this.buffer = new Uint8Array(0);          // 二进制数据缓冲区
        this.HEAT_PREFIX = new TextEncoder().encode('AT+HEAT=');
        this.heatMapData = null;
        this.commandBuffer = '';
        this.init();
    }

    init() {
        this.initEventListeners();
        this.restoreSettings();
        this.updateNavigation();
        this.updateTextContent();
        new JoystickController('joystick-small', 'MOVES');
    }

    // ========== 事件监听初始化 ==========
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
        document.getElementById('toggle-lang').addEventListener('click', () => {
            this.toggleLanguage();
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

    // ========== 相机 ==========
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
                if (_this.heatMapData && _this.heatMapData.length === 768) {
                    const cellWidth = canvasElement.width / 32;
                    const cellHeight = canvasElement.height / 24;
                    for (let y = 0; y < 24; y++) {
                        for (let x = 0; x < 32; x++) {
                            const value = _this.heatMapData[y * 32 + x];
                            canvasContext.fillStyle = _this.getThermalColor(value);
                            canvasContext.fillRect(x * cellWidth, y * cellHeight, cellWidth, cellHeight);
                        }
                    }
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

    // ========== 页面切换 ==========
    handlePageSwitch(event) {
        const target = event.currentTarget;
        const page = target.getAttribute('data-page');
        document.querySelectorAll('.nav-item').forEach(nav => {
            nav.classList.remove('active');
        });
        target.classList.add('active');
        document.querySelectorAll('.page').forEach(pageEl => {
            pageEl.classList.remove('active');
        });
        document.getElementById(`${page}-page`).classList.add('active');
    }

    // ========== 语言 ==========
    setLanguage(lang) {
        if (LanguageUtils.setCurrentLanguage(lang)) {
            document.documentElement.lang = lang;
            this.updateTextContent();
            this.saveSetting('lang', lang);
        }
    }
    toggleLanguage() {
        const currentLang = LanguageUtils.getCurrentLanguage();
        const newLang = currentLang === 'zh-CN' ? 'en' : 'zh-CN';
        this.setLanguage(newLang);
        document.getElementById('language-selector').value = newLang;
    }
    updateTextContent() {
        const currentLang = LanguageUtils.getCurrentLanguage();
        document.title = LanguageUtils.getTranslation('title', currentLang);
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            const translation = LanguageUtils.getTranslation(key, currentLang);
            if (translation !== key) {
                el.textContent = translation;
            }
        });
        document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
            const key = el.getAttribute('data-i18n-placeholder');
            const translation = LanguageUtils.getTranslation(key, currentLang);
            if (translation !== key) {
                el.placeholder = translation;
            }
        });
        document.querySelectorAll('option[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            const translation = LanguageUtils.getTranslation(key, currentLang);
            if (translation !== key) {
                el.textContent = translation;
            }
        });
        this.updateConnectionUI(isConnected);
    }

    // ========== 主题 ==========
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

    // ========== 限流 & 调试 ==========
    setThrottleInterval(interval) {
        this.saveSetting('throttleInterval', interval);
    }
    setDebugMode(debug) {
        document.getElementById('data-monitor-card').style.display = debug ? 'block' : 'none';
        if (debug) {
            console.log('调试模式已启用');
        }
        this.saveSetting('debug', debug);
    }

    // ========== 串口连接 ==========
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

    // ========== 核心：二进制串口读取 ==========
    async readSerialData() {
        if (!serialPort || !serialPort.readable) return;
        const reader = serialPort.readable.getReader();
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                if (value) {
                    // 追加到缓冲区
                    const newBuffer = new Uint8Array(this.buffer.length + value.length);
                    newBuffer.set(this.buffer);
                    newBuffer.set(value, this.buffer.length);
                    this.buffer = newBuffer;
                    // 尝试解析缓冲区
                    this.processBuffer();
                }
            }
        } catch (error) {
            console.error('读取数据失败:', error);
        } finally {
            reader.releaseLock();
        }
    }

    // ---------- 缓冲区处理 ----------
    processBuffer() {
        const buffer = this.buffer;
        let start = 0;

        while (start < buffer.length) {
            // 1. 查找 HEAT 前缀
            const prefixPos = this.findSubarray(buffer, this.HEAT_PREFIX, start);
            if (prefixPos !== -1) {
                // 2. 处理前缀之前的文本（可能包含普通 AT 指令）
                if (prefixPos > start) {
                    const textChunk = buffer.subarray(start, prefixPos);
                    const processed = this.processTextChunk(textChunk);
                    start += processed;
                    if (processed < textChunk.length) {
                        // 文本不完整，保留剩余数据
                        this.buffer = buffer.subarray(start);
                        return;
                    }
                    // 文本处理完毕，继续循环（此时 start 指向前缀位置）
                    continue;
                }

                // 3. 检查 HEAT 数据是否完整（前缀 + 768 字节）
                const dataStart = prefixPos + this.HEAT_PREFIX.length;
                const dataEnd = dataStart + 768;
                if (dataEnd > buffer.length) {
                    // 数据不足，保留从 start 开始的数据等待更多
                    this.buffer = buffer.subarray(start);
                    return;
                }

                // 4. 提取并处理 HEAT 数据（原始字节）
                const heatData = buffer.subarray(dataStart, dataEnd);
                this.handleHeatBinary(heatData);
                this.displayData(`[HEAT data: ${heatData.length} bytes]`, 'received');

                // 5. 更新起始位置，继续循环
                start = dataEnd;
                // 继续查找下一个 HEAT 或处理后续文本
            } else {
                // 6. 没有 HEAT 前缀，处理剩余所有文本
                const remaining = buffer.subarray(start);
                const processed = this.processTextChunk(remaining);
                start += processed;
                if (processed < remaining.length) {
                    // 有不完整行，保留剩余
                    this.buffer = buffer.subarray(start);
                    return;
                } else {
                    // 全部处理完毕
                    this.buffer = new Uint8Array(0);
                    return;
                }
            }
        }
        // 所有数据处理完毕
        this.buffer = new Uint8Array(0);
    }

    // ---------- 在 Uint8Array 中查找子序列 ----------
    findSubarray(buffer, subarray, startIndex) {
        outer: for (let i = startIndex; i <= buffer.length - subarray.length; i++) {
            for (let j = 0; j < subarray.length; j++) {
                if (buffer[i + j] !== subarray[j]) continue outer;
            }
            return i;
        }
        return -1;
    }

    // ---------- 处理文本块（按行解析） ----------
    processTextChunk(chunk) {
        let processed = 0;
        let i = 0;
        while (i < chunk.length) {
            if (chunk[i] === 10 || chunk[i] === 13) { // \n 或 \r
                // 提取一行（不含换行符）
                const lineBytes = chunk.subarray(processed, i);
                let line = new TextDecoder().decode(lineBytes);
                line = line.replace(/\r$/, ''); // 去掉可能的 \r
                if (line) {
                    this.handleLine(line);
                }
                // 跳过所有连续的换行符
                while (i < chunk.length && (chunk[i] === 10 || chunk[i] === 13)) i++;
                processed = i;
            } else {
                i++;
            }
        }
        // 返回已处理的字节数（最后一个完整行结束的位置）
        return processed;
    }

    // ---------- 处理单行 AT 指令 ----------
    handleLine(line) {
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
// 摇杆控制类
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
        
        // 复位摇杆
        this.handle.style.transform = 'translate(-50%, -50%)';
        
        // 发送复位指令
        this.sendCommand(0, 0.5);
    }
    
    updatePosition(e) {// 计算摇杆中心点和半径
        const rect = this.joystick.getBoundingClientRect();
        this.centerX = rect.width / 2;
        this.centerY = rect.height / 2;
        this.radius = rect.width / 2; // 减去手柄半径
        
        let clientX, clientY;
        
        if (e.type.includes('touch')) {
            clientX = e.touches[0].clientX;
            clientY = e.touches[0].clientY;
        } else {
            clientX = e.clientX;
            clientY = e.clientY;
        }
        
        // 计算相对于摇杆中心的位置
        const x = clientX - rect.left - this.centerX;
        const y = clientY - rect.top - this.centerY;
        
        // 限制在圆形范围内
        const distance = Math.sqrt(x * x + y * y);
        const limitedDistance = Math.min(distance, this.radius);
        
        const angle = Math.atan2(y, x);
        const limitedX = limitedDistance * Math.cos(angle);
        const limitedY = limitedDistance * Math.sin(angle);
        
        // 更新手柄位置
        this.handle.style.transform = `translate(calc(-50% + ${limitedX}px), calc(-50% + ${limitedY}px))`;
        
        // 计算速度 (-255 到 255) 和权重 (0 到 1)
        const speed = Math.round(-limitedY / this.radius * 255); // Y轴反向，符合直觉
        const weight = Math.round((limitedX / this.radius + 1) / 2 * 100) / 100; // 0到1
        
        // 节流
        const currentTime = Date.now();
        if (!(window.app && typeof window.app.sendData === 'function') || currentTime - this.lastSendTime >= window.app.getSetting('throttleInterval')) {
            // 发送指令
            this.sendCommand(speed, weight);
            this.lastSendTime = currentTime; // 更新上次发送时间
        }
    }
    
    sendCommand(speed, weight) {
        const command = `AT+${this.commandPrefix}=${speed},${weight}\r\n`;
        
        // 使用现有的sendData方法
        if (window.app && typeof window.app.sendData === 'function') {
            window.app.sendData(command);
        }
    }
}

// 初始化应用
class App {
    constructor() {
        this.init();
    }

    init() {
        this.initEventListeners();
        this.restoreSettings();
        this.updateNavigation();
        this.updateTextContent(); // 初始化文本内容
        new JoystickController('joystick-small', 'MOVES');
        this.heatMapData = null;
        this.commandBuffer = '';
    }

    // 初始化事件监听器
    initEventListeners() {
        // 页面切换
        document.querySelectorAll('.nav-item').forEach(item => {
            item.addEventListener('click', (e) => this.handlePageSwitch(e));
        });

        // 语言切换
        document.getElementById('language-selector').addEventListener('change', (e) => {
            this.setLanguage(e.target.value);
        });

        // 主题切换
        document.getElementById('theme-selector').addEventListener('change', (e) => {
            this.setTheme(e.target.value);
        });

        // 限流频率切换
        document.getElementById('throttle-selector').addEventListener('change', (e) => {
            this.setThrottleInterval(e.target.value);
        });

        // 调试模式切换
        document.getElementById('debug-toggle').addEventListener('change', (e) => {
            this.setDebugMode(e.target.checked);
        });

        // 快速语言切换按钮
        document.getElementById('toggle-lang').addEventListener('click', () => {
            this.toggleLanguage();
        });

        // 串口连接
        document.getElementById('connect-btn').addEventListener('click', () => {
            this.handleSerialConnection();
        });

        // 打开相机
        var openedCamera = false;
        document.getElementById('camera-blocker').addEventListener('click', () => {
            if (!openedCamera) {
                this.openCamera();
                openedCamera = true;
            }
        });

        // 打开仓门
        document.getElementById('door-open-btn').addEventListener('click', () => {
            this.sendData('AT+DOOR=1\r\n');
        });

        // 关闭仓门
        document.getElementById('door-close-btn').addEventListener('click', () => {
            this.sendData('AT+DOOR=0\r\n');
        });

        // 小车刹车
        document.getElementById('brake-small-btn').addEventListener('click', () => {
            this.sendData('AT+BRAKES\r\n');
        });

        // 窗口大小变化
        window.addEventListener('resize', () => this.updateNavigation());
        window.addEventListener('orientationchange', () => this.updateNavigation());

        // 系统主题变化监听
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
            const savedTheme = this.getSetting('theme') || CONFIG.defaultTheme;
            if (savedTheme === 'auto') {
                this.setTheme('auto');
            }
        });
    }

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

            const draw = function(_this) {
                canvasContext.clearRect(0, 0, canvasElement.width, canvasElement.height);
                canvasContext.drawImage(videoElement, 0, 0, canvasElement.width, canvasElement.height);
                if (_this.heatMapData && _this.heatMapData.length === 768) {
                    const cellWidth = canvasElement.width / 32;
                    const cellHeight = canvasElement.height / 24;
                    for (let y = 0; y < 24; y++) {
                        for (let x = 0; x < 32; x++) {
                            const value = _this.heatMapData[y * 32 + x];
                            canvasContext.fillStyle = _this.getThermalColor(value);
                            canvasContext.fillRect(x * cellWidth, y * cellHeight, cellWidth, cellHeight);
                        }
                    }
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

    // 页面切换处理
    handlePageSwitch(event) {
        const target = event.currentTarget;
        const page = target.getAttribute('data-page');
        
        // 更新活动状态
        document.querySelectorAll('.nav-item').forEach(nav => {
            nav.classList.remove('active');
        });
        target.classList.add('active');
        
        // 显示对应页面
        document.querySelectorAll('.page').forEach(pageEl => {
            pageEl.classList.remove('active');
        });
        document.getElementById(`${page}-page`).classList.add('active');
    }

    // 设置语言
    setLanguage(lang) {
        if (LanguageUtils.setCurrentLanguage(lang)) {
            document.documentElement.lang = lang;
            this.updateTextContent();
            this.saveSetting('lang', lang);
        }
    }

    // 切换语言
    toggleLanguage() {
        const currentLang = LanguageUtils.getCurrentLanguage();
        const newLang = currentLang === 'zh-CN' ? 'en' : 'zh-CN';
        this.setLanguage(newLang);
        document.getElementById('language-selector').value = newLang;
    }

    // 更新文本内容
    updateTextContent() {
        const currentLang = LanguageUtils.getCurrentLanguage();
        
        document.title = LanguageUtils.getTranslation('title', currentLang);

        // 更新所有带data-i18n属性的元素
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            const translation = LanguageUtils.getTranslation(key, currentLang);
            if (translation !== key) {
                el.textContent = translation;
            }
        });
        
        // 更新占位符文本
        document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
            const key = el.getAttribute('data-i18n-placeholder');
            const translation = LanguageUtils.getTranslation(key, currentLang);
            if (translation !== key) {
                el.placeholder = translation;
            }
        });
        
        // 更新选项文本
        document.querySelectorAll('option[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            const translation = LanguageUtils.getTranslation(key, currentLang);
            if (translation !== key) {
                el.textContent = translation;
            }
        });
        
        // 更新连接按钮文本
        this.updateConnectionUI(isConnected);
    }

    // 设置主题
    setTheme(theme) {
        const html = document.documentElement;
        
        if (theme === 'auto') {
            // 跟随系统
            if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
                html.setAttribute('data-theme', 'dark');
            } else {
                html.setAttribute('data-theme', 'light');
            }
        } else {
            html.setAttribute('data-theme', theme);
        }
        
        // 保存设置
        this.saveSetting('theme', theme);
    }

    // 设置限流间隔
    setThrottleInterval(interval) {
        this.saveSetting('throttleInterval', interval);
    }

    // 设置调试模式
    setDebugMode(debug) {
        document.getElementById('data-monitor-card').style.display = debug ? 'block' : 'none';
        if (debug) {
            console.log('调试模式已启用');
        }
        this.saveSetting('debug', debug);
    }

    // 串口连接处理
    async handleSerialConnection() {
        if (isConnected) {
            await this.disconnectSerial();
        } else {
            await this.connectSerial();
        }
    }

    // 连接串口
    async connectSerial() {
        try {
            // 检查浏览器是否支持Web Serial API
            if (!('serial' in navigator)) {
                alert(LanguageUtils.getTranslation('browserNotSupported'));
                return;
            }
            
            // 请求串口权限
            const port = await navigator.serial.requestPort();
            const baudRate = parseInt(document.getElementById('baudrate-selector').value);
            
            // 打开串口
            await port.open({ baudRate });
            serialPort = port;
            
            // 更新UI
            isConnected = true;
            this.updateConnectionUI(true);
            
            // 开始读取数据
            this.readSerialData();
            
        } catch (error) {
            console.error('连接串口失败:', error);
        }
    }

    // 断开串口连接
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
        
        // 更新UI
        isConnected = false;
        this.updateConnectionUI(false);
    }

    // 更新连接状态UI
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

    // 读取串口数据
    async readSerialData() {
        if (!serialPort || !serialPort.readable) return;
        
        const textDecoder = new TextDecoder();
        reader = serialPort.readable.getReader();
        
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) {
                    break;
                }
                
                if (value) {
                    const text = textDecoder.decode(value);
                    
                    // 处理 AT+HEAT 指令（768 个 hex 字符，每个字符为 4 位强度值 0-F）
                    const heatMatch = text.match(/^AT\+HEAT=(.+)$/im);
                    if (heatMatch) {
                        this.handleHeatData(heatMatch[1].trim());
                        this.displayData(text, 'received');
                    } else {
                        const command = parseATCommand(text);
                        if (command) {
                            switch (command['command']) {
                                case 'LOCATION': {
                                    document.getElementById('location-map-frame').contentWindow.postMessage({
                                        type: 'addTrackPoint',
                                        lon: command['params'][0],
                                        lat: command['params'][1]
                                    }, '*');
                                    document.getElementById('map-location').textContent = `(${command['params'][0]}, ${command['params'][1]})`;
                                    document.getElementById('map-lastUpdate').textContent = new Date().toLocaleTimeString();
                                    break;
                                }
                                case 'ENVIRONMENT': {
                                    document.getElementById('environmentSensor-temperature').textContent = command['params'][0];
                                    document.getElementById('environmentSensor-humidity').textContent = command['params'][1];
                                    document.getElementById('environmentSensor-lastUpdate').textContent = new Date().toLocaleTimeString();
                                    break;
                                }
                            }
                        }
                        this.displayData(text, 'received');
                    }
                }
            }
        } catch (error) {
            console.error('读取数据失败:', error);
        } finally {
            reader.releaseLock();
        }
    }

    // 处理 768 个 hex 字符的 32x24 热源矩阵
    // 每个字符代表 4 位强度值（0-F），映射到 0-255 用于热成像显示
    handleHeatData(hexData) {
        try {
            const data = new Uint8Array(768);
            for (let i = 0; i < 768 && i < hexData.length; i++) {
                const val = parseInt(hexData[i], 16);
                data[i] = isNaN(val) ? 0 : val * 17; // 0-F -> 0-255
            }
            this.heatMapData = data;
        } catch (e) {
            console.error('热源数据 hex 解码失败:', e);
        }
    }

    // 将热源值（0-255）映射为热成像颜色，半透明叠加
    getThermalColor(value) {
        const normalized = value / 255;
        const hue = (1 - normalized) * 240; // 240 (蓝) -> 0 (红)
        const saturation = 90;
        const lightness = 10 + normalized * 60;
        return `hsla(${hue}, ${saturation}%, ${lightness}%, 0.65)`;
    }

    // 发送数据
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

    // 显示数据
    displayData(data, type) {
        const dataMonitor = document.getElementById('data-monitor');
        const timestamp = new Date().toLocaleTimeString();
        const color = type === 'sent' ? 'var(--primary-color)' : 'var(--text-color)';
        
        dataMonitor.innerHTML += `<div style="color: ${color};">${timestamp}: ${data}</div>`;
        dataMonitor.scrollTop = dataMonitor.scrollHeight;
    }

    // 保存设置
    saveSetting(key, value) {
        localStorage.setItem(CONFIG.storagePrefix + key, value.toString());
    }

    // 获取设置
    getSetting(key) {
        return localStorage.getItem(CONFIG.storagePrefix + key);
    }

    // 恢复设置
    restoreSettings() {
        // 语言设置
        const savedLang = this.getSetting('lang') || CONFIG.defaultLanguage;
        document.getElementById('language-selector').value = savedLang;
        this.setLanguage(savedLang);
        
        // 主题设置
        const savedTheme = this.getSetting('theme') || CONFIG.defaultTheme;
        document.getElementById('theme-selector').value = savedTheme;
        this.setTheme(savedTheme);
        
        // 限流设置
        const savedThrottle = this.getSetting('throttleInterval') || 200;
        document.getElementById('throttle-selector').value = savedThrottle;
        this.setThrottleInterval(savedThrottle);
        
        // 调试模式设置
        const savedDebug = this.getSetting('debug') === 'true';
        document.getElementById('debug-toggle').checked = savedDebug;
        this.setDebugMode(savedDebug);
    }

    // 更新导航布局
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