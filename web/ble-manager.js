/**
 * Web Bluetooth BLE Manager for Nintendo Switch 2 controllers.
 * Port of BLEManager.swift using the Web Bluetooth API.
 */

class BLEManager {
  // GATT Characteristic UUIDs (lowercased for Web Bluetooth)
  static WRITE_UUID = '649d4ac9-8eb7-4e6c-af44-1ea54fe5f005';
  static SUBSCRIBE_UUID = 'ab7de9be-89fe-49ad-828f-118f09df7fd2';
  static COMMAND_RESPONSE_UUID = 'c765a961-d9d8-4d36-a20a-5315b111836a';

  // Controller-specific command response #2 UUIDs (0x001E)
  static COMMAND_RESPONSE_2_UUIDS = new Set([
    '63a3810f-aec7-474b-9010-3d52403cb996',  // JoyCon L
    '640ca58e-0e88-410c-a7f3-426faf2b690b',  // JoyCon R
    '506d9f7d-4278-4e95-a549-326ba77657e0',  // Pro
    '46f6ad29-cdaf-4569-a2fe-339020b94604',  // GameCube
  ]);

  // Controller-specific vibration+command UUIDs (0x0016)
  static VIBRATION_COMMAND_UUIDS = new Set([
    'ce49a830-dced-48ae-931e-c8cf88aadbea',  // JoyCon L
    '65a724b3-f1e7-4a61-8078-a342376b27ff',  // JoyCon R
    '3dacbc7e-6955-40b5-8eaf-6f9809e8b379',  // Pro
    'af95885e-44b3-4a24-9cf0-483cc129469a',  // GameCube
  ]);

  // HD Rumble UUIDs (handle 0x0012)
  static HD_RUMBLE_UUIDS = new Set([
    '289326cb-a471-485d-a8f4-240c14f18241',  // JoyCon L
    'fa19b0fb-cd1f-46a7-84a1-bbb09e00c149',  // JoyCon R
    'cc483f51-9258-427d-a939-630c31f72b05',  // Pro
    '3f8fb670-ab25-45bf-b540-38c72834d064',  // GameCube
  ]);

  // GATT Service UUIDs (discovered from iOS app)
  static SERVICE_UUIDS = [
    '00c5af5d-1964-4e30-8f51-1956f96bd280',
    'ab7de9be-89fe-49ad-828f-118f09df7fd0',
  ];

  // Nintendo manufacturer ID
  static NINTENDO_MFR_ID = 0x0553;

  // Nintendo pairing keys (from BlueRetro)
  static FIXED_PUBLIC_KEY = [0xea, 0xbd, 0x47, 0x13, 0x89, 0x35, 0x42, 0xc6,
                             0x79, 0xee, 0x07, 0xf2, 0x53, 0x2c, 0x6c, 0x31];
  static FIXED_CHALLENGE  = [0x40, 0xb0, 0x8a, 0x5f, 0xcd, 0x1f, 0x9b, 0x41,
                             0x12, 0x5c, 0xac, 0xc6, 0x3f, 0x38, 0xa0, 0x73];
  static CONTROLLER_KEY   = [0x5C, 0xF6, 0xEE, 0x79, 0x2C, 0xDF, 0x05, 0xE1,
                             0xBA, 0x2B, 0x63, 0x25, 0xC4, 0x1A, 0x5F, 0x10];

  constructor() {
    this.controllers = [];
    this.rumbleTid = 0;
    this.rumbleInterval = null;
    this.activeRumbleParams = null;
    this.activeGCRumbleIndex = null;

    // Callbacks
    this.onLog = null;
    this.onStateChange = null;
    this.onControllerUpdate = null;
    this.onControllerAdded = null;
    this.onControllerRemoved = null;
  }

  get computedLTK() {
    return BLEManager.FIXED_PUBLIC_KEY.map((b, i) => b ^ BLEManager.CONTROLLER_KEY[i]);
  }

  // Fake host BT address (iOS original uses same trick)
  get hostAddress() { return 0xAABBCCDDEEFF; }

  emit(msg) {
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const entry = `[${ts}] ${msg}`;
    console.log(entry);
    if (this.onLog) this.onLog(entry);
  }

  isSupported() {
    return !!navigator.bluetooth;
  }

  /**
   * Scan and connect to a Nintendo controller.
   * Web Bluetooth requires user gesture and shows a picker dialog.
   */
  async scan() {
    if (!this.isSupported()) {
      this.emit('Web Bluetooth not supported in this browser');
      return null;
    }

    this.emit('Opening Bluetooth device picker...');
    if (this.onStateChange) this.onStateChange('scanning');

    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{
          manufacturerData: [{
            companyIdentifier: BLEManager.NINTENDO_MFR_ID,
          }],
        }],
        optionalServices: BLEManager.SERVICE_UUIDS,
      });

      if (!device) {
        this.emit('No device selected');
        if (this.onStateChange) this.onStateChange('disconnected');
        return null;
      }

      this.emit(`Selected: ${device.name || 'Unknown'}`);
      return await this.connectDevice(device);
    } catch (err) {
      if (err.name === 'NotFoundError') {
        this.emit('No device selected');
      } else {
        this.emit(`Scan error: ${err.message}`);
      }
      if (this.onStateChange) this.onStateChange(this.controllers.length ? 'connected' : 'disconnected');
      return null;
    }
  }

  /**
   * Scan with acceptAllDevices as fallback (if manufacturer filter isn't supported).
   */
  async scanAll() {
    if (!this.isSupported()) {
      this.emit('Web Bluetooth not supported');
      return null;
    }

    this.emit('Opening Bluetooth device picker (all devices)...');
    if (this.onStateChange) this.onStateChange('scanning');

    try {
      const device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: BLEManager.SERVICE_UUIDS,
      });

      if (!device) {
        if (this.onStateChange) this.onStateChange('disconnected');
        return null;
      }

      this.emit(`Selected: ${device.name || 'Unknown'}`);
      return await this.connectDevice(device);
    } catch (err) {
      if (err.name !== 'NotFoundError') {
        this.emit(`Scan error: ${err.message}`);
      }
      if (this.onStateChange) this.onStateChange(this.controllers.length ? 'connected' : 'disconnected');
      return null;
    }
  }

  async connectDevice(device) {
    if (this.onStateChange) this.onStateChange('connecting');
    this.emit('Connecting...');

    try {
      const server = await device.gatt.connect();
      this.emit('GATT connected, discovering services...');

      // Listen for disconnection
      device.addEventListener('gattserverdisconnected', () => {
        this.handleDisconnect(device);
      });

      // Discover services. Web Bluetooth only returns services listed in optionalServices.
      // Strategy: try getPrimaryServices() first (works if we listed correct service UUIDs
      // or if the new permissions backend flag is enabled). If that fails or returns empty,
      // try discovering each known UUID individually as a service — some BLE stacks use
      // the same UUID for both the service and its sole characteristic.
      let services = [];
      try {
        services = await server.getPrimaryServices();
      } catch (svcErr) {
        this.emit(`getPrimaryServices() failed: ${svcErr.message}`);
      }

      // If no services found, try probing each known UUID as a service UUID directly
      if (services.length === 0) {
        this.emit('No services from blanket discovery. Probing known UUIDs as services...');
        const allUUIDs = [
          BLEManager.WRITE_UUID,
          BLEManager.SUBSCRIBE_UUID,
          BLEManager.COMMAND_RESPONSE_UUID,
          ...BLEManager.COMMAND_RESPONSE_2_UUIDS,
          ...BLEManager.VIBRATION_COMMAND_UUIDS,
          ...BLEManager.HD_RUMBLE_UUIDS,
        ];
        for (const uuid of allUUIDs) {
          try {
            const svc = await server.getPrimaryService(uuid);
            services.push(svc);
            this.emit(`  Found service: ${uuid.substring(0, 8)}...`);
          } catch (_) {}
        }
      }

      if (services.length === 0) {
        this.emit('No accessible services found.');
        this.emit('Try enabling chrome://flags/#enable-web-bluetooth-new-permissions-backend');
        this.emit('Then restart Chrome and try again.');
        device.gatt.disconnect();
        if (this.onStateChange) this.onStateChange(this.controllers.length ? 'connected' : 'disconnected');
        return null;
      }

      this.emit(`Found ${services.length} service(s)`);

      // Build controller object
      const controller = {
        id: device.id,
        device,
        server,
        name: device.name || 'Controller',
        controllerType: ControllerType.UNKNOWN,
        playerNumber: this.nextSlot(),
        state: null,
        isReady: false,
        isPaired: false,
        // Characteristics
        writeChar: null,
        commandWriteChar: null,
        subscribeChar: null,
        commandResponseChar: null,
        commandResponse2Char: null,
        hdRumbleChar: null,
        // Mouse tracking
        mouseInitialized: false,
        lastMouseX: 0,
        lastMouseY: 0,
        // Stick calibration (from SPI flash)
        cal: {
          sticks: [[null, null], [null, null]], // [left/right][x/y] = { neutral, relMax, relMin }
          deadzone: [0, 0], // [left, right]
          trigNeutral: [DEFAULT_TRIGGER_CAL.neutral, DEFAULT_TRIGGER_CAL.neutral],
          trigMax: [DEFAULT_TRIGGER_CAL.max, DEFAULT_TRIGGER_CAL.max],
          valid: false,
        },
      };

      // Discover characteristics across all services
      for (const service of services) {
        try {
          const chars = await service.getCharacteristics();
          for (const char of chars) {
            const uuid = char.uuid.toLowerCase();
            if (uuid === BLEManager.WRITE_UUID) {
              controller.writeChar = char;
            } else if (uuid === BLEManager.SUBSCRIBE_UUID) {
              controller.subscribeChar = char;
            } else if (uuid === BLEManager.COMMAND_RESPONSE_UUID) {
              controller.commandResponseChar = char;
            } else if (BLEManager.COMMAND_RESPONSE_2_UUIDS.has(uuid)) {
              controller.commandResponse2Char = char;
              // Detect controller type from characteristic UUID
              if (uuid === '63a3810f-aec7-474b-9010-3d52403cb996') controller.controllerType = ControllerType.JOY_CON_LEFT;
              else if (uuid === '640ca58e-0e88-410c-a7f3-426faf2b690b') controller.controllerType = ControllerType.JOY_CON_RIGHT;
              else if (uuid === '506d9f7d-4278-4e95-a549-326ba77657e0') controller.controllerType = ControllerType.PRO_CONTROLLER;
              else if (uuid === '46f6ad29-cdaf-4569-a2fe-339020b94604') controller.controllerType = ControllerType.GAME_CUBE;
            } else if (BLEManager.VIBRATION_COMMAND_UUIDS.has(uuid)) {
              controller.commandWriteChar = char;
            } else if (BLEManager.HD_RUMBLE_UUIDS.has(uuid)) {
              controller.hdRumbleChar = char;
            }
          }
        } catch (e) {
          // Some services may not allow characteristic discovery
        }
      }

      // Update name based on detected type
      if (controller.controllerType !== ControllerType.UNKNOWN) {
        controller.name = getControllerName(controller.controllerType);
      }

      const hasWrite = controller.writeChar || controller.commandWriteChar;
      const hasSubscribe = controller.subscribeChar;

      if (!hasWrite || !hasSubscribe) {
        this.emit('Missing required characteristics - is this a Switch 2 controller?');
        device.gatt.disconnect();
        if (this.onStateChange) this.onStateChange(this.controllers.length ? 'connected' : 'disconnected');
        return null;
      }

      // Subscribe to notifications
      if (controller.subscribeChar) {
        await controller.subscribeChar.startNotifications();
        controller.subscribeChar.addEventListener('characteristicvaluechanged', (e) => {
          this.handleInputReport(controller, e.target.value);
        });
      }
      if (controller.commandResponseChar) {
        await controller.commandResponseChar.startNotifications();
        controller.commandResponseChar.addEventListener('characteristicvaluechanged', (e) => {
          this.handleCommandResponse(controller, e.target.value);
        });
      }
      if (controller.commandResponse2Char) {
        await controller.commandResponse2Char.startNotifications();
        controller.commandResponse2Char.addEventListener('characteristicvaluechanged', (e) => {
          this.handleCommandResponse(controller, e.target.value);
        });
      }

      this.controllers.push(controller);
      this.emit(`Connected ${controller.name} as Player ${controller.playerNumber}`);
      if (this.onControllerAdded) this.onControllerAdded(controller);

      // Run initialization sequence
      await this.initializeController(controller);

      if (this.onStateChange) this.onStateChange('connected');
      return controller;
    } catch (err) {
      this.emit(`Connection error: ${err.message}`);
      if (this.onStateChange) this.onStateChange(this.controllers.length ? 'connected' : 'disconnected');
      return null;
    }
  }

  handleDisconnect(device) {
    const idx = this.controllers.findIndex(c => c.id === device.id);
    if (idx === -1) return;
    const controller = this.controllers.splice(idx, 1)[0];
    this.emit(`${controller.name} disconnected`);
    if (this.onControllerRemoved) this.onControllerRemoved(controller);
    if (this.onStateChange) this.onStateChange(this.controllers.length ? 'connected' : 'disconnected');
  }

  disconnect(controller) {
    try {
      controller.device.gatt.disconnect();
    } catch (e) {}
    this.handleDisconnect(controller.device);
  }

  // MARK: - Write helper

  async writeCommand(data, controller, characteristic) {
    try {
      await characteristic.writeValueWithoutResponse(new Uint8Array(data));
    } catch (e) {
      // Fallback for older API
      try {
        await characteristic.writeValue(new Uint8Array(data));
      } catch (e2) {
        this.emit(`Write failed: ${e2.message}`);
      }
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // MARK: - SPI Flash Read (for calibration data)

  /**
   * Send SPI flash read command. Response arrives on commandResponseChar.
   * Uses write characteristic (0x0014), not command write.
   */
  async spiRead(controller, addr, len) {
    if (!controller.writeChar) return null;

    // Set up a one-shot listener for the response
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(null), 1000);

      const handler = (e) => {
        const data = new Uint8Array(e.target.value.buffer);
        if (data.length >= 4 && data[0] === 0x02) {
          // SPI read response: [cmd=0x02][type][int][subcmd][...value]
          controller.commandResponseChar.removeEventListener('characteristicvaluechanged', handler);
          clearTimeout(timeout);
          resolve(data.length > 4 ? data.slice(4) : null);
        }
      };

      if (controller.commandResponseChar) {
        controller.commandResponseChar.addEventListener('characteristicvaluechanged', handler);
      } else {
        clearTimeout(timeout);
        resolve(null);
        return;
      }

      const cmd = [
        0x02, 0x91, 0x01, 0x04,        // CMD_READ_SPI
        0x00, 0x08, 0x00, 0x00,        // fixed
        len,                            // read length
        0x7e, 0x00, 0x00,              // fixed
        addr & 0xFF, (addr >> 8) & 0xFF,
        (addr >> 16) & 0xFF, (addr >> 24) & 0xFF,
      ];
      this.writeCommand(cmd, controller, controller.writeChar);
    });
  }

  /**
   * Read stick calibration data from SPI flash.
   */
  async readCalibration(controller) {
    this.emit('Reading calibration data...');
    const isJCR = controller.controllerType === ControllerType.JOY_CON_RIGHT;
    const isJCL = controller.controllerType === ControllerType.JOY_CON_LEFT;

    // Read left stick cal from 0x13080
    const leftData = await this.spiRead(controller, SPI_CAL_LEFT, 0x40);
    if (leftData && leftData.length > 60 && leftData[52] !== 0xFF) {
      const cal = unpackStickCal(leftData, 52);
      const dz = leftData[19] | ((leftData[20] & 0x0F) << 8);
      if (isJCR) {
        // Joy-Con R: "left" SPI cal is actually for its only stick, which reports as right
        controller.cal.sticks[1][0] = cal.x;
        controller.cal.sticks[1][1] = cal.y;
        controller.cal.deadzone[1] = dz;
        this.emit(`JCR stick cal (from left SPI): neutral=(${cal.x.neutral}, ${cal.y.neutral}) dz=${dz}`);
      } else {
        controller.cal.sticks[0][0] = cal.x;
        controller.cal.sticks[0][1] = cal.y;
        controller.cal.deadzone[0] = dz;
        this.emit(`Left stick cal: neutral=(${cal.x.neutral}, ${cal.y.neutral}) dz=${dz}`);
      }
      controller.cal.valid = true;
    }

    await this.sleep(100);

    // Read right stick cal from 0x130C0
    const rightData = await this.spiRead(controller, SPI_CAL_RIGHT, 0x40);
    if (rightData && rightData.length > 60 && rightData[52] !== 0xFF) {
      const cal = unpackStickCal(rightData, 52);
      const dz = rightData[19] | ((rightData[20] & 0x0F) << 8);
      if (isJCL) {
        // Joy-Con L: "right" SPI cal might hold data for its only stick, which reports as left
        controller.cal.sticks[0][0] = cal.x;
        controller.cal.sticks[0][1] = cal.y;
        controller.cal.deadzone[0] = dz;
        this.emit(`JCL stick cal (from right SPI): neutral=(${cal.x.neutral}, ${cal.y.neutral}) dz=${dz}`);
      } else {
        controller.cal.sticks[1][0] = cal.x;
        controller.cal.sticks[1][1] = cal.y;
        controller.cal.deadzone[1] = dz;
        this.emit(`Right stick cal: neutral=(${cal.x.neutral}, ${cal.y.neutral}) dz=${dz}`);
      }
    }

    await this.sleep(100);

    // Read user calibration (overrides factory if present)
    const userData = await this.spiRead(controller, SPI_CAL_USER, 0x40);
    if (userData && userData.length > 55) {
      if (userData[14] !== 0xFF) {
        const cal = unpackStickCal(userData, 14);
        controller.cal.sticks[0][0] = cal.x;
        controller.cal.sticks[0][1] = cal.y;
        this.emit('User left stick cal applied');
      }
      if (userData[46] !== 0xFF) {
        const cal = unpackStickCal(userData, 46);
        controller.cal.sticks[1][0] = cal.x;
        controller.cal.sticks[1][1] = cal.y;
        this.emit('User right stick cal applied');
      }
    }

    if (controller.cal.valid) {
      this.emit('Calibration loaded');
    } else {
      this.emit('No calibration data, using defaults');
    }
  }

  // MARK: - Controller Initialization

  async initializeController(controller) {
    if (this.onStateChange) this.onStateChange('pairing');
    const isJC = isJoyCon(controller.controllerType);

    const writeChar = isJC
      ? controller.writeChar
      : (controller.commandWriteChar || controller.writeChar);

    if (!writeChar) {
      this.emit('No write characteristic for initialization');
      return;
    }

    const featureFlags = FEATURE_FLAGS[controller.controllerType] || 0x07;
    this.emit(`Initializing ${controller.name}...`);

    try {
      // Init command (0x07.01)
      await this.writeCommand([0x07, 0x91, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00], controller, writeChar);
      await this.sleep(150);

      // Query wakeup button (Joy-Con only)
      if (isJC) {
        await this.writeCommand([0x16, 0x91, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00], controller, writeChar);
        await this.sleep(200);
      }

      // Read calibration data from SPI flash (before pairing, like NinBridge)
      await this.readCalibration(controller);

      // Nintendo pairing
      this.emit('Performing Nintendo pairing...');
      await this.performPairing(controller, writeChar);

      // Joy-Con: store pairing info
      if (isJC) {
        const storePairingCmd = [0x03, 0x91, 0x01, 0x07, 0x00, 0x16, 0x00, 0x00];
        const addr = this.hostAddress;
        for (let i = 0; i < 6; i++) {
          storePairingCmd.push((addr >> (i * 8)) & 0xFF);
        }
        const ltk = this.computedLTK;
        for (let i = 15; i >= 0; i--) {
          storePairingCmd.push(ltk[i]);
        }
        await this.writeCommand(storePairingCmd, controller, writeChar);
        await this.sleep(100);

        await this.writeCommand([0x03, 0x91, 0x01, 0x09, 0x00, 0x00, 0x00, 0x00], controller, writeChar);
        await this.sleep(100);
      }

      // Feature flags (0x0C) — must go to writeChar (0x0014), NOT commandWriteChar
      // NinBridge: "Feature flags go to h_write (0x0014), not h_cmd_write"
      const featureWriteChar = controller.writeChar || writeChar;
      await this.writeCommand([0x0c, 0x91, 0x01, 0x02, 0x00, 0x04, 0x00, 0x00, featureFlags, 0x00, 0x00, 0x00], controller, featureWriteChar);
      await this.sleep(500);

      await this.writeCommand([0x0c, 0x91, 0x01, 0x04, 0x00, 0x04, 0x00, 0x00, featureFlags, 0x00, 0x00, 0x00], controller, featureWriteChar);
      await this.sleep(100);

      // Vibration sample (0x0A.02)
      await this.writeCommand([0x0a, 0x91, 0x01, 0x02, 0x00, 0x04, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00], controller, writeChar);
      await this.sleep(100);

      // Set LED
      await this.setPlayerLED(controller);
      await this.sleep(100);

      controller.isPaired = true;
      controller.isReady = true;
      this.emit(`${controller.name} ready (Player ${controller.playerNumber})`);
      if (this.onControllerUpdate) this.onControllerUpdate(controller);
    } catch (err) {
      this.emit(`Init error: ${err.message}`);
    }
  }

  async performPairing(controller, writeChar) {
    const addr = this.hostAddress;

    // Step 1: Exchange addresses (0x15.01)
    const cmd1 = [0x15, 0x91, 0x01, 0x01, 0x00, 0x0E, 0x00, 0x00, 0x00, 0x02];
    for (let i = 5; i >= 0; i--) cmd1.push((addr >> (i * 8)) & 0xFF);
    for (let i = 5; i >= 0; i--) cmd1.push((addr >> (i * 8)) & 0xFF);
    cmd1[16] = (cmd1[16] - 1) & 0xFF;
    await this.writeCommand(cmd1, controller, writeChar);
    await this.sleep(200);

    // Step 2: Exchange keys (0x15.04)
    const cmd2 = [0x15, 0x91, 0x01, 0x04, 0x00, 0x11, 0x00, 0x00, 0x00, ...BLEManager.FIXED_PUBLIC_KEY];
    await this.writeCommand(cmd2, controller, writeChar);
    await this.sleep(200);

    // Step 3: Confirm LTK (0x15.02)
    const cmd3 = [0x15, 0x91, 0x01, 0x02, 0x00, 0x11, 0x00, 0x00, 0x00, ...BLEManager.FIXED_CHALLENGE];
    await this.writeCommand(cmd3, controller, writeChar);
    await this.sleep(200);

    // Step 4: Finalize (0x15.03)
    await this.writeCommand([0x15, 0x91, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00], controller, writeChar);
    await this.sleep(200);

    this.emit('Pairing sequence complete');
  }

  // MARK: - LED

  async setPlayerLED(controller) {
    const isJC = isJoyCon(controller.controllerType);
    const ledPattern = (1 << controller.playerNumber) - 1;

    if (isJC) {
      if (!controller.writeChar) return;
      const cmd = [
        0x09, 0x91, 0x01, 0x07,
        0x00, 0x08, 0x00, 0x00,
        ledPattern, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ];
      await this.writeCommand(cmd, controller, controller.writeChar);
    } else {
      const cmdChar = controller.commandWriteChar || controller.writeChar;
      if (!cmdChar) return;

      if (controller.controllerType === ControllerType.GAME_CUBE) {
        const cmd = new Array(21).fill(0x00);
        cmd[1] = 0x50;
        cmd[5] = 0x09; cmd[6] = 0x91; cmd[7] = 0x01; cmd[8] = 0x07;
        cmd[10] = 0x08;
        cmd[13] = ledPattern;
        await this.writeCommand(cmd, controller, cmdChar);
      } else {
        const cmd = new Array(41).fill(0x00);
        cmd[1] = 0x50;
        cmd[2] = 0xe1; cmd[4] = 0x10; cmd[5] = 0x1e;
        cmd[17] = 0x50;
        cmd[18] = 0xe1; cmd[20] = 0x10; cmd[21] = 0x1e;
        cmd[33] = 0x09; cmd[34] = 0x91; cmd[35] = 0x01; cmd[36] = 0x07;
        cmd[38] = 0x08;
        cmd[40] = ledPattern;
        await this.writeCommand(cmd, controller, cmdChar);
      }
    }
  }

  // MARK: - Input Processing

  handleInputReport(controller, dataView) {
    const state = parseInputReport(dataView.buffer);
    if (!state) return;

    // Apply stick calibration if available
    const cal = controller.cal;
    if (cal.valid) {
      state.calLeftX  = applyStickCal(state.leftStickX,  cal.sticks[0][0], cal.deadzone[0]);
      state.calLeftY  = applyStickCal(state.leftStickY,  cal.sticks[0][1], cal.deadzone[0]);
      state.calRightX = applyStickCal(state.rightStickX, cal.sticks[1][0], cal.deadzone[1]);
      state.calRightY = applyStickCal(state.rightStickY, cal.sticks[1][1], cal.deadzone[1]);
    } else {
      state.calLeftX  = state.leftStickX - 2048;
      state.calLeftY  = state.leftStickY - 2048;
      state.calRightX = state.rightStickX - 2048;
      state.calRightY = state.rightStickY - 2048;
    }

    // Apply trigger calibration
    state.calTriggerL = applyTriggerCal(state.triggerL, cal.trigNeutral[0], cal.trigMax[0]);
    state.calTriggerR = applyTriggerCal(state.triggerR, cal.trigNeutral[1], cal.trigMax[1]);

    // Mouse delta
    if (controller.mouseInitialized) {
      state.mouseDeltaX = state.mouseX - controller.lastMouseX;
      state.mouseDeltaY = state.mouseY - controller.lastMouseY;
    } else {
      state.mouseDeltaX = 0;
      state.mouseDeltaY = 0;
      controller.mouseInitialized = true;
    }

    controller.lastMouseX = state.mouseX;
    controller.lastMouseY = state.mouseY;
    controller.state = state;

    if (this.onControllerUpdate) this.onControllerUpdate(controller);
  }

  handleCommandResponse(controller, dataView) {
    const data = new Uint8Array(dataView.buffer);
    if (data.length < 4) return;
    // Log interesting responses
    if (data[0] === 0x16 && data[3] === 0x01 && data.length >= 32) {
      this.emit('SL+SR wakeup detected');
    }
  }

  // MARK: - HD Rumble

  startHDRumble(controllerIndex, lfFreq, lfAmp, hfFreq, hfAmp) {
    this.stopRumble(controllerIndex);
    this.activeRumbleParams = { controllerIndex, lfFreq, lfAmp, hfFreq, hfAmp };
    this.sendHDRumblePacket(controllerIndex, lfFreq, lfAmp, hfFreq, hfAmp);
    this.rumbleInterval = setInterval(() => {
      if (!this.activeRumbleParams) return;
      const p = this.activeRumbleParams;
      this.sendHDRumblePacket(p.controllerIndex, p.lfFreq, p.lfAmp, p.hfFreq, p.hfAmp);
    }, 10); // 10ms for web (5ms is too aggressive for JS timers)
  }

  updateHDRumble(lfFreq, lfAmp, hfFreq, hfAmp) {
    if (!this.activeRumbleParams) return;
    this.activeRumbleParams.lfFreq = lfFreq;
    this.activeRumbleParams.lfAmp = lfAmp;
    this.activeRumbleParams.hfFreq = hfFreq;
    this.activeRumbleParams.hfAmp = hfAmp;
  }

  sendHDRumblePacket(controllerIndex, lfFreq, lfAmp, hfFreq, hfAmp) {
    const controller = this.controllers[controllerIndex];
    if (!controller || controller.controllerType === ControllerType.GAME_CUBE) return;
    if (!controller.hdRumbleChar) return;

    this.rumbleTid = (this.rumbleTid + 1) & 0x0F;
    const cmd = new Array(43).fill(0x00);

    const enable = lfAmp > 0 || hfAmp > 0;
    const stateByte = (enable ? 0x70 : 0x30) | this.rumbleTid;

    let lraOp = 0;
    lraOp |= (lfFreq & 0x1FF);
    lraOp |= (1 << 9);
    lraOp |= ((lfAmp & 0x3FF) << 10);
    lraOp |= ((hfFreq & 0x1FF) << 20);
    lraOp |= (1 << 29);
    if (enable) lraOp |= (1 << 31);
    lraOp = lraOp >>> 0; // force unsigned

    cmd[1] = stateByte;
    cmd[2] = lraOp & 0xFF;
    cmd[3] = (lraOp >> 8) & 0xFF;
    cmd[4] = (lraOp >> 16) & 0xFF;
    cmd[5] = (lraOp >> 24) & 0xFF;
    cmd[6] = hfAmp;
    for (let op = 1; op <= 2; op++) {
      const base = 2 + op * 5;
      cmd[base] = cmd[2]; cmd[base+1] = cmd[3]; cmd[base+2] = cmd[4];
      cmd[base+3] = cmd[5]; cmd[base+4] = cmd[6];
    }

    cmd[17] = stateByte;
    for (let i = 0; i < 15; i++) cmd[18 + i] = cmd[2 + i];

    this.writeCommand(cmd, controller, controller.hdRumbleChar);
  }

  stopRumble(controllerIndex) {
    if (this.rumbleInterval) {
      clearInterval(this.rumbleInterval);
      this.rumbleInterval = null;
    }
    this.activeRumbleParams = null;

    const controller = this.controllers[controllerIndex];
    if (!controller) return;

    if (controller.controllerType === ControllerType.GAME_CUBE) {
      this.sendGCRumblePacket(controllerIndex, false);
      this.activeGCRumbleIndex = null;
    } else {
      this.sendHDRumblePacket(controllerIndex, 0, 0, 0, 0);
    }
  }

  setGCRumble(controllerIndex, on) {
    if (on) {
      this.stopRumble(controllerIndex);
      this.activeGCRumbleIndex = controllerIndex;
      this.sendGCRumblePacket(controllerIndex, true);
      this.rumbleInterval = setInterval(() => {
        if (this.activeGCRumbleIndex == null) return;
        this.sendGCRumblePacket(this.activeGCRumbleIndex, true);
      }, 10);
    } else {
      this.stopRumble(controllerIndex);
    }
  }

  sendGCRumblePacket(controllerIndex, on) {
    const controller = this.controllers[controllerIndex];
    if (!controller || controller.controllerType !== ControllerType.GAME_CUBE) return;
    const cmdChar = controller.commandWriteChar || controller.writeChar;
    if (!cmdChar) return;

    this.rumbleTid = (this.rumbleTid + 1) & 0x0F;
    const cmd = new Array(21).fill(0x00);
    cmd[1] = 0x50 | this.rumbleTid;
    cmd[2] = on ? 0x01 : 0x00;
    this.writeCommand(cmd, controller, cmdChar);
  }

  // MARK: - Helpers

  nextSlot() {
    const used = new Set(this.controllers.map(c => c.playerNumber));
    for (let i = 1; i <= 4; i++) {
      if (!used.has(i)) return i;
    }
    return 1;
  }
}
