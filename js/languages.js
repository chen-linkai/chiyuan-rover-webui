const LANGUAGE_DATA = {
    'zh-CN': {
        'title': '运输车管理器',
        'nav.device': '设备',
        'nav.settings': '设置',
        'device.title': '设备',
        'device.serial.title': '串口连接',
        'device.serial.baudrate': '波特率',
        'device.serial.connect': '连接设备',
        'device.serial.disconnect': '断开连接',
        'device.status.connected': '已连接',
        'device.status.disconnected': '未连接',
        'device.joystick.big': '大车摇杆控制',
        'device.joystick.small': '小车摇杆控制',
        'device.environmentSensor.temperature': '温度：',
        'device.environmentSensor.humidity': '湿度：',
        'device.environmentSensor.lastUpdate': '最后更新：',
        'device.map.location': '经纬度：',
        'device.map.lastUpdate': '最后更新：',
        'device.misc': '杂项',
        'device.misc.openDoor': '打开仓门',
        'device.misc.closeDoor': '关闭仓门',
        'device.misc.smallCarBrake': '小车急刹车',
        'device.misc.bigCarBrake': '大车急刹车',
        'device.data.receive': '调试信息',
        'device.camera.blocker': '点击以唤醒相机',
        'device.camera.blocker.error': '相机在唤醒时发生错误',
        'settings.title': '设置',
        'settings.language': '语言',
        'settings.languageDesc': '切换界面显示语言',
        'settings.theme': '深色模式',
        'settings.themeDesc': '选择界面主题样式',
        'settings.themeAuto': '跟随系统',
        'settings.themeDark': '始终启用',
        'settings.themeLight': '始终禁用',
        'settings.throttle': '限流频率',
        'settings.throttleDesc': '对 UART 的发送进行限流',
        'settings.throttleDisable': '禁用',
        'settings.debug': '调试模式',
        'settings.debugDesc': '仅限开发者使用'
    },
    'en': {
        'title': 'Motor Mananger',
        'nav.device': 'Device',
        'nav.settings': 'Settings',
        'device.title': 'Device',
        'device.serial.title': 'Serial Connection',
        'device.serial.baudrate': 'Baud Rate',
        'device.serial.connect': 'Connect Device',
        'device.serial.disconnect': 'Disconnect',
        'device.status.connected': 'Connected',
        'device.status.disconnected': 'Disconnected',
        'device.joystick.big': 'Big Car Joystick Control',
        'device.joystick.small': 'Small Car Joystick Control',
        'device.map.location': 'Coordinates:',
        'device.map.lastUpdate': 'Last Update:',
        'device.misc': 'Miscellaneous',
        'device.misc.openDoor': 'Open Door',
        'device.misc.closeDoor': 'Close Door',
        'device.misc.smallCarBrake': 'Small Car Emergency Brake',
        'device.misc.bigCarBrake': 'Big Car Emergency Brake',
        'device.data.receive': 'Debug Information',
        'device.camera.blocker': 'Click for opening camera',
        'device.camera.blocker.error': 'An error occurred when opening camera',
        'settings.title': 'Settings',
        'settings.language': 'Language',
        'settings.languageDesc': 'Switch interface language',
        'settings.theme': 'Dark Mode',
        'settings.themeDesc': 'Choose interface theme style',
        'settings.themeAuto': 'Follow System',
        'settings.themeDark': 'Always On',
        'settings.themeLight': 'Always Off',
        'settings.throttle': 'Throttle Frequency',
        'settings.throttleDesc': 'Throttle the transmission of UART',
        'settings.throttleDisable': 'Disabled',
        'settings.debug': 'Debug Mode',
        'settings.debugDesc': 'For developers only'
    }
};

// 语言工具函数
const LanguageUtils = {
    // 获取当前语言的翻译
    getTranslation(key, lang = currentLang) {
        return LANGUAGE_DATA[lang]?.[key] || key;
    },
    
    // 获取所有支持的语言
    getSupportedLanguages() {
        return CONFIG.supportedLanguages;
    },
    
    // 设置当前语言
    setCurrentLanguage(lang) {
        if (CONFIG.supportedLanguages.includes(lang)) {
            currentLang = lang;
            return true;
        }
        return false;
    },
    
    // 获取当前语言
    getCurrentLanguage() {
        return currentLang;
    }
};