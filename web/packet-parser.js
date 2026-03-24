/**
 * Parser for 63-byte Nintendo Switch 2 BLE input reports.
 * Direct port of JoyConPacket.swift + JoyConState.swift
 */

const ControllerType = Object.freeze({
  JOY_CON_RIGHT:  0x2066,
  JOY_CON_LEFT:   0x2067,
  PRO_CONTROLLER:  0x2069,
  GAME_CUBE:       0x2073,
  UNKNOWN:         0x0000,
});

const CONTROLLER_NAMES = {
  [ControllerType.JOY_CON_LEFT]:   'Joy-Con 2 (L)',
  [ControllerType.JOY_CON_RIGHT]:  'Joy-Con 2 (R)',
  [ControllerType.PRO_CONTROLLER]: 'Pro Controller 2',
  [ControllerType.GAME_CUBE]:      'NSO GameCube',
  [ControllerType.UNKNOWN]:        'Unknown Controller',
};

const FEATURE_FLAGS = {
  [ControllerType.JOY_CON_LEFT]:   0xFF,
  [ControllerType.JOY_CON_RIGHT]:  0xFF,
  [ControllerType.PRO_CONTROLLER]: 0x2F,
  [ControllerType.GAME_CUBE]:      0x2F,  // 0x2F enables IMU (bit 3), 0x27 disables it
  [ControllerType.UNKNOWN]:        0x07,
};

// ---------------------------------------------------------------------------
// Stick + trigger calibration (ported from NinBridge switch2.c)
// ---------------------------------------------------------------------------

// SPI flash addresses for calibration data
const SPI_CAL_LEFT  = 0x00013080;
const SPI_CAL_RIGHT = 0x000130C0;
const SPI_CAL_USER  = 0x001FC040;
const SPI_INFO      = 0x00007E00;

/**
 * Unpack 9-byte stick calibration from SPI flash.
 * Returns { neutral, relMax, relMin } for X and Y axes.
 */
function unpackStickCal(data, offset) {
  const d = data.slice(offset, offset + 9);
  return {
    x: {
      neutral: d[0] | ((d[1] & 0x0F) << 8),
      relMax:  d[3] | ((d[4] & 0x0F) << 8),
      relMin:  d[6] | ((d[7] & 0x0F) << 8),
    },
    y: {
      neutral: (d[1] >> 4) | (d[2] << 4),
      relMax:  (d[4] >> 4) | (d[5] << 4),
      relMin:  (d[7] >> 4) | (d[8] << 4),
    },
  };
}

/**
 * Apply stick calibration: raw 12-bit -> normalized +-32767
 */
function applyStickCal(raw, cal, deadzone) {
  if (!cal || !cal.neutral) return raw - 2048;
  let centered = raw - cal.neutral;
  const range = centered >= 0 ? cal.relMax : cal.relMin;
  if (range === 0) return 0;

  // Dead zone
  if (deadzone > 0 && centered > -deadzone && centered < deadzone) return 0;

  let scaled = (centered * 32767) / range;
  return Math.max(-32767, Math.min(32767, Math.round(scaled)));
}

/**
 * Apply trigger calibration: raw 0-255 -> calibrated 0-255
 */
function applyTriggerCal(raw, neutral, max) {
  if (raw <= neutral) return 0;
  const range = max - neutral;
  if (range === 0) return 0;
  const val = ((raw - neutral) * 255) / range;
  return Math.min(255, Math.round(val));
}

// Default trigger calibration (from NinBridge/BlueRetro)
const DEFAULT_TRIGGER_CAL = { neutral: 30, max: 195 };

// Button bit masks
const Button = Object.freeze({
  ZL:     0x80000000,
  L:      0x40000000,
  SL_L:   0x20000000,
  SR_L:   0x10000000,
  LEFT:   0x08000000,
  RIGHT:  0x04000000,
  UP:     0x02000000,
  DOWN:   0x01000000,
  CHAT:   0x00400000,
  CAMERA: 0x00200000,
  HOME:   0x00100000,
  LS:     0x00080000,
  RS:     0x00040000,
  START:  0x00020000,
  SELECT: 0x00010000,
  ZR:     0x00008000,
  R:      0x00004000,
  SL_R:   0x00002000,
  SR_R:   0x00001000,
  A:      0x00000800,
  B:      0x00000400,
  X:      0x00000200,
  Y:      0x00000100,
});

function getControllerName(type) {
  return CONTROLLER_NAMES[type] || 'Unknown Controller';
}

function isJoyCon(type) {
  return type === ControllerType.JOY_CON_LEFT || type === ControllerType.JOY_CON_RIGHT;
}

/**
 * Parse a 63-byte input report into a state object.
 */
function parseInputReport(data) {
  if (data.byteLength < 63) return null;

  const bytes = new Uint8Array(data);

  // Packet ID (3 bytes LE)
  const packetId = bytes[0] | (bytes[1] << 8) | (bytes[2] << 16);

  // Buttons (4 bytes at 0x03) - use >>> 0 to force unsigned 32-bit
  const buttons = (bytes[3] | (bytes[4] << 8) | (bytes[5] << 16) | (bytes[6] << 24)) >>> 0;

  // Left stick (3 bytes at 0x0A, 12-bit X and Y)
  const leftRaw = bytes[0x0A] | (bytes[0x0B] << 8) | (bytes[0x0C] << 16);
  const leftStickX = leftRaw & 0xFFF;
  const leftStickY = (leftRaw >> 12) & 0xFFF;

  // Right stick (3 bytes at 0x0D, 12-bit X and Y)
  const rightRaw = bytes[0x0D] | (bytes[0x0E] << 8) | (bytes[0x0F] << 16);
  const rightStickX = rightRaw & 0xFFF;
  const rightStickY = (rightRaw >> 12) & 0xFFF;

  // Mouse sensor (signed 16-bit)
  const dv = new DataView(data instanceof ArrayBuffer ? data : data.buffer, data.byteOffset || 0);
  const mouseX = dv.getInt16(0x10, true);
  const mouseY = dv.getInt16(0x12, true);

  // Magnetometer
  const magX = dv.getInt16(0x18, true);
  const magY = dv.getInt16(0x1A, true);
  const magZ = dv.getInt16(0x1C, true);

  // Battery voltage (0x1F-0x20)
  const voltageRaw = dv.getUint16(0x1F, true);
  const batteryVoltage = voltageRaw / 1000.0;

  // Charging detection (byte 0x21 > 0 = charging, from NinBridge)
  const charging = bytes[0x21] > 0;

  // Battery current (0x28-0x29)
  const currentRaw = dv.getUint16(0x28, true);
  const batteryCurrent = currentRaw / 100.0;

  // Temperature (0x2E-0x2F)
  const tempRaw = dv.getInt16(0x2E, true);
  const temperature = 25.0 + tempRaw / 127.0;

  // Accelerometer (0x30-0x35)
  const accelX = dv.getInt16(0x30, true);
  const accelY = dv.getInt16(0x32, true);
  const accelZ = dv.getInt16(0x34, true);

  // Gyroscope (0x36-0x3B)
  const gyroX = dv.getInt16(0x36, true);
  const gyroY = dv.getInt16(0x38, true);
  const gyroZ = dv.getInt16(0x3A, true);

  // Analog triggers (0x3C-0x3D)
  const triggerL = bytes[0x3C];
  const triggerR = bytes[0x3D];

  return {
    packetId,
    buttons,
    leftStickX, leftStickY,
    rightStickX, rightStickY,
    mouseX, mouseY,
    magX, magY, magZ,
    batteryVoltage, batteryCurrent, charging, temperature,
    accelX, accelY, accelZ,
    gyroX, gyroY, gyroZ,
    triggerL, triggerR,
  };
}

/**
 * Get normalized stick values (-1 to 1)
 */
function normalizeStick(raw) {
  return (raw - 2048) / 2048;
}

/**
 * Get battery percentage from voltage
 */
function batteryPercentage(voltage) {
  // NinBridge formula: 3.0V floor, 1.2V range (3.0-4.2V)
  const pct = (voltage - 3.0) / 1.2 * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

/**
 * Get list of pressed button names
 */
function getPressedButtons(buttons, controllerType) {
  const pressed = [];
  const isGC = controllerType === ControllerType.GAME_CUBE;

  if (isGC) {
    if (buttons & Button.A)      pressed.push('A');
    if (buttons & Button.B)      pressed.push('B');
    if (buttons & Button.X)      pressed.push('X');
    if (buttons & Button.Y)      pressed.push('Y');
    if (buttons & Button.L)      pressed.push('L');
    if (buttons & Button.R)      pressed.push('R');
    if (buttons & Button.ZL)     pressed.push('ZL');
    if (buttons & Button.ZR)     pressed.push('ZR');
    if (buttons & Button.UP)     pressed.push('Up');
    if (buttons & Button.DOWN)   pressed.push('Down');
    if (buttons & Button.LEFT)   pressed.push('Left');
    if (buttons & Button.RIGHT)  pressed.push('Right');
    if (buttons & Button.START)  pressed.push('Start');
    if (buttons & Button.CHAT)   pressed.push('C');
    if (buttons & Button.HOME)   pressed.push('Home');
    if (buttons & Button.CAMERA) pressed.push('Capture');
  } else {
    if (buttons & Button.A)      pressed.push('A');
    if (buttons & Button.B)      pressed.push('B');
    if (buttons & Button.X)      pressed.push('X');
    if (buttons & Button.Y)      pressed.push('Y');
    if (buttons & Button.L)      pressed.push('L');
    if (buttons & Button.R)      pressed.push('R');
    if (buttons & Button.ZL)     pressed.push('ZL');
    if (buttons & Button.ZR)     pressed.push('ZR');
    if (buttons & Button.UP)     pressed.push('Up');
    if (buttons & Button.DOWN)   pressed.push('Down');
    if (buttons & Button.LEFT)   pressed.push('Left');
    if (buttons & Button.RIGHT)  pressed.push('Right');
    if (buttons & Button.START)  pressed.push('+');
    if (buttons & Button.SELECT) pressed.push('-');
    if (buttons & Button.HOME)   pressed.push('Home');
    if (buttons & Button.CAMERA) pressed.push('Capture');
    if (buttons & Button.CHAT)   pressed.push('Chat');
    if (buttons & Button.LS)     pressed.push('LS');
    if (buttons & Button.RS)     pressed.push('RS');
    if (buttons & Button.SL_L)   pressed.push('SL(L)');
    if (buttons & Button.SR_L)   pressed.push('SR(L)');
    if (buttons & Button.SL_R)   pressed.push('SL(R)');
    if (buttons & Button.SR_R)   pressed.push('SR(R)');
  }

  return pressed;
}
