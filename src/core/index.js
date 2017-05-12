import LCD from "./lcd.js";
import * as util from "./util";
import settings from "../settings.js";
import TickTable from "./tick-table.js";
import CartridgeSlot from "./cartridge-slot.js";
import AudioServer from "../audio-server.js";
import mainInstructions from "./main-instructions.js";
import PostBootRegisterState from "./post-boot-register-state.js";
import StateManager from "./state-manager.js";
import dutyLookup from "./duty-lookup.js";
import Joypad from "./joypad.js";
import EventEmitter from "events";
import Memory from "./memory/index.js";
import CPU from "./cpu.js";

function GameBoyCore({ audioContext, api, lcd: lcdOptions = {} }) {
  this.audioContext = audioContext;
  this.api = api;
  this.events = new EventEmitter(); // TODO: use as super

  lcdOptions.gameboy = this;

  this.memoryNew = new Memory({ gameboy: this });

  this.cpu = new CPU();
  this.joypad = new Joypad(this);
  this.cartridgeSlot = new CartridgeSlot(this);
  this.lcd = new LCD(lcdOptions);
  this.stateManager = new StateManager(this);
  this.stateManager.init();

  //GB BOOT ROM
  //Add 256 byte boot rom here if you are going to use it.
  this.GBBOOTROM = [];

  //GBC BOOT ROM
  //Add 2048 byte boot rom here if you are going to use it.
  this.GBCBOOTROM = [];

  this.memoryReadNormal = this.memoryReadNormal.bind(this);
  this.memoryWriteNormal = this.memoryWriteNormal.bind(this);
  this.memoryWriteGBCRAM = this.memoryWriteGBCRAM.bind(this);
  this.memoryWriteMBCRAM = this.memoryWriteMBCRAM.bind(this);
  this.memoryWriteMBC3RAM = this.memoryWriteMBC3RAM.bind(this);
  this.memoryReadGBCMemory = this.memoryReadGBCMemory.bind(this);
  this.memoryReadROM = this.memoryReadROM.bind(this);
  this.memoryHighWriteNormal = this.memoryHighWriteNormal.bind(this);
  this.memoryHighReadNormal = this.memoryHighReadNormal.bind(this);
  this.MBC5WriteRAMBank = this.MBC5WriteRAMBank.bind(this);
  this.MBCWriteEnable = this.MBCWriteEnable.bind(this);
  this.memoryReadMBC = this.memoryReadMBC.bind(this);
  this.memoryReadMBC3 = this.memoryReadMBC3.bind(this);
  this.memoryReadMBC7 = this.memoryReadMBC7.bind(this);

  this.BGGBLayerRender = this.BGGBLayerRender.bind(this);
  this.WindowGBLayerRender = this.WindowGBLayerRender.bind(this);
  this.SpriteGBLayerRender = this.SpriteGBLayerRender.bind(this);
  this.SpriteGBCLayerRender = this.SpriteGBCLayerRender.bind(this);

  this.usedGBCBootROM = false; // Did we boot to the GBC boot ROM?
  this.stopEmulator = 3; // Has the emulation been paused or a frame has ended?
  this.IRQLineMatched = 0; // CPU IRQ assertion.

  // Main RAM, MBC RAM, GBC Main RAM, VRAM, etc.
  this.memoryReader = []; // Array of functions mapped to read back memory
  this.memoryWriter = []; // Array of functions mapped to write to memory
  this.memoryHighReader = []; // Array of functions mapped to read back 0xFFXX memory
  this.memoryHighWriter = []; // Array of functions mapped to write to 0xFFXX memory
  this.savedStateFileName = ""; // When loaded in as a save state, this will not be empty.
  this.spriteCount = 252; // Mode 3 extra clocking counter (Depends on how many sprites are on the current line.).
  this.LINECONTROL = []; // Array of functions to handle each scan line we do (onscreen + offscreen)
  this.DISPLAYOFFCONTROL = [function () {}]; // Array of line 0 function to handle the LCD controller when it's off (Do nothing!).

  this.LCDCONTROL = null; //Pointer to either LINECONTROL or DISPLAYOFFCONTROL.
  this.initializeLCDController(); //Compile the LCD controller functions.

  //Sound variables:
  this.audioServer = null; //XAudioJS handle
  this.numSamplesTotal = 0; //Length of the sound buffers.
  this.bufferContainAmount = 0; //Buffer maintenance metric.
  this.LSFR15Table = null;
  this.LSFR7Table = null;
  this.noiseSampleTable = null;
  this.initializeAudioStartState();

  //Audio generation counters:
  this.audioTicks = 0; //Used to sample the audio system every x CPU instructions.
  this.audioIndex = 0; //Used to keep alignment on audio generation.
  this.downsampleInput = 0;
  this.audioDestinationPosition = 0; //Used to keep alignment on audio generation.
  this.rollover = 0; //Used to keep alignment on the number of samples to output (Realign from counter alias).

  //Graphics Variables
  this.drewFrame = false; //Throttle how many draws we can do to once per iteration.
  this.midScanlineOffset = -1; //mid-scanline rendering offset.
  this.pixelEnd = 0; //track the x-coord limit for line rendering (mid-scanline usage).
  this.currentX = 0; //The x-coord we left off at for mid-scanline rendering.

  //BG Tile Pointer Caches:
  this.BGCHRCurrentBank = null;

  //Tile Data Cache:
  this.tileCache = null;

  //Palettes:
  this.colors = [0xefffde, 0xadd794, 0x529273, 0x183442]; // "Classic" GameBoy palette colors.
  this.OBJPalette = null;
  this.BGPalette = null;
  this.updateGBBGPalette = this.updateGBRegularBGPalette;
  this.updateGBOBJPalette = this.updateGBRegularOBJPalette;
  this.BGLayerRender = null; // Reference to the BG rendering function.
  this.WindowLayerRender = null; // Reference to the window rendering function.
  this.SpriteLayerRender = null; // Reference to the OAM rendering function.
  this.pixelStart = 0; // Temp variable for holding the current working framebuffer offset.

  //Initialize the white noise cache tables ahead of time:
  this.intializeWhiteNoise();
}
GameBoyCore.prototype.loadState = function (state) {
  this.stateManager.load(state);

  this.initializeReferencesFromSaveState();
  this.memoryReadJumpCompile();
  this.memoryWriteJumpCompile();
  this.lcd.init();
  this.initSound();
  this.noiseSampleTable = this.channel4BitRange === 0x7fff ?
    this.LSFR15Table :
    this.LSFR7Table;
  this.channel4VolumeShifter = this.channel4BitRange === 0x7fff ? 15 : 7;
};
GameBoyCore.prototype.start = function (cartridge) {
  this.init();
  this.cartridgeSlot.insertCartridge(cartridge);
  this.cartridgeSlot.readCartridge();
  this.cartridgeSlot.cartridge.mbc.setupROM();

  if (this.cartridgeSlot.cartridge && this.cartridgeSlot.cartridge.mbc) {
    this.cartridgeSlot.cartridge.mbc.on("ramWrite", () => {
      this.events.emit("sramWrite");
    });
  }

  if (!this.usedBootROM) {
    this.inBootstrap = false;
    this.setupRAM();
    this.initSkipBootstrap();
  } else {
    this.setupRAM();
    this.initBootstrap();
  }

  // Check for IRQ matching upon initialization:
  this.checkIRQMatching();
};
GameBoyCore.prototype.init = function () {
  this.stateManager.init();
  this.initMemory(); // Write the startup memory.
  this.lcd.init(); // Initialize the graphics.
  this.initSound(); // Sound object initialization.
};
GameBoyCore.prototype.setupRAM = function () {
  this.cartridgeSlot.cartridge.setupRAM();

  // Setup the RAM for GBC mode.
  if (this.cartridgeSlot.cartridge.useGBCMode) {
    this.VRAM = util.getTypedArray(0x2000, 0, "uint8");
    this.GBCMemory = util.getTypedArray(0x7000, 0, "uint8");
  }

  this.memoryReadJumpCompile();
  this.memoryWriteJumpCompile();

  this.initializeModeSpecificArrays();
};
GameBoyCore.prototype.initMemory = function () {
  // Initialize the RAM:
  this.memory = util.getTypedArray(0x10000, 0, "uint8"); // TODO: remove
  this.memoryNew.data = this.memory;
  this.frameBuffer = util.getTypedArray(23040, 0xf8f8f8, "int32");
  this.BGCHRBank1 = util.getTypedArray(0x800, 0, "uint8");
  this.channel3PCM = util.getTypedArray(0x20, 0, "int8");
};
GameBoyCore.prototype.generateCacheArray = function (tileAmount) {
  var tileArray = [];
  var tileNumber = 0;
  while (tileNumber < tileAmount) {
    tileArray[tileNumber++] = util.getTypedArray(64, 0, "uint8");
  }
  return tileArray;
};
GameBoyCore.prototype.initSkipBootstrap = function () {
  // Fill in the boot ROM set register values
  // Default values to the GB boot ROM values, then fill in the GBC boot ROM values after ROM loading
  var index = 0xff;
  while (index >= 0) {
    if (index >= 0x30 && index < 0x40) {
      this.memoryWrite(0xff00 | index, PostBootRegisterState[index]);
    } else {
      switch (index) {
      case 0x00:
      case 0x01:
      case 0x02:
      case 0x05:
      case 0x07:
      case 0x0f:
      case 0xff:
        this.memoryWrite(0xff00 | index, PostBootRegisterState[index]);
        break;
      default:
        this.memory[0xff00 | index] = PostBootRegisterState[index];
      }
    }
    --index;
  }

  if (this.cartridgeSlot.cartridge.useGBCMode) {
    this.memory[0xff6c] = 0xfe;
    this.memory[0xff74] = 0xfe;
  } else {
    this.memory[0xff48] = 0xff;
    this.memory[0xff49] = 0xff;
    this.memory[0xff6c] = 0xff;
    this.memory[0xff74] = 0xff;
  }

  // Start as an unset device:
  console.log("Starting without the GBC boot ROM.");
  this.registerA = this.cartridgeSlot.cartridge.useGBCMode ? 0x11 : 0x1;
  this.registerB = 0;
  this.registerC = 0x13;
  this.registerD = 0;
  this.registerE = 0xd8;
  this.FZero = true;
  this.FSubtract = false;
  this.FHalfCarry = true;
  this.FCarry = true;
  this.registersHL = 0x014d;
  this.LCDCONTROL = this.LINECONTROL;
  this.IME = false;
  this.IRQLineMatched = 0;
  this.interruptsRequested = 225;
  this.interruptsEnabled = 0;
  this.hdmaRunning = false;
  this.CPUTicks = 12;
  this.STATTracker = 0;
  this.modeSTAT = 1;
  this.spriteCount = 252;
  this.LYCMatchTriggerSTAT = false;
  this.mode2TriggerSTAT = false;
  this.mode1TriggerSTAT = false;
  this.mode0TriggerSTAT = false;
  this.LCDisOn = true;
  this.channel1FrequencyTracker = 0x2000;
  this.channel1DutyTracker = 0;
  this.channel1CachedDuty = dutyLookup[2];
  this.channel1totalLength = 0;
  this.channel1envelopeVolume = 0;
  this.channel1envelopeType = false;
  this.channel1envelopeSweeps = 0;
  this.channel1envelopeSweepsLast = 0;
  this.channel1consecutive = true;
  this.channel1frequency = 1985;
  this.channel1SweepFault = true;
  this.channel1ShadowFrequency = 1985;
  this.channel1timeSweep = 1;
  this.channel1lastTimeSweep = 0;
  this.channel1Swept = false;
  this.channel1frequencySweepDivider = 0;
  this.channel1decreaseSweep = false;
  this.channel2FrequencyTracker = 0x2000;
  this.channel2DutyTracker = 0;
  this.channel2CachedDuty = dutyLookup[2];
  this.channel2totalLength = 0;
  this.channel2envelopeVolume = 0;
  this.channel2envelopeType = false;
  this.channel2envelopeSweeps = 0;
  this.channel2envelopeSweepsLast = 0;
  this.channel2consecutive = true;
  this.channel2frequency = 0;
  this.channel3canPlay = false;
  this.channel3totalLength = 0;
  this.channel3patternType = 4;
  this.channel3frequency = 0;
  this.channel3consecutive = true;
  this.channel3Counter = 0x418;
  this.channel4FrequencyPeriod = 8;
  this.channel4totalLength = 0;
  this.channel4envelopeVolume = 0;
  this.channel4currentVolume = 0;
  this.channel4envelopeType = false;
  this.channel4envelopeSweeps = 0;
  this.channel4envelopeSweepsLast = 0;
  this.channel4consecutive = true;
  this.channel4BitRange = 0x7fff;
  this.channel4VolumeShifter = 15;
  this.channel1FrequencyCounter = 0x200;
  this.channel2FrequencyCounter = 0x200;
  this.channel3Counter = 0x800;
  this.channel3FrequencyPeriod = 0x800;
  this.channel3lastSampleLookup = 0;
  this.channel4lastSampleLookup = 0;
  this.VinLeftChannelMasterVolume = 8;
  this.VinRightChannelMasterVolume = 8;
  this.soundMasterEnabled = true;
  this.leftChannel1 = true;
  this.leftChannel2 = true;
  this.leftChannel3 = true;
  this.leftChannel4 = true;
  this.rightChannel1 = true;
  this.rightChannel2 = true;
  this.rightChannel3 = false;
  this.rightChannel4 = false;
  this.DIVTicks = 27044;
  this.LCDTicks = 160;
  this.timerTicks = 0;
  this.TIMAEnabled = false;
  this.TACClocker = 1024;
  this.serialTimer = 0;
  this.serialShiftTimer = 0;
  this.serialShiftTimerAllocated = 0;
  this.IRQEnableDelay = 0;
  this.actualScanLine = 144;
  this.lastUnrenderedLine = 0;
  this.gfxWindowDisplay = false;
  this.gfxSpriteShow = false;
  this.gfxSpriteNormalHeight = true;
  this.bgEnabled = true;
  this.BGPriorityEnabled = true;
  this.gfxWindowCHRBankPosition = 0;
  this.gfxBackgroundCHRBankPosition = 0;
  this.gfxBackgroundBankOffset = 0;
  this.windowY = 0;
  this.windowX = 0;
  this.drewBlank = 0;
  this.midScanlineOffset = -1;
  this.currentX = 0;
};
GameBoyCore.prototype.initBootstrap = function () {
  console.log("Starting selected boot ROM");

  this.programCounter = 0;
  this.stackPointer = 0;
  this.IME = false;
  this.LCDTicks = 0;
  this.DIVTicks = 0;
  this.registerA = 0;
  this.registerB = 0;
  this.registerC = 0;
  this.registerD = 0;
  this.registerE = 0;
  this.FZero = this.FSubtract = this.FHalfCarry = this.FCarry = false;
  this.registersHL = 0;
  this.leftChannel1 = false;
  this.leftChannel2 = false;
  this.leftChannel3 = false;
  this.leftChannel4 = false;
  this.rightChannel1 = false;
  this.rightChannel2 = false;
  this.rightChannel3 = false;
  this.rightChannel4 = false;
  this.channel2frequency = this.channel1frequency = 0;
  this.channel4consecutive = this.channel2consecutive = this.channel1consecutive = false;
  this.VinLeftChannelMasterVolume = 8;
  this.VinRightChannelMasterVolume = 8;
  this.memory[0xff00] = this.joypad.initialValue;
};
GameBoyCore.prototype.disableBootROM = function () {
  // Remove any traces of the boot ROM from ROM memory.
  let index = 0;
  while (index < 0x100) {
    this.memory[index] = this.cartridgeSlot.cartridge.rom.getByte(index); // Replace the GameBoy or GameBoy Color boot ROM with the game ROM.
    ++index;
  }

  if (this.usedGBCBootROM) {
    // Remove any traces of the boot ROM from ROM memory.
    for (index = 0x200; index < 0x900; ++index) {
      this.memory[index] = this.cartridgeSlot.cartridge.rom.getByte(index); // Replace the GameBoy Color boot ROM with the game ROM.
    }
    if (!this.cartridgeSlot.cartridge.useGBCMode) {
      // Clean up the post-boot (GB mode only) state:
      this.adjustGBCtoGBMode();
    } else {
      this.recompileBootIOWriteHandling();
    }
  } else {
    this.recompileBootIOWriteHandling();
  }
};
GameBoyCore.prototype.setSpeed = function (speed) {
  this.cpu.setSpeedMultiplier(speed);
  if (this.audioServer) {
    this.initSound();
  }
};
GameBoyCore.prototype.initSound = function () {
  this.audioResamplerFirstPassFactor = Math.max(Math.min(Math.floor(this.cpu.clocksPerSecond / 44100), Math.floor(0xffff / 0x1e0)), 1);
  this.downSampleInputDivider = 1 / (this.audioResamplerFirstPassFactor * 0xf0);

  // TODO: create sound controller
  // TODO: separate turn sound off / on
  if (!settings.soundOn) {
    if (this.audioServer) this.audioServer.changeVolume(0);
  } else {
    if (!this.audioServer) {
      const sampleRate = this.cpu.clocksPerSecond / this.audioResamplerFirstPassFactor;
      const maxBufferSize = Math.max(this.cpu.baseCyclesPerIteration * settings.maxAudioBufferSpanAmountOverXInterpreterIterations / this.audioResamplerFirstPassFactor, 8192) << 1;

      this.audioServer = new AudioServer({
        audioContext: this.audioContext,
        channels: 2,
        sampleRate,
        minBufferSize: 0,
        maxBufferSize,
        volume: settings.soundVolume
      });
      this.initAudioBuffer();
    }
  }
};
GameBoyCore.prototype.changeVolume = function () {
  if (this.audioServer) {
    this.audioServer.changeVolume(settings.soundVolume);
  }
};
GameBoyCore.prototype.initAudioBuffer = function () {
  this.audioIndex = 0;
  this.audioDestinationPosition = 0;
  this.downsampleInput = 0;
  this.bufferContainAmount = Math.max(this.cpu.baseCyclesPerIteration * settings.minAudioBufferSpanAmountOverXInterpreterIterations / this.audioResamplerFirstPassFactor, 4096) << 1;
  this.numSamplesTotal = this.cpu.baseCyclesPerIteration / this.audioResamplerFirstPassFactor << 1;
  this.audioBuffer = util.getTypedArray(this.numSamplesTotal, 0, "float32");
};
GameBoyCore.prototype.intializeWhiteNoise = function () {
  //Noise Sample Tables:
  var randomFactor = 1;
  //15-bit LSFR Cache Generation:
  this.LSFR15Table = util.getTypedArray(0x80000, 0, "int8");
  var LSFR = 0x7fff; //Seed value has all its bits set.
  var LSFRShifted = 0x3fff;
  for (var index = 0; index < 0x8000; ++index) {
    //Normalize the last LSFR value for usage:
    randomFactor = 1 - (LSFR & 1); //Docs say it's the inverse.
    //Cache the different volume level results:
    this.LSFR15Table[0x08000 | index] = randomFactor;
    this.LSFR15Table[0x10000 | index] = randomFactor * 0x2;
    this.LSFR15Table[0x18000 | index] = randomFactor * 0x3;
    this.LSFR15Table[0x20000 | index] = randomFactor * 0x4;
    this.LSFR15Table[0x28000 | index] = randomFactor * 0x5;
    this.LSFR15Table[0x30000 | index] = randomFactor * 0x6;
    this.LSFR15Table[0x38000 | index] = randomFactor * 0x7;
    this.LSFR15Table[0x40000 | index] = randomFactor * 0x8;
    this.LSFR15Table[0x48000 | index] = randomFactor * 0x9;
    this.LSFR15Table[0x50000 | index] = randomFactor * 0xa;
    this.LSFR15Table[0x58000 | index] = randomFactor * 0xb;
    this.LSFR15Table[0x60000 | index] = randomFactor * 0xc;
    this.LSFR15Table[0x68000 | index] = randomFactor * 0xd;
    this.LSFR15Table[0x70000 | index] = randomFactor * 0xe;
    this.LSFR15Table[0x78000 | index] = randomFactor * 0xf;
    //Recompute the LSFR algorithm:
    LSFRShifted = LSFR >> 1;
    LSFR = LSFRShifted | ((LSFRShifted ^ LSFR) & 0x1) << 14;
  }
  //7-bit LSFR Cache Generation:
  this.LSFR7Table = util.getTypedArray(0x800, 0, "int8");
  LSFR = 0x7f; //Seed value has all its bits set.
  for (index = 0; index < 0x80; ++index) {
    //Normalize the last LSFR value for usage:
    randomFactor = 1 - (LSFR & 1); //Docs say it's the inverse.
    //Cache the different volume level results:
    this.LSFR7Table[0x080 | index] = randomFactor;
    this.LSFR7Table[0x100 | index] = randomFactor * 0x2;
    this.LSFR7Table[0x180 | index] = randomFactor * 0x3;
    this.LSFR7Table[0x200 | index] = randomFactor * 0x4;
    this.LSFR7Table[0x280 | index] = randomFactor * 0x5;
    this.LSFR7Table[0x300 | index] = randomFactor * 0x6;
    this.LSFR7Table[0x380 | index] = randomFactor * 0x7;
    this.LSFR7Table[0x400 | index] = randomFactor * 0x8;
    this.LSFR7Table[0x480 | index] = randomFactor * 0x9;
    this.LSFR7Table[0x500 | index] = randomFactor * 0xa;
    this.LSFR7Table[0x580 | index] = randomFactor * 0xb;
    this.LSFR7Table[0x600 | index] = randomFactor * 0xc;
    this.LSFR7Table[0x680 | index] = randomFactor * 0xd;
    this.LSFR7Table[0x700 | index] = randomFactor * 0xe;
    this.LSFR7Table[0x780 | index] = randomFactor * 0xf;
    // Recompute the LSFR algorithm:
    LSFRShifted = LSFR >> 1;
    LSFR = LSFRShifted | ((LSFRShifted ^ LSFR) & 0x1) << 6;
  }
  // Set the default noise table:
  this.noiseSampleTable = this.LSFR15Table;
};
GameBoyCore.prototype.audioUnderrunAdjustment = function () {
  if (!settings.soundOn) return;
  let underrunAmount = this.audioServer.remainingBuffer();
  if (typeof underrunAmount === "number") {
    underrunAmount = this.bufferContainAmount - Math.max(underrunAmount, 0);
    if (underrunAmount > 0) {
      this.recalculateIterationClockLimitForAudio((underrunAmount >> 1) * this.audioResamplerFirstPassFactor);
    }
  }
};
GameBoyCore.prototype.initializeAudioStartState = function () {
  this.channel1FrequencyTracker = 0x2000;
  this.channel1DutyTracker = 0;
  this.channel1CachedDuty = dutyLookup[2];
  this.channel1totalLength = 0;
  this.channel1envelopeVolume = 0;
  this.channel1envelopeType = false;
  this.channel1envelopeSweeps = 0;
  this.channel1envelopeSweepsLast = 0;
  this.channel1consecutive = true;
  this.channel1frequency = 0;
  this.channel1SweepFault = false;
  this.channel1ShadowFrequency = 0;
  this.channel1timeSweep = 1;
  this.channel1lastTimeSweep = 0;
  this.channel1Swept = false;
  this.channel1frequencySweepDivider = 0;
  this.channel1decreaseSweep = false;
  this.channel2FrequencyTracker = 0x2000;
  this.channel2DutyTracker = 0;
  this.channel2CachedDuty = dutyLookup[2];
  this.channel2totalLength = 0;
  this.channel2envelopeVolume = 0;
  this.channel2envelopeType = false;
  this.channel2envelopeSweeps = 0;
  this.channel2envelopeSweepsLast = 0;
  this.channel2consecutive = true;
  this.channel2frequency = 0;
  this.channel3canPlay = false;
  this.channel3totalLength = 0;
  this.channel3patternType = 4;
  this.channel3frequency = 0;
  this.channel3consecutive = true;
  this.channel3Counter = 0x800;
  this.channel4FrequencyPeriod = 8;
  this.channel4totalLength = 0;
  this.channel4envelopeVolume = 0;
  this.channel4currentVolume = 0;
  this.channel4envelopeType = false;
  this.channel4envelopeSweeps = 0;
  this.channel4envelopeSweepsLast = 0;
  this.channel4consecutive = true;
  this.channel4BitRange = 0x7fff;
  this.noiseSampleTable = this.LSFR15Table;
  this.channel4VolumeShifter = 15;
  this.channel1FrequencyCounter = 0x2000;
  this.channel2FrequencyCounter = 0x2000;
  this.channel3Counter = 0x800;
  this.channel3FrequencyPeriod = 0x800;
  this.channel3lastSampleLookup = 0;
  this.channel4lastSampleLookup = 0;
  this.VinLeftChannelMasterVolume = 8;
  this.VinRightChannelMasterVolume = 8;
  this.mixerOutputCache = 0;
  this.sequencerClocks = 0x2000;
  this.sequencePosition = 0;
  this.channel4FrequencyPeriod = 8;
  this.channel4Counter = 8;
  this.cachedChannel3Sample = 0;
  this.cachedChannel4Sample = 0;
  this.channel1Enabled = false;
  this.channel2Enabled = false;
  this.channel3Enabled = false;
  this.channel4Enabled = false;
  this.channel1canPlay = false;
  this.channel2canPlay = false;
  this.channel4canPlay = false;
  this.audioClocksUntilNextEvent = 1;
  this.audioClocksUntilNextEventCounter = 1;
  this.channel1OutputLevelCache();
  this.channel2OutputLevelCache();
  this.channel3OutputLevelCache();
  this.channel4OutputLevelCache();
  this.noiseSampleTable = this.LSFR15Table;
};
GameBoyCore.prototype.outputAudio = function () {
  this.audioBuffer[this.audioDestinationPosition++] = (this.downsampleInput >>> 16) * this.downSampleInputDivider - 1;
  this.audioBuffer[this.audioDestinationPosition++] = (this.downsampleInput & 0xffff) * this.downSampleInputDivider - 1;
  if (this.audioDestinationPosition === this.numSamplesTotal) {
    this.audioServer.writeAudio(this.audioBuffer);
    this.audioDestinationPosition = 0;
  }
  this.downsampleInput = 0;
};
//Below are the audio generation functions timed against the CPU:
GameBoyCore.prototype.generateAudio = function (numSamples) {
  var multiplier = 0;
  if (this.soundMasterEnabled && !this.CPUStopped) {
    for (var clockUpTo = 0; numSamples > 0;) {
      clockUpTo = Math.min(this.audioClocksUntilNextEventCounter, this.sequencerClocks, numSamples);
      this.audioClocksUntilNextEventCounter -= clockUpTo;
      this.sequencerClocks -= clockUpTo;
      numSamples -= clockUpTo;
      while (clockUpTo > 0) {
        multiplier = Math.min(clockUpTo, this.audioResamplerFirstPassFactor - this.audioIndex);
        clockUpTo -= multiplier;
        this.audioIndex += multiplier;
        this.downsampleInput += this.mixerOutputCache * multiplier;
        if (this.audioIndex === this.audioResamplerFirstPassFactor) {
          this.audioIndex = 0;
          this.outputAudio();
        }
      }
      if (this.sequencerClocks === 0) {
        this.audioComputeSequencer();
        this.sequencerClocks = 0x2000;
      }
      if (this.audioClocksUntilNextEventCounter === 0) {
        this.computeAudioChannels();
      }
    }
  } else {
    //SILENT OUTPUT:
    while (numSamples > 0) {
      multiplier = Math.min(numSamples, this.audioResamplerFirstPassFactor - this.audioIndex);
      numSamples -= multiplier;
      this.audioIndex += multiplier;
      if (this.audioIndex === this.audioResamplerFirstPassFactor) {
        this.audioIndex = 0;
        this.outputAudio();
      }
    }
  }
};
//Generate audio, but don't actually output it (Used for when sound is disabled by user/browser):
GameBoyCore.prototype.generateAudioFake = function (numSamples) {
  if (this.soundMasterEnabled && !this.CPUStopped) {
    let clockUpTo = 0;
    while (numSamples > 0) {
      clockUpTo = Math.min(this.audioClocksUntilNextEventCounter, this.sequencerClocks, numSamples);
      this.audioClocksUntilNextEventCounter -= clockUpTo;
      this.sequencerClocks -= clockUpTo;
      numSamples -= clockUpTo;
      if (this.sequencerClocks === 0) {
        this.audioComputeSequencer();
        this.sequencerClocks = 0x2000;
      }
      if (this.audioClocksUntilNextEventCounter === 0) {
        this.computeAudioChannels();
      }
    }
  }
};
GameBoyCore.prototype.audioJIT = function () {
  // Audio Sample Generation Timing:
  if (settings.soundOn) {
    this.generateAudio(this.audioTicks);
  } else {
    this.generateAudioFake(this.audioTicks);
  }
  this.audioTicks = 0;
};
GameBoyCore.prototype.audioComputeSequencer = function () {
  switch (this.sequencePosition++) {
  case 0:
    this.clockAudioLength();
    break;
  case 2:
    this.clockAudioLength();
    this.clockAudioSweep();
    break;
  case 4:
    this.clockAudioLength();
    break;
  case 6:
    this.clockAudioLength();
    this.clockAudioSweep();
    break;
  case 7:
    this.clockAudioEnvelope();
    this.sequencePosition = 0;
  }
};
GameBoyCore.prototype.clockAudioLength = function () {
  //Channel 1:
  if (this.channel1totalLength > 1) {
    --this.channel1totalLength;
  } else if (this.channel1totalLength === 1) {
    this.channel1totalLength = 0;
    this.channel1EnableCheck();
    this.memory[0xff26] &= 0xfe; //Channel #1 On Flag Off
  }
  //Channel 2:
  if (this.channel2totalLength > 1) {
    --this.channel2totalLength;
  } else if (this.channel2totalLength === 1) {
    this.channel2totalLength = 0;
    this.channel2EnableCheck();
    this.memory[0xff26] &= 0xfd; //Channel #2 On Flag Off
  }
  //Channel 3:
  if (this.channel3totalLength > 1) {
    --this.channel3totalLength;
  } else if (this.channel3totalLength === 1) {
    this.channel3totalLength = 0;
    this.channel3EnableCheck();
    this.memory[0xff26] &= 0xfb; //Channel #3 On Flag Off
  }
  //Channel 4:
  if (this.channel4totalLength > 1) {
    --this.channel4totalLength;
  } else if (this.channel4totalLength === 1) {
    this.channel4totalLength = 0;
    this.channel4EnableCheck();
    this.memory[0xff26] &= 0xf7; //Channel #4 On Flag Off
  }
};
GameBoyCore.prototype.clockAudioSweep = function () {
  //Channel 1:
  if (!this.channel1SweepFault && this.channel1timeSweep > 0) {
    if (--this.channel1timeSweep === 0) {
      this.runAudioSweep();
    }
  }
};
GameBoyCore.prototype.runAudioSweep = function () {
  //Channel 1:
  if (this.channel1lastTimeSweep > 0) {
    if (this.channel1frequencySweepDivider > 0) {
      this.channel1Swept = true;
      if (this.channel1decreaseSweep) {
        this.channel1ShadowFrequency -= this.channel1ShadowFrequency >> this.channel1frequencySweepDivider;
        this.channel1frequency = this.channel1ShadowFrequency & 0x7ff;
        this.channel1FrequencyTracker = 0x800 - this.channel1frequency << 2;
      } else {
        this.channel1ShadowFrequency += this.channel1ShadowFrequency >> this.channel1frequencySweepDivider;
        this.channel1frequency = this.channel1ShadowFrequency;
        if (this.channel1ShadowFrequency <= 0x7ff) {
          this.channel1FrequencyTracker = 0x800 - this.channel1frequency << 2;
          //Run overflow check twice:
          if (this.channel1ShadowFrequency + (this.channel1ShadowFrequency >> this.channel1frequencySweepDivider) > 0x7ff) {
            this.channel1SweepFault = true;
            this.channel1EnableCheck();
            this.memory[0xff26] &= 0xfe; //Channel #1 On Flag Off
          }
        } else {
          this.channel1frequency &= 0x7ff;
          this.channel1SweepFault = true;
          this.channel1EnableCheck();
          this.memory[0xff26] &= 0xfe; //Channel #1 On Flag Off
        }
      }
      this.channel1timeSweep = this.channel1lastTimeSweep;
    } else {
      //Channel has sweep disabled and timer becomes a length counter:
      this.channel1SweepFault = true;
      this.channel1EnableCheck();
    }
  }
};
GameBoyCore.prototype.channel1AudioSweepPerformDummy = function () {
  //Channel 1:
  if (this.channel1frequencySweepDivider > 0) {
    if (!this.channel1decreaseSweep) {
      var channel1ShadowFrequency = this.channel1ShadowFrequency + (this.channel1ShadowFrequency >> this.channel1frequencySweepDivider);
      if (channel1ShadowFrequency <= 0x7ff) {
        //Run overflow check twice:
        if (channel1ShadowFrequency + (channel1ShadowFrequency >> this.channel1frequencySweepDivider) > 0x7ff) {
          this.channel1SweepFault = true;
          this.channel1EnableCheck();
          this.memory[0xff26] &= 0xfe; //Channel #1 On Flag Off
        }
      } else {
        this.channel1SweepFault = true;
        this.channel1EnableCheck();
        this.memory[0xff26] &= 0xfe; //Channel #1 On Flag Off
      }
    }
  }
};
GameBoyCore.prototype.clockAudioEnvelope = function () {
  //Channel 1:
  if (this.channel1envelopeSweepsLast > -1) {
    if (this.channel1envelopeSweeps > 0) {
      --this.channel1envelopeSweeps;
    } else {
      if (!this.channel1envelopeType) {
        if (this.channel1envelopeVolume > 0) {
          --this.channel1envelopeVolume;
          this.channel1envelopeSweeps = this.channel1envelopeSweepsLast;
          this.channel1OutputLevelCache();
        } else {
          this.channel1envelopeSweepsLast = -1;
        }
      } else if (this.channel1envelopeVolume < 0xf) {
        ++this.channel1envelopeVolume;
        this.channel1envelopeSweeps = this.channel1envelopeSweepsLast;
        this.channel1OutputLevelCache();
      } else {
        this.channel1envelopeSweepsLast = -1;
      }
    }
  }
  //Channel 2:
  if (this.channel2envelopeSweepsLast > -1) {
    if (this.channel2envelopeSweeps > 0) {
      --this.channel2envelopeSweeps;
    } else {
      if (!this.channel2envelopeType) {
        if (this.channel2envelopeVolume > 0) {
          --this.channel2envelopeVolume;
          this.channel2envelopeSweeps = this.channel2envelopeSweepsLast;
          this.channel2OutputLevelCache();
        } else {
          this.channel2envelopeSweepsLast = -1;
        }
      } else if (this.channel2envelopeVolume < 0xf) {
        ++this.channel2envelopeVolume;
        this.channel2envelopeSweeps = this.channel2envelopeSweepsLast;
        this.channel2OutputLevelCache();
      } else {
        this.channel2envelopeSweepsLast = -1;
      }
    }
  }
  //Channel 4:
  if (this.channel4envelopeSweepsLast > -1) {
    if (this.channel4envelopeSweeps > 0) {
      --this.channel4envelopeSweeps;
    } else {
      if (!this.channel4envelopeType) {
        if (this.channel4envelopeVolume > 0) {
          this.channel4currentVolume = --this.channel4envelopeVolume <<
            this.channel4VolumeShifter;
          this.channel4envelopeSweeps = this.channel4envelopeSweepsLast;
          this.channel4UpdateCache();
        } else {
          this.channel4envelopeSweepsLast = -1;
        }
      } else if (this.channel4envelopeVolume < 0xf) {
        this.channel4currentVolume = ++this.channel4envelopeVolume <<
          this.channel4VolumeShifter;
        this.channel4envelopeSweeps = this.channel4envelopeSweepsLast;
        this.channel4UpdateCache();
      } else {
        this.channel4envelopeSweepsLast = -1;
      }
    }
  }
};
GameBoyCore.prototype.computeAudioChannels = function () {
  //Clock down the four audio channels to the next closest audio event:
  this.channel1FrequencyCounter -= this.audioClocksUntilNextEvent;
  this.channel2FrequencyCounter -= this.audioClocksUntilNextEvent;
  this.channel3Counter -= this.audioClocksUntilNextEvent;
  this.channel4Counter -= this.audioClocksUntilNextEvent;
  //Channel 1 counter:
  if (this.channel1FrequencyCounter === 0) {
    this.channel1FrequencyCounter = this.channel1FrequencyTracker;
    this.channel1DutyTracker = this.channel1DutyTracker + 1 & 0x7;
    this.channel1OutputLevelTrimaryCache();
  }
  //Channel 2 counter:
  if (this.channel2FrequencyCounter === 0) {
    this.channel2FrequencyCounter = this.channel2FrequencyTracker;
    this.channel2DutyTracker = this.channel2DutyTracker + 1 & 0x7;
    this.channel2OutputLevelTrimaryCache();
  }
  //Channel 3 counter:
  if (this.channel3Counter === 0) {
    if (this.channel3canPlay) {
      this.channel3lastSampleLookup = this.channel3lastSampleLookup + 1 & 0x1f;
    }
    this.channel3Counter = this.channel3FrequencyPeriod;
    this.channel3UpdateCache();
  }
  //Channel 4 counter:
  if (this.channel4Counter === 0) {
    this.channel4lastSampleLookup = this.channel4lastSampleLookup + 1 &
      this.channel4BitRange;
    this.channel4Counter = this.channel4FrequencyPeriod;
    this.channel4UpdateCache();
  }
  //Find the number of clocks to next closest counter event:
  this.audioClocksUntilNextEventCounter = this.audioClocksUntilNextEvent = Math.min(
    this.channel1FrequencyCounter,
    this.channel2FrequencyCounter,
    this.channel3Counter,
    this.channel4Counter
  );
};
GameBoyCore.prototype.channel1EnableCheck = function () {
  this.channel1Enabled = (this.channel1consecutive ||
      this.channel1totalLength > 0) &&
    !this.channel1SweepFault &&
    this.channel1canPlay;
  this.channel1OutputLevelSecondaryCache();
};
GameBoyCore.prototype.channel1VolumeEnableCheck = function () {
  this.channel1canPlay = this.memory[0xff12] > 7;
  this.channel1EnableCheck();
  this.channel1OutputLevelSecondaryCache();
};
GameBoyCore.prototype.channel1OutputLevelCache = function () {
  this.channel1currentSampleLeft = this.leftChannel1 ?
    this.channel1envelopeVolume :
    0;
  this.channel1currentSampleRight = this.rightChannel1 ?
    this.channel1envelopeVolume :
    0;
  this.channel1OutputLevelSecondaryCache();
};
GameBoyCore.prototype.channel1OutputLevelSecondaryCache = function () {
  if (this.channel1Enabled) {
    this.channel1currentSampleLeftSecondary = this.channel1currentSampleLeft;
    this.channel1currentSampleRightSecondary = this.channel1currentSampleRight;
  } else {
    this.channel1currentSampleLeftSecondary = 0;
    this.channel1currentSampleRightSecondary = 0;
  }
  this.channel1OutputLevelTrimaryCache();
};
GameBoyCore.prototype.channel1OutputLevelTrimaryCache = function () {
  if (
    this.channel1CachedDuty[this.channel1DutyTracker] &&
    settings.enabledChannels[0]
  ) {
    this.channel1currentSampleLeftTrimary = this.channel1currentSampleLeftSecondary;
    this.channel1currentSampleRightTrimary = this.channel1currentSampleRightSecondary;
  } else {
    this.channel1currentSampleLeftTrimary = 0;
    this.channel1currentSampleRightTrimary = 0;
  }
  this.mixerOutputLevelCache();
};
GameBoyCore.prototype.channel2EnableCheck = function () {
  this.channel2Enabled = (this.channel2consecutive ||
      this.channel2totalLength > 0) &&
    this.channel2canPlay;
  this.channel2OutputLevelSecondaryCache();
};
GameBoyCore.prototype.channel2VolumeEnableCheck = function () {
  this.channel2canPlay = this.memory[0xff17] > 7;
  this.channel2EnableCheck();
  this.channel2OutputLevelSecondaryCache();
};
GameBoyCore.prototype.channel2OutputLevelCache = function () {
  this.channel2currentSampleLeft = this.leftChannel2 ?
    this.channel2envelopeVolume :
    0;
  this.channel2currentSampleRight = this.rightChannel2 ?
    this.channel2envelopeVolume :
    0;
  this.channel2OutputLevelSecondaryCache();
};
GameBoyCore.prototype.channel2OutputLevelSecondaryCache = function () {
  if (this.channel2Enabled) {
    this.channel2currentSampleLeftSecondary = this.channel2currentSampleLeft;
    this.channel2currentSampleRightSecondary = this.channel2currentSampleRight;
  } else {
    this.channel2currentSampleLeftSecondary = 0;
    this.channel2currentSampleRightSecondary = 0;
  }
  this.channel2OutputLevelTrimaryCache();
};
GameBoyCore.prototype.channel2OutputLevelTrimaryCache = function () {
  if (
    this.channel2CachedDuty[this.channel2DutyTracker] &&
    settings.enabledChannels[1]
  ) {
    this.channel2currentSampleLeftTrimary = this.channel2currentSampleLeftSecondary;
    this.channel2currentSampleRightTrimary = this.channel2currentSampleRightSecondary;
  } else {
    this.channel2currentSampleLeftTrimary = 0;
    this.channel2currentSampleRightTrimary = 0;
  }
  this.mixerOutputLevelCache();
};
GameBoyCore.prototype.channel3EnableCheck = function () {
  this.channel3Enabled /*this.channel3canPlay && */ = this.channel3consecutive ||
    this.channel3totalLength > 0;
  this.channel3OutputLevelSecondaryCache();
};
GameBoyCore.prototype.channel3OutputLevelCache = function () {
  this.channel3currentSampleLeft = this.leftChannel3 ?
    this.cachedChannel3Sample :
    0;
  this.channel3currentSampleRight = this.rightChannel3 ?
    this.cachedChannel3Sample :
    0;
  this.channel3OutputLevelSecondaryCache();
};
GameBoyCore.prototype.channel3OutputLevelSecondaryCache = function () {
  if (this.channel3Enabled && settings.enabledChannels[2]) {
    this.channel3currentSampleLeftSecondary = this.channel3currentSampleLeft;
    this.channel3currentSampleRightSecondary = this.channel3currentSampleRight;
  } else {
    this.channel3currentSampleLeftSecondary = 0;
    this.channel3currentSampleRightSecondary = 0;
  }
  this.mixerOutputLevelCache();
};
GameBoyCore.prototype.channel4EnableCheck = function () {
  this.channel4Enabled = (this.channel4consecutive ||
      this.channel4totalLength > 0) &&
    this.channel4canPlay;
  this.channel4OutputLevelSecondaryCache();
};
GameBoyCore.prototype.channel4VolumeEnableCheck = function () {
  this.channel4canPlay = this.memory[0xff21] > 7;
  this.channel4EnableCheck();
  this.channel4OutputLevelSecondaryCache();
};
GameBoyCore.prototype.channel4OutputLevelCache = function () {
  this.channel4currentSampleLeft = this.leftChannel4 ?
    this.cachedChannel4Sample :
    0;
  this.channel4currentSampleRight = this.rightChannel4 ?
    this.cachedChannel4Sample :
    0;
  this.channel4OutputLevelSecondaryCache();
};
GameBoyCore.prototype.channel4OutputLevelSecondaryCache = function () {
  if (this.channel4Enabled && settings.enabledChannels[3]) {
    this.channel4currentSampleLeftSecondary = this.channel4currentSampleLeft;
    this.channel4currentSampleRightSecondary = this.channel4currentSampleRight;
  } else {
    this.channel4currentSampleLeftSecondary = 0;
    this.channel4currentSampleRightSecondary = 0;
  }
  this.mixerOutputLevelCache();
};
GameBoyCore.prototype.mixerOutputLevelCache = function () {
  this.mixerOutputCache = (this.channel1currentSampleLeftTrimary +
      this.channel2currentSampleLeftTrimary +
      this.channel3currentSampleLeftSecondary +
      this.channel4currentSampleLeftSecondary) *
    this.VinLeftChannelMasterVolume <<
    16 |
    (this.channel1currentSampleRightTrimary +
      this.channel2currentSampleRightTrimary +
      this.channel3currentSampleRightSecondary +
      this.channel4currentSampleRightSecondary) *
    this.VinRightChannelMasterVolume;
};
GameBoyCore.prototype.channel3UpdateCache = function () {
  this.cachedChannel3Sample = this.channel3PCM[this.channel3lastSampleLookup] >>
    this.channel3patternType;
  this.channel3OutputLevelCache();
};
GameBoyCore.prototype.channel3WriteRAM = function (address, data) {
  if (this.channel3canPlay) {
    this.audioJIT();
    //address = this.channel3lastSampleLookup >> 1;
  }
  this.memory[0xff30 | address] = data;
  address <<= 1;
  this.channel3PCM[address] = data >> 4;
  this.channel3PCM[address | 1] = data & 0xf;
};
GameBoyCore.prototype.channel4UpdateCache = function () {
  this.cachedChannel4Sample = this.noiseSampleTable[
    this.channel4currentVolume | this.channel4lastSampleLookup
  ];
  this.channel4OutputLevelCache();
};
GameBoyCore.prototype.run = function () {
  //The preprocessing before the actual iteration loop:
  if ((this.stopEmulator & 2) === 0) {
    if ((this.stopEmulator & 1) === 1) {
      if (!this.CPUStopped) {
        this.stopEmulator = 0;

        this.audioUnderrunAdjustment();

        if (this.cartridgeSlot.cartridge.hasRTC) {
          this.cartridgeSlot.cartridge.mbc.rtc.updateClock();
        }

        if (!this.halt) {
          this.executeIteration();
        } else {
          // Finish the HALT rundown execution.
          this.CPUTicks = 0;
          this.calculateHALTPeriod();

          if (!this.halt) {
            this.executeIteration();
          } else {
            this.updateCore();
            this.iterationEndRoutine();
          }
        }
        // Request the graphics target to be updated:
        this.lcd.requestDraw();
      } else {
        this.audioUnderrunAdjustment();
        this.audioTicks += this.cpu.cyclesTotal;
        this.audioJIT();
        this.stopEmulator |= 1; // End current loop.
      }
    } else {
      // We can only get here if there was an internal error, but the loop was restarted.
      console.log("Iterator restarted a faulted core.", 2);
      pause();
    }
  }
};
GameBoyCore.prototype.executeIteration = function () {
  //Iterate the interpreter loop:
  var operationCode = 0;
  var timedTicks = 0;
  while (this.stopEmulator === 0) {
    //Interrupt Arming:
    switch (this.IRQEnableDelay) {
    case 1:
      this.IME = true;
      this.checkIRQMatching();
    case 2:
      --this.IRQEnableDelay;
    }
    //Is an IRQ set to fire?:
    if (this.IRQLineMatched > 0) {
      //IME is true and and interrupt was matched:
      this.launchIRQ();
    }
    //Fetch the current opcode:
    operationCode = this.memoryReader[this.programCounter].apply(this, [
      this.programCounter
    ]);
    //Increment the program counter to the next instruction:
    this.programCounter = this.programCounter + 1 & 0xffff;
    //Check for the program counter quirk:
    if (this.skipPCIncrement) {
      this.programCounter = this.programCounter - 1 & 0xffff;
      this.skipPCIncrement = false;
    }
    //Get how many CPU cycles the current instruction counts for:
    this.CPUTicks = TickTable[operationCode];

    //Execute the current instruction:
    mainInstructions[operationCode].apply(this);

    //Update the state (Inlined updateCoreFull manually here):
    //Update the clocking for the LCD emulation:
    this.LCDTicks += this.CPUTicks >> this.doubleSpeedShifter; //LCD Timing
    this.LCDCONTROL[this.actualScanLine](this); //Scan Line and STAT Mode Control

    //Single-speed relative timing for A/V emulation:
    timedTicks = this.CPUTicks >> this.doubleSpeedShifter; //CPU clocking can be updated from the LCD handling.
    this.audioTicks += timedTicks; //Audio Timing
    this.cpu.ticks += timedTicks; //Emulator Timing
    //CPU Timers:
    this.DIVTicks += this.CPUTicks; //DIV Timing
    if (this.TIMAEnabled) {
      //TIMA Timing
      this.timerTicks += this.CPUTicks;
      while (this.timerTicks >= this.TACClocker) {
        this.timerTicks -= this.TACClocker;
        if (++this.memory[0xff05] === 0x100) {
          this.memory[0xff05] = this.memory[0xff06];
          this.interruptsRequested |= 0x4;
          this.checkIRQMatching();
        }
      }
    }
    if (this.serialTimer > 0) {
      //Serial Timing
      //IRQ Counter:
      this.serialTimer -= this.CPUTicks;
      if (this.serialTimer <= 0) {
        this.interruptsRequested |= 0x8;
        this.checkIRQMatching();
      }
      //Bit Shit Counter:
      this.serialShiftTimer -= this.CPUTicks;
      if (this.serialShiftTimer <= 0) {
        this.serialShiftTimer = this.serialShiftTimerAllocated;
        this.memory[0xff01] = this.memory[0xff01] << 1 & 0xfe | 0x01; //We could shift in actual link data here if we were to implement such!!!
      }
    }
    //End of iteration routine:
    if (this.cpu.ticks >= this.cpu.cyclesTotal) {
      this.iterationEndRoutine();
    }
  }
};
GameBoyCore.prototype.iterationEndRoutine = function () {
  if ((this.stopEmulator & 0x1) === 0) {
    this.audioJIT(); //Make sure we at least output once per iteration.
    //Update DIV Alignment (Integer overflow safety):
    this.memory[0xff04] = this.memory[0xff04] + (this.DIVTicks >> 8) & 0xff;
    this.DIVTicks &= 0xff;
    //Update emulator flags:
    this.stopEmulator |= 1; //End current loop.
    this.cpu.ticks -= this.cpu.cyclesTotal;
    this.cpu.cyclesTotalCurrent += this.cpu.cyclesTotalRoundoff;
    this.recalculateIterationClockLimit();
  }
};
GameBoyCore.prototype.handleSTOP = function () {
  this.CPUStopped = true; //Stop CPU until joypad input changes.
  this.iterationEndRoutine();
  if (this.cpu.ticks < 0) {
    this.audioTicks -= this.cpu.ticks;
    this.audioJIT();
  }
};
GameBoyCore.prototype.recalculateIterationClockLimit = function () {
  const endModulus = this.cpu.cyclesTotalCurrent % 4;
  this.cpu.cyclesTotal = this.cpu.cyclesTotalBase + this.cpu.cyclesTotalCurrent - endModulus;
  this.cpu.cyclesTotalCurrent = endModulus;
};
GameBoyCore.prototype.recalculateIterationClockLimitForAudio = function (audioClocking) {
  this.cpu.cyclesTotal += Math.min(audioClocking >> 2 << 2, this.cpu.cyclesTotalBase << 1);
};
GameBoyCore.prototype.scanLineMode2 = function () {
  //OAM Search Period
  if (this.STATTracker !== 1) {
    if (this.mode2TriggerSTAT) {
      this.interruptsRequested |= 0x2;
      this.checkIRQMatching();
    }
    this.STATTracker = 1;
    this.modeSTAT = 2;
  }
};
GameBoyCore.prototype.scanLineMode3 = function () {
  //Scan Line Drawing Period
  if (this.modeSTAT !== 3) {
    if (this.STATTracker === 0 && this.mode2TriggerSTAT) {
      this.interruptsRequested |= 0x2;
      this.checkIRQMatching();
    }
    this.STATTracker = 1;
    this.modeSTAT = 3;
  }
};
GameBoyCore.prototype.scanLineMode0 = function () {
  //Horizontal Blanking Period
  if (this.modeSTAT != 0) {
    if (this.STATTracker != 2) {
      if (this.STATTracker === 0) {
        if (this.mode2TriggerSTAT) {
          this.interruptsRequested |= 0x2;
          this.checkIRQMatching();
        }
        this.modeSTAT = 3;
      }
      this.incrementScanLineQueue();
      this.updateSpriteCount(this.actualScanLine);
      this.STATTracker = 2;
    }
    if (this.LCDTicks >= this.spriteCount) {
      if (this.hdmaRunning) {
        this.executeHDMA();
      }
      if (this.mode0TriggerSTAT) {
        this.interruptsRequested |= 0x2;
        this.checkIRQMatching();
      }
      this.STATTracker = 3;
      this.modeSTAT = 0;
    }
  }
};
GameBoyCore.prototype.clocksUntilLYCMatch = function () {
  if (this.memory[0xff45] != 0) {
    if (this.memory[0xff45] > this.actualScanLine) {
      return 456 * (this.memory[0xff45] - this.actualScanLine);
    }
    return 456 * (154 - this.actualScanLine + this.memory[0xff45]);
  }
  return 456 *
    (this.actualScanLine === 153 && this.memory[0xff44] === 0 ?
      154 :
      153 - this.actualScanLine) +
    8;
};
GameBoyCore.prototype.clocksUntilMode0 = function () {
  switch (this.modeSTAT) {
  case 0:
    if (this.actualScanLine === 143) {
      this.updateSpriteCount(0);
      return this.spriteCount + 5016;
    }
    this.updateSpriteCount(this.actualScanLine + 1);
    return this.spriteCount + 456;
  case 2:
  case 3:
    this.updateSpriteCount(this.actualScanLine);
    return this.spriteCount;
  case 1:
    this.updateSpriteCount(0);
    return this.spriteCount + 456 * (154 - this.actualScanLine);
  }
};
GameBoyCore.prototype.updateSpriteCount = function (line) {
  this.spriteCount = 252;
  if (this.cartridgeSlot.cartridge.useGBCMode && this.gfxSpriteShow) {
    //Is the window enabled and are we in CGB mode?
    var lineAdjusted = line + 0x10;
    var yoffset = 0;
    var yCap = this.gfxSpriteNormalHeight ? 0x8 : 0x10;
    for (
      var OAMAddress = 0xfe00; OAMAddress < 0xfea0 && this.spriteCount < 312; OAMAddress += 4
    ) {
      yoffset = lineAdjusted - this.memory[OAMAddress];
      if (yoffset > -1 && yoffset < yCap) {
        this.spriteCount += 6;
      }
    }
  }
};
GameBoyCore.prototype.matchLYC = function () {
  //LYC Register Compare
  if (this.memory[0xff44] === this.memory[0xff45]) {
    this.memory[0xff41] |= 0x04;
    if (this.LYCMatchTriggerSTAT) {
      this.interruptsRequested |= 0x2;
      this.checkIRQMatching();
    }
  } else {
    this.memory[0xff41] &= 0x7b;
  }
};
GameBoyCore.prototype.updateCore = function () {
  //Update the clocking for the LCD emulation:
  this.LCDTicks += this.CPUTicks >> this.doubleSpeedShifter; // LCD Timing
  this.LCDCONTROL[this.actualScanLine](this); //Scan Line and STAT Mode Control
  //Single-speed relative timing for A/V emulation:
  var timedTicks = this.CPUTicks >> this.doubleSpeedShifter; // CPU clocking can be updated from the LCD handling.
  this.audioTicks += timedTicks; // Audio Timing
  this.cpu.ticks += timedTicks; // CPU Timing
  //CPU Timers:
  this.DIVTicks += this.CPUTicks; // DIV Timing
  if (this.TIMAEnabled) {
    //TIMA Timing
    this.timerTicks += this.CPUTicks;
    while (this.timerTicks >= this.TACClocker) {
      this.timerTicks -= this.TACClocker;
      if (++this.memory[0xff05] === 0x100) {
        this.memory[0xff05] = this.memory[0xff06];
        this.interruptsRequested |= 0x4;
        this.checkIRQMatching();
      }
    }
  }
  if (this.serialTimer > 0) {
    //Serial Timing
    //IRQ Counter:
    this.serialTimer -= this.CPUTicks;
    if (this.serialTimer <= 0) {
      this.interruptsRequested |= 0x8;
      this.checkIRQMatching();
    }
    //Bit Shit Counter:
    this.serialShiftTimer -= this.CPUTicks;
    if (this.serialShiftTimer <= 0) {
      this.serialShiftTimer = this.serialShiftTimerAllocated;
      this.memory[0xff01] = this.memory[0xff01] << 1 & 0xfe | 0x01; //We could shift in actual link data here if we were to implement such!!!
    }
  }
};
GameBoyCore.prototype.updateCoreFull = function () {
  //Update the state machine:
  this.updateCore();
  //End of iteration routine:
  if (this.cpu.ticks >= this.cpu.cyclesTotal) {
    this.iterationEndRoutine();
  }
};
GameBoyCore.prototype.initializeLCDController = function () {
  //Display on hanlding:
  var line = 0;
  while (line < 154) {
    if (line < 143) {
      //We're on a normal scan line:
      this.LINECONTROL[line] = () => {
        if (this.LCDTicks < 80) {
          this.scanLineMode2();
        } else if (this.LCDTicks < 252) {
          this.scanLineMode3();
        } else if (this.LCDTicks < 456) {
          this.scanLineMode0();
        } else {
          //We're on a new scan line:
          this.LCDTicks -= 456;
          if (this.STATTracker != 3) {
            //Make sure the mode 0 handler was run at least once per scan line:
            if (this.STATTracker != 2) {
              if (this.STATTracker === 0 && this.mode2TriggerSTAT) {
                this.interruptsRequested |= 0x2;
              }
              this.incrementScanLineQueue();
            }
            if (this.hdmaRunning) {
              this.executeHDMA();
            }
            if (this.mode0TriggerSTAT) {
              this.interruptsRequested |= 0x2;
            }
          }

          //Update the scanline registers and assert the LYC counter:
          this.actualScanLine = ++this.memory[0xff44];

          //Perform a LYC counter assert:
          if (this.actualScanLine === this.memory[0xff45]) {
            this.memory[0xff41] |= 0x04;
            if (this.LYCMatchTriggerSTAT) {
              this.interruptsRequested |= 0x2;
            }
          } else {
            this.memory[0xff41] &= 0x7b;
          }
          this.checkIRQMatching();
          //Reset our mode contingency variables:
          this.STATTracker = 0;
          this.modeSTAT = 2;
          this.LINECONTROL[this.actualScanLine].apply(this); //Scan Line and STAT Mode Control.
        }
      };
    } else if (line === 143) {
      //We're on the last visible scan line of the LCD screen:
      this.LINECONTROL[143] = () => {
        if (this.LCDTicks < 80) {
          this.scanLineMode2();
        } else if (this.LCDTicks < 252) {
          this.scanLineMode3();
        } else if (this.LCDTicks < 456) {
          this.scanLineMode0();
        } else {
          //Starting V-Blank:
          //Just finished the last visible scan line:
          this.LCDTicks -= 456;
          if (this.STATTracker != 3) {
            //Make sure the mode 0 handler was run at least once per scan line:
            if (this.STATTracker != 2) {
              if (this.STATTracker === 0 && this.mode2TriggerSTAT) {
                this.interruptsRequested |= 0x2;
              }
              this.incrementScanLineQueue();
            }
            if (this.hdmaRunning) {
              this.executeHDMA();
            }
            if (this.mode0TriggerSTAT) {
              this.interruptsRequested |= 0x2;
            }
          }
          //Update the scanline registers and assert the LYC counter:
          this.actualScanLine = this.memory[0xff44] = 144;
          //Perform a LYC counter assert:
          if (this.memory[0xff45] === 144) {
            this.memory[0xff41] |= 0x04;
            if (this.LYCMatchTriggerSTAT) {
              this.interruptsRequested |= 0x2;
            }
          } else {
            this.memory[0xff41] &= 0x7b;
          }
          //Reset our mode contingency variables:
          this.STATTracker = 0;
          //Update our state for v-blank:
          this.modeSTAT = 1;
          this.interruptsRequested |= this.mode1TriggerSTAT ? 0x3 : 0x1;
          this.checkIRQMatching();
          //Attempt to blit out to our canvas:
          if (this.drewBlank === 0) {
            //Ensure JIT framing alignment:
            if (this.cpu.totalLinesPassed < 144 || this.cpu.totalLinesPassed === 144 && this.midScanlineOffset > -1) {
              //Make sure our gfx are up-to-date:
              this.graphicsJITVBlank();
              //Draw the frame:
              this.lcd.prepareFrame();
            }
          } else {
            //LCD off takes at least 2 frames:
            --this.drewBlank;
          }
          this.LINECONTROL[144].apply(this); //Scan Line and STAT Mode Control.
        }
      };
    } else if (line < 153) {
      //In VBlank
      this.LINECONTROL[line] = () => {
        if (this.LCDTicks >= 456) {
          //We're on a new scan line:
          this.LCDTicks -= 456;
          this.actualScanLine = ++this.memory[0xff44];
          //Perform a LYC counter assert:
          if (this.actualScanLine === this.memory[0xff45]) {
            this.memory[0xff41] |= 0x04;
            if (this.LYCMatchTriggerSTAT) {
              this.interruptsRequested |= 0x2;
              this.checkIRQMatching();
            }
          } else {
            this.memory[0xff41] &= 0x7b;
          }
          this.LINECONTROL[this.actualScanLine].apply(this); //Scan Line and STAT Mode Control.
        }
      };
    } else {
      //VBlank Ending (We're on the last actual scan line)
      this.LINECONTROL[153] = () => {
        if (this.LCDTicks >= 8) {
          if (this.STATTracker != 4 && this.memory[0xff44] === 153) {
            this.memory[0xff44] = 0; //LY register resets to 0 early.
            //Perform a LYC counter assert:
            if (this.memory[0xff45] === 0) {
              this.memory[0xff41] |= 0x04;
              if (this.LYCMatchTriggerSTAT) {
                this.interruptsRequested |= 0x2;
                this.checkIRQMatching();
              }
            } else {
              this.memory[0xff41] &= 0x7b;
            }
            this.STATTracker = 4;
          }
          if (this.LCDTicks >= 456) {
            //We reset back to the beginning:
            this.LCDTicks -= 456;
            this.STATTracker = this.actualScanLine = 0;
            this.LINECONTROL[0].apply(this); //Scan Line and STAT Mode Control.
          }
        }
      };
    }
    ++line;
  }
};
GameBoyCore.prototype.executeHDMA = function () {
  this.DMAWrite(1);
  if (this.halt) {
    if (
      this.LCDTicks - this.spriteCount < (4 >> this.doubleSpeedShifter | 0x20)
    ) {
      //HALT clocking correction:
      this.CPUTicks = 4 + (0x20 + this.spriteCount << this.doubleSpeedShifter);
      this.LCDTicks = this.spriteCount + (4 >> this.doubleSpeedShifter | 0x20);
    }
  } else {
    this.LCDTicks += 4 >> this.doubleSpeedShifter | 0x20; //LCD Timing Update For HDMA.
  }
  if (this.memory[0xff55] === 0) {
    this.hdmaRunning = false;
    this.memory[0xff55] = 0xff; //Transfer completed ("Hidden last step," since some ROMs don't imply this, but most do).
  } else {
    --this.memory[0xff55];
  }
};
GameBoyCore.prototype.updateClock = function () {
  return this.cartridgeSlot.cartridge.updateClock();
};
GameBoyCore.prototype.renderScanLine = function (scanlineToRender) {
  this.pixelStart = scanlineToRender * 160;
  if (this.bgEnabled) {
    this.pixelEnd = 160;
    this.BGLayerRender(scanlineToRender);
    this.WindowLayerRender(scanlineToRender);
  } else {
    var pixelLine = (scanlineToRender + 1) * 160;
    var defaultColor = this.cartridgeSlot.cartridge.useGBCMode ||
      this.colorizedGBPalettes ?
      0xf8f8f8 :
      0xefffde;
    for (
      var pixelPosition = scanlineToRender * 160 + this.currentX; pixelPosition < pixelLine; pixelPosition++
    ) {
      this.frameBuffer[pixelPosition] = defaultColor;
    }
  }
  this.SpriteLayerRender(scanlineToRender);
  this.currentX = 0;
  this.midScanlineOffset = -1;
};
GameBoyCore.prototype.renderMidScanLine = function () {
  if (this.actualScanLine < 144 && this.modeSTAT === 3) {
    //TODO: Get this accurate:
    if (this.midScanlineOffset === -1) {
      this.midScanlineOffset = this.backgroundX & 0x7;
    }
    if (this.LCDTicks >= 82) {
      this.pixelEnd = this.LCDTicks - 74;
      this.pixelEnd = Math.min(
        this.pixelEnd - this.midScanlineOffset - this.pixelEnd % 0x8,
        160
      );

      if (this.bgEnabled) {
        this.pixelStart = this.lastUnrenderedLine * 160;
        this.BGLayerRender(this.lastUnrenderedLine);
        this.WindowLayerRender(this.lastUnrenderedLine);
        //TODO: Do midscanline JIT for sprites...
      } else {
        var pixelLine = this.lastUnrenderedLine * 160 + this.pixelEnd;
        var defaultColor = this.cartridgeSlot.cartridge.useGBCMode ||
          this.colorizedGBPalettes ?
          0xf8f8f8 :
          0xefffde;
        for (
          var pixelPosition = this.lastUnrenderedLine * 160 + this.currentX; pixelPosition < pixelLine; pixelPosition++
        ) {
          this.frameBuffer[pixelPosition] = defaultColor;
        }
      }
      this.currentX = this.pixelEnd;
    }
  }
};
GameBoyCore.prototype.initializeModeSpecificArrays = function () {
  this.LCDCONTROL = this.LCDisOn ? this.LINECONTROL : this.DISPLAYOFFCONTROL;
  if (this.cartridgeSlot.cartridge.useGBCMode) {
    this.gbcOBJRawPalette = util.getTypedArray(0x40, 0, "uint8");
    this.gbcBGRawPalette = util.getTypedArray(0x40, 0, "uint8");
    this.gbcOBJPalette = util.getTypedArray(0x20, 0x1000000, "int32");
    this.gbcBGPalette = util.getTypedArray(0x40, 0, "int32");
    this.BGCHRBank2 = util.getTypedArray(0x800, 0, "uint8");
    this.BGCHRCurrentBank = this.currVRAMBank > 0 ?
      this.BGCHRBank2 :
      this.BGCHRBank1;
    this.tileCache = this.generateCacheArray(0xf80);
  } else {
    this.gbOBJPalette = util.getTypedArray(8, 0, "int32");
    this.gbBGPalette = util.getTypedArray(4, 0, "int32");
    this.BGPalette = this.gbBGPalette;
    this.OBJPalette = this.gbOBJPalette;
    this.tileCache = this.generateCacheArray(0x700);
    this.sortBuffer = util.getTypedArray(0x100, 0, "uint8");
    this.OAMAddressCache = util.getTypedArray(10, 0, "int32");
  }
  this.renderPathBuild();
};
GameBoyCore.prototype.adjustGBCtoGBMode = function () {
  console.log("Stepping down from GBC mode.");
  this.VRAM = this.GBCMemory = this.BGCHRCurrentBank = this.BGCHRBank2 = null;
  this.tileCache.length = 0x700;
  if (settings.colorizeGBMode) {
    this.gbBGColorizedPalette = util.getTypedArray(4, 0, "int32");
    this.gbOBJColorizedPalette = util.getTypedArray(8, 0, "int32");
    this.cachedBGPaletteConversion = util.getTypedArray(4, 0, "int32");
    this.cachedOBJPaletteConversion = util.getTypedArray(8, 0, "int32");
    this.BGPalette = this.gbBGColorizedPalette;
    this.OBJPalette = this.gbOBJColorizedPalette;
    this.gbOBJPalette = this.gbBGPalette = null;
    this.getGBCColor();
  } else {
    this.gbOBJPalette = util.getTypedArray(8, 0, "int32");
    this.gbBGPalette = util.getTypedArray(4, 0, "int32");
    this.BGPalette = this.gbBGPalette;
    this.OBJPalette = this.gbOBJPalette;
  }
  this.sortBuffer = util.getTypedArray(0x100, 0, "uint8");
  this.OAMAddressCache = util.getTypedArray(10, 0, "int32");
  this.renderPathBuild();
  this.memoryReadJumpCompile();
  this.memoryWriteJumpCompile();
};
GameBoyCore.prototype.renderPathBuild = function () {
  if (!this.cartridgeSlot.cartridge.useGBCMode) {
    this.BGLayerRender = this.BGGBLayerRender;
    this.WindowLayerRender = this.WindowGBLayerRender;
    this.SpriteLayerRender = this.SpriteGBLayerRender;
  } else {
    this.priorityFlaggingPathRebuild();
    this.SpriteLayerRender = this.SpriteGBCLayerRender;
  }
};
GameBoyCore.prototype.priorityFlaggingPathRebuild = function () {
  if (this.BGPriorityEnabled) {
    this.BGLayerRender = this.BGGBCLayerRender;
    this.WindowLayerRender = this.WindowGBCLayerRender;
  } else {
    this.BGLayerRender = this.BGGBCLayerRenderNoPriorityFlagging;
    this.WindowLayerRender = this.WindowGBCLayerRenderNoPriorityFlagging;
  }
};
GameBoyCore.prototype.initializeReferencesFromSaveState = function () {
  this.LCDCONTROL = this.LCDisOn ? this.LINECONTROL : this.DISPLAYOFFCONTROL;
  var tileIndex = 0;
  if (!this.cartridgeSlot.cartridge.useGBCMode) {
    if (this.colorizedGBPalettes) {
      this.BGPalette = this.gbBGColorizedPalette;
      this.OBJPalette = this.gbOBJColorizedPalette;
      this.updateGBBGPalette = this.updateGBColorizedBGPalette;
      this.updateGBOBJPalette = this.updateGBColorizedOBJPalette;
    } else {
      this.BGPalette = this.gbBGPalette;
      this.OBJPalette = this.gbOBJPalette;
    }
    this.tileCache = this.generateCacheArray(0x700);
    for (tileIndex = 0x8000; tileIndex < 0x9000; tileIndex += 2) {
      this.generateGBOAMTileLine(tileIndex);
    }
    for (tileIndex = 0x9000; tileIndex < 0x9800; tileIndex += 2) {
      this.generateGBTileLine(tileIndex);
    }
    this.sortBuffer = util.getTypedArray(0x100, 0, "uint8");
    this.OAMAddressCache = util.getTypedArray(10, 0, "int32");
  } else {
    this.BGCHRCurrentBank = this.currVRAMBank > 0 ?
      this.BGCHRBank2 :
      this.BGCHRBank1;
    this.tileCache = this.generateCacheArray(0xf80);
    for (; tileIndex < 0x1800; tileIndex += 0x10) {
      this.generateGBCTileBank1(tileIndex);
      this.generateGBCTileBank2(tileIndex);
    }
  }
  this.renderPathBuild();
};
GameBoyCore.prototype.adjustRGBTint = function (value) {
  //Adjustment for the GBC's tinting (According to Gambatte):
  const r = value & 0x1f;
  const g = value >> 5 & 0x1f;
  const b = value >> 10 & 0x1f;
  return r * 13 + g * 2 + b >> 1 << 16 | g * 3 + b << 9 | r * 3 + g * 2 + b * 11 >> 1;
};
GameBoyCore.prototype.getGBCColor = function () {
  //GBC Colorization of DMG ROMs:
  //BG
  for (let counter = 0; counter < 4; counter++) {
    const adjustedIndex = counter << 1;
    //BG
    this.cachedBGPaletteConversion[counter] = this.adjustRGBTint(this.gbcBGRawPalette[adjustedIndex | 1] << 8 | this.gbcBGRawPalette[adjustedIndex]);
    //OBJ 1
    this.cachedOBJPaletteConversion[counter] = this.adjustRGBTint(this.gbcOBJRawPalette[adjustedIndex | 1] << 8 | this.gbcOBJRawPalette[adjustedIndex]);
  }

  //OBJ 2
  for (let counter = 4; counter < 8; counter++) {
    const adjustedIndex = counter << 1;
    this.cachedOBJPaletteConversion[counter] = this.adjustRGBTint(this.gbcOBJRawPalette[adjustedIndex | 1] << 8 | this.gbcOBJRawPalette[adjustedIndex]);
  }

  //Update the palette entries:
  this.updateGBBGPalette = this.updateGBColorizedBGPalette;
  this.updateGBOBJPalette = this.updateGBColorizedOBJPalette;
  this.updateGBBGPalette(this.memory[0xff47]);
  this.updateGBOBJPalette(0, this.memory[0xff48]);
  this.updateGBOBJPalette(1, this.memory[0xff49]);
  this.colorizedGBPalettes = true;
};
GameBoyCore.prototype.updateGBRegularBGPalette = function (data) {
  this.gbBGPalette[0] = this.colors[data & 0x03] | 0x2000000;
  this.gbBGPalette[1] = this.colors[data >> 2 & 0x03];
  this.gbBGPalette[2] = this.colors[data >> 4 & 0x03];
  this.gbBGPalette[3] = this.colors[data >> 6];
};
GameBoyCore.prototype.updateGBColorizedBGPalette = function (data) {
  //GB colorization:
  this.gbBGColorizedPalette[0] = this.cachedBGPaletteConversion[data & 0x03] | 0x2000000;
  this.gbBGColorizedPalette[1] = this.cachedBGPaletteConversion[data >> 2 & 0x03];
  this.gbBGColorizedPalette[2] = this.cachedBGPaletteConversion[data >> 4 & 0x03];
  this.gbBGColorizedPalette[3] = this.cachedBGPaletteConversion[data >> 6];
};
GameBoyCore.prototype.updateGBRegularOBJPalette = function (index, data) {
  this.gbOBJPalette[index | 1] = this.colors[data >> 2 & 0x03];
  this.gbOBJPalette[index | 2] = this.colors[data >> 4 & 0x03];
  this.gbOBJPalette[index | 3] = this.colors[data >> 6];
};
GameBoyCore.prototype.updateGBColorizedOBJPalette = function (index, data) {
  //GB colorization:
  this.gbOBJColorizedPalette[index | 1] = this.cachedOBJPaletteConversion[
    index | data >> 2 & 0x03
  ];
  this.gbOBJColorizedPalette[index | 2] = this.cachedOBJPaletteConversion[
    index | data >> 4 & 0x03
  ];
  this.gbOBJColorizedPalette[index | 3] = this.cachedOBJPaletteConversion[
    index | data >> 6
  ];
};
GameBoyCore.prototype.updateGBCBGPalette = function (index, data) {
  if (this.gbcBGRawPalette[index] != data) {
    this.midScanLineJIT();
    //Update the color palette for BG tiles since it changed:
    this.gbcBGRawPalette[index] = data;
    if ((index & 0x06) === 0) {
      //Palette 0 (Special tile Priority stuff)
      data = 0x2000000 | this.adjustRGBTint(this.gbcBGRawPalette[index | 1] << 8 | this.gbcBGRawPalette[index & 0x3e]);
      index >>= 1;
      this.gbcBGPalette[index] = data;
      this.gbcBGPalette[0x20 | index] = 0x1000000 | data;
    } else {
      //Regular Palettes (No special crap)
      data = this.adjustRGBTint(this.gbcBGRawPalette[index | 1] << 8 | this.gbcBGRawPalette[index & 0x3e]);
      index >>= 1;
      this.gbcBGPalette[index] = data;
      this.gbcBGPalette[0x20 | index] = 0x1000000 | data;
    }
  }
};
GameBoyCore.prototype.updateGBCOBJPalette = function (index, data) {
  if (this.gbcOBJRawPalette[index] !== data) {
    //Update the color palette for OBJ tiles since it changed:
    this.gbcOBJRawPalette[index] = data;
    if ((index & 0x06) > 0) {
      //Regular Palettes (No special crap)
      this.midScanLineJIT();
      this.gbcOBJPalette[index >> 1] = 0x1000000 | this.adjustRGBTint(this.gbcOBJRawPalette[index | 1] << 8 | this.gbcOBJRawPalette[index & 0x3e]);
    }
  }
};
GameBoyCore.prototype.BGGBLayerRender = function (scanlineToRender) {
  var scrollYAdjusted = this.backgroundY + scanlineToRender & 0xff; //The line of the BG we're at.
  var tileYLine = (scrollYAdjusted & 7) << 3;
  var tileYDown = this.gfxBackgroundCHRBankPosition | (scrollYAdjusted & 0xf8) << 2; //The row of cached tiles we're fetching from.
  var scrollXAdjusted = this.backgroundX + this.currentX & 0xff; //The scroll amount of the BG.
  var pixelPosition = this.pixelStart + this.currentX; //Current pixel we're working on.
  var pixelPositionEnd = this.pixelStart + (this.gfxWindowDisplay && scanlineToRender - this.windowY >= 0 ? Math.min(Math.max(this.windowX, 0) + this.currentX, this.pixelEnd) : this.pixelEnd); //Make sure we do at most 160 pixels a scanline.
  var tileNumber = tileYDown + (scrollXAdjusted >> 3);
  var chrCode = this.BGCHRBank1[tileNumber];
  if (chrCode < this.gfxBackgroundBankOffset) {
    chrCode |= 0x100;
  }
  var tile = this.tileCache[chrCode];
  for (
    var texel = scrollXAdjusted & 0x7; texel < 8 && pixelPosition < pixelPositionEnd && scrollXAdjusted < 0x100;
    ++scrollXAdjusted
  ) {
    this.frameBuffer[pixelPosition++] = this.BGPalette[
      tile[tileYLine | texel++]
    ];
  }
  var scrollXAdjustedAligned = Math.min(
    pixelPositionEnd - pixelPosition,
    0x100 - scrollXAdjusted
  ) >> 3;
  scrollXAdjusted += scrollXAdjustedAligned << 3;
  scrollXAdjustedAligned += tileNumber;
  while (tileNumber < scrollXAdjustedAligned) {
    chrCode = this.BGCHRBank1[++tileNumber];
    if (chrCode < this.gfxBackgroundBankOffset) {
      chrCode |= 0x100;
    }
    tile = this.tileCache[chrCode];
    texel = tileYLine;
    this.frameBuffer[pixelPosition++] = this.BGPalette[tile[texel++]];
    this.frameBuffer[pixelPosition++] = this.BGPalette[tile[texel++]];
    this.frameBuffer[pixelPosition++] = this.BGPalette[tile[texel++]];
    this.frameBuffer[pixelPosition++] = this.BGPalette[tile[texel++]];
    this.frameBuffer[pixelPosition++] = this.BGPalette[tile[texel++]];
    this.frameBuffer[pixelPosition++] = this.BGPalette[tile[texel++]];
    this.frameBuffer[pixelPosition++] = this.BGPalette[tile[texel++]];
    this.frameBuffer[pixelPosition++] = this.BGPalette[tile[texel]];
  }
  if (pixelPosition < pixelPositionEnd) {
    if (scrollXAdjusted < 0x100) {
      chrCode = this.BGCHRBank1[++tileNumber];
      if (chrCode < this.gfxBackgroundBankOffset) {
        chrCode |= 0x100;
      }
      tile = this.tileCache[chrCode];
      for (
        texel = tileYLine - 1; pixelPosition < pixelPositionEnd && scrollXAdjusted < 0x100;
        ++scrollXAdjusted
      ) {
        this.frameBuffer[pixelPosition++] = this.BGPalette[tile[++texel]];
      }
    }
    scrollXAdjustedAligned = (pixelPositionEnd - pixelPosition >> 3) +
      tileYDown;
    while (tileYDown < scrollXAdjustedAligned) {
      chrCode = this.BGCHRBank1[tileYDown++];
      if (chrCode < this.gfxBackgroundBankOffset) {
        chrCode |= 0x100;
      }
      tile = this.tileCache[chrCode];
      texel = tileYLine;
      this.frameBuffer[pixelPosition++] = this.BGPalette[tile[texel++]];
      this.frameBuffer[pixelPosition++] = this.BGPalette[tile[texel++]];
      this.frameBuffer[pixelPosition++] = this.BGPalette[tile[texel++]];
      this.frameBuffer[pixelPosition++] = this.BGPalette[tile[texel++]];
      this.frameBuffer[pixelPosition++] = this.BGPalette[tile[texel++]];
      this.frameBuffer[pixelPosition++] = this.BGPalette[tile[texel++]];
      this.frameBuffer[pixelPosition++] = this.BGPalette[tile[texel++]];
      this.frameBuffer[pixelPosition++] = this.BGPalette[tile[texel]];
    }
    if (pixelPosition < pixelPositionEnd) {
      chrCode = this.BGCHRBank1[tileYDown];
      if (chrCode < this.gfxBackgroundBankOffset) {
        chrCode |= 0x100;
      }
      tile = this.tileCache[chrCode];
      switch (pixelPositionEnd - pixelPosition) {
      case 7:
        this.frameBuffer[pixelPosition + 6] = this.BGPalette[tile[tileYLine | 6]];
      case 6:
        this.frameBuffer[pixelPosition + 5] = this.BGPalette[tile[tileYLine | 5]];
      case 5:
        this.frameBuffer[pixelPosition + 4] = this.BGPalette[tile[tileYLine | 4]];
      case 4:
        this.frameBuffer[pixelPosition + 3] = this.BGPalette[tile[tileYLine | 3]];
      case 3:
        this.frameBuffer[pixelPosition + 2] = this.BGPalette[tile[tileYLine | 2]];
      case 2:
        this.frameBuffer[pixelPosition + 1] = this.BGPalette[tile[tileYLine | 1]];
      case 1:
        this.frameBuffer[pixelPosition] = this.BGPalette[tile[tileYLine]];
      }
    }
  }
};
GameBoyCore.prototype.BGGBCLayerRender = function (scanlineToRender) {
  var scrollYAdjusted = this.backgroundY + scanlineToRender & 0xff; //The line of the BG we're at.
  var tileYLine = (scrollYAdjusted & 7) << 3;
  var tileYDown = this.gfxBackgroundCHRBankPosition | (scrollYAdjusted & 0xf8) << 2; //The row of cached tiles we're fetching from.
  var scrollXAdjusted = this.backgroundX + this.currentX & 0xff; //The scroll amount of the BG.
  var pixelPosition = this.pixelStart + this.currentX; //Current pixel we're working on.
  var pixelPositionEnd = this.pixelStart + (this.gfxWindowDisplay && scanlineToRender - this.windowY >= 0 ? Math.min(Math.max(this.windowX, 0) + this.currentX, this.pixelEnd) : this.pixelEnd); //Make sure we do at most 160 pixels a scanline.
  var tileNumber = tileYDown + (scrollXAdjusted >> 3);
  var chrCode = this.BGCHRBank1[tileNumber];
  if (chrCode < this.gfxBackgroundBankOffset) {
    chrCode |= 0x100;
  }
  var attrCode = this.BGCHRBank2[tileNumber];
  var tile = this.tileCache[(attrCode & 0x08) << 8 | (attrCode & 0x60) << 4 | chrCode];
  var palette = (attrCode & 0x7) << 2 | (attrCode & 0x80) >> 2;
  for (var texel = scrollXAdjusted & 0x7; texel < 8 && pixelPosition < pixelPositionEnd && scrollXAdjusted < 0x100; ++scrollXAdjusted) {
    this.frameBuffer[pixelPosition++] = this.gbcBGPalette[palette | tile[tileYLine | texel++]];
  }
  var scrollXAdjustedAligned = Math.min(pixelPositionEnd - pixelPosition, 0x100 - scrollXAdjusted) >> 3;
  scrollXAdjusted += scrollXAdjustedAligned << 3;
  scrollXAdjustedAligned += tileNumber;
  while (tileNumber < scrollXAdjustedAligned) {
    chrCode = this.BGCHRBank1[++tileNumber];
    if (chrCode < this.gfxBackgroundBankOffset) {
      chrCode |= 0x100;
    }
    attrCode = this.BGCHRBank2[tileNumber];
    tile = this.tileCache[(attrCode & 0x08) << 8 | (attrCode & 0x60) << 4 | chrCode];
    palette = (attrCode & 0x7) << 2 | (attrCode & 0x80) >> 2;
    texel = tileYLine;
    this.frameBuffer[pixelPosition++] = this.gbcBGPalette[palette | tile[texel++]];
    this.frameBuffer[pixelPosition++] = this.gbcBGPalette[palette | tile[texel++]];
    this.frameBuffer[pixelPosition++] = this.gbcBGPalette[palette | tile[texel++]];
    this.frameBuffer[pixelPosition++] = this.gbcBGPalette[palette | tile[texel++]];
    this.frameBuffer[pixelPosition++] = this.gbcBGPalette[palette | tile[texel++]];
    this.frameBuffer[pixelPosition++] = this.gbcBGPalette[palette | tile[texel++]];
    this.frameBuffer[pixelPosition++] = this.gbcBGPalette[palette | tile[texel++]];
    this.frameBuffer[pixelPosition++] = this.gbcBGPalette[palette | tile[texel]];
  }
  if (pixelPosition < pixelPositionEnd) {
    if (scrollXAdjusted < 0x100) {
      chrCode = this.BGCHRBank1[++tileNumber];
      if (chrCode < this.gfxBackgroundBankOffset) {
        chrCode |= 0x100;
      }
      attrCode = this.BGCHRBank2[tileNumber];
      tile = this.tileCache[
        (attrCode & 0x08) << 8 | (attrCode & 0x60) << 4 | chrCode
      ];
      palette = (attrCode & 0x7) << 2 | (attrCode & 0x80) >> 2;
      for (
        texel = tileYLine - 1; pixelPosition < pixelPositionEnd && scrollXAdjusted < 0x100;
        ++scrollXAdjusted
      ) {
        this.frameBuffer[pixelPosition++] = this.gbcBGPalette[
          palette | tile[++texel]
        ];
      }
    }
    scrollXAdjustedAligned = (pixelPositionEnd - pixelPosition >> 3) +
      tileYDown;
    while (tileYDown < scrollXAdjustedAligned) {
      chrCode = this.BGCHRBank1[tileYDown];
      if (chrCode < this.gfxBackgroundBankOffset) {
        chrCode |= 0x100;
      }
      attrCode = this.BGCHRBank2[tileYDown++];
      tile = this.tileCache[
        (attrCode & 0x08) << 8 | (attrCode & 0x60) << 4 | chrCode
      ];
      palette = (attrCode & 0x7) << 2 | (attrCode & 0x80) >> 2;
      texel = tileYLine;
      this.frameBuffer[pixelPosition++] = this.gbcBGPalette[
        palette | tile[texel++]
      ];
      this.frameBuffer[pixelPosition++] = this.gbcBGPalette[
        palette | tile[texel++]
      ];
      this.frameBuffer[pixelPosition++] = this.gbcBGPalette[
        palette | tile[texel++]
      ];
      this.frameBuffer[pixelPosition++] = this.gbcBGPalette[
        palette | tile[texel++]
      ];
      this.frameBuffer[pixelPosition++] = this.gbcBGPalette[
        palette | tile[texel++]
      ];
      this.frameBuffer[pixelPosition++] = this.gbcBGPalette[
        palette | tile[texel++]
      ];
      this.frameBuffer[pixelPosition++] = this.gbcBGPalette[
        palette | tile[texel++]
      ];
      this.frameBuffer[pixelPosition++] = this.gbcBGPalette[
        palette | tile[texel]
      ];
    }
    if (pixelPosition < pixelPositionEnd) {
      chrCode = this.BGCHRBank1[tileYDown];
      if (chrCode < this.gfxBackgroundBankOffset) {
        chrCode |= 0x100;
      }
      attrCode = this.BGCHRBank2[tileYDown];
      tile = this.tileCache[
        (attrCode & 0x08) << 8 | (attrCode & 0x60) << 4 | chrCode
      ];
      palette = (attrCode & 0x7) << 2 | (attrCode & 0x80) >> 2;
      switch (pixelPositionEnd - pixelPosition) {
      case 7:
        this.frameBuffer[pixelPosition + 6] = this.gbcBGPalette[
          palette | tile[tileYLine | 6]
        ];
      case 6:
        this.frameBuffer[pixelPosition + 5] = this.gbcBGPalette[
          palette | tile[tileYLine | 5]
        ];
      case 5:
        this.frameBuffer[pixelPosition + 4] = this.gbcBGPalette[
          palette | tile[tileYLine | 4]
        ];
      case 4:
        this.frameBuffer[pixelPosition + 3] = this.gbcBGPalette[
          palette | tile[tileYLine | 3]
        ];
      case 3:
        this.frameBuffer[pixelPosition + 2] = this.gbcBGPalette[
          palette | tile[tileYLine | 2]
        ];
      case 2:
        this.frameBuffer[pixelPosition + 1] = this.gbcBGPalette[
          palette | tile[tileYLine | 1]
        ];
      case 1:
        this.frameBuffer[pixelPosition] = this.gbcBGPalette[
          palette | tile[tileYLine]
        ];
      }
    }
  }
};
GameBoyCore.prototype.BGGBCLayerRenderNoPriorityFlagging = function (
  scanlineToRender
) {
  var scrollYAdjusted = this.backgroundY + scanlineToRender & 0xff; //The line of the BG we're at.
  var tileYLine = (scrollYAdjusted & 7) << 3;
  var tileYDown = this.gfxBackgroundCHRBankPosition |
    (scrollYAdjusted & 0xf8) << 2; //The row of cached tiles we're fetching from.
  var scrollXAdjusted = this.backgroundX + this.currentX & 0xff; //The scroll amount of the BG.
  var pixelPosition = this.pixelStart + this.currentX; //Current pixel we're working on.
  var pixelPositionEnd = this.pixelStart +
    (this.gfxWindowDisplay && scanlineToRender - this.windowY >= 0 ?
      Math.min(Math.max(this.windowX, 0) + this.currentX, this.pixelEnd) :
      this.pixelEnd); //Make sure we do at most 160 pixels a scanline.
  var tileNumber = tileYDown + (scrollXAdjusted >> 3);
  var chrCode = this.BGCHRBank1[tileNumber];
  if (chrCode < this.gfxBackgroundBankOffset) {
    chrCode |= 0x100;
  }
  var attrCode = this.BGCHRBank2[tileNumber];
  var tile = this.tileCache[
    (attrCode & 0x08) << 8 | (attrCode & 0x60) << 4 | chrCode
  ];
  var palette = (attrCode & 0x7) << 2;
  for (
    var texel = scrollXAdjusted & 0x7; texel < 8 && pixelPosition < pixelPositionEnd && scrollXAdjusted < 0x100;
    ++scrollXAdjusted
  ) {
    this.frameBuffer[pixelPosition++] = this.gbcBGPalette[
      palette | tile[tileYLine | texel++]
    ];
  }
  var scrollXAdjustedAligned = Math.min(
    pixelPositionEnd - pixelPosition,
    0x100 - scrollXAdjusted
  ) >> 3;
  scrollXAdjusted += scrollXAdjustedAligned << 3;
  scrollXAdjustedAligned += tileNumber;
  while (tileNumber < scrollXAdjustedAligned) {
    chrCode = this.BGCHRBank1[++tileNumber];
    if (chrCode < this.gfxBackgroundBankOffset) {
      chrCode |= 0x100;
    }
    attrCode = this.BGCHRBank2[tileNumber];
    tile = this.tileCache[
      (attrCode & 0x08) << 8 | (attrCode & 0x60) << 4 | chrCode
    ];
    palette = (attrCode & 0x7) << 2;
    texel = tileYLine;
    this.frameBuffer[pixelPosition++] = this.gbcBGPalette[
      palette | tile[texel++]
    ];
    this.frameBuffer[pixelPosition++] = this.gbcBGPalette[
      palette | tile[texel++]
    ];
    this.frameBuffer[pixelPosition++] = this.gbcBGPalette[
      palette | tile[texel++]
    ];
    this.frameBuffer[pixelPosition++] = this.gbcBGPalette[
      palette | tile[texel++]
    ];
    this.frameBuffer[pixelPosition++] = this.gbcBGPalette[
      palette | tile[texel++]
    ];
    this.frameBuffer[pixelPosition++] = this.gbcBGPalette[
      palette | tile[texel++]
    ];
    this.frameBuffer[pixelPosition++] = this.gbcBGPalette[
      palette | tile[texel++]
    ];
    this.frameBuffer[pixelPosition++] = this.gbcBGPalette[
      palette | tile[texel]
    ];
  }
  if (pixelPosition < pixelPositionEnd) {
    if (scrollXAdjusted < 0x100) {
      chrCode = this.BGCHRBank1[++tileNumber];
      if (chrCode < this.gfxBackgroundBankOffset) {
        chrCode |= 0x100;
      }
      attrCode = this.BGCHRBank2[tileNumber];
      tile = this.tileCache[
        (attrCode & 0x08) << 8 | (attrCode & 0x60) << 4 | chrCode
      ];
      palette = (attrCode & 0x7) << 2;
      for (
        texel = tileYLine - 1; pixelPosition < pixelPositionEnd && scrollXAdjusted < 0x100;
        ++scrollXAdjusted
      ) {
        this.frameBuffer[pixelPosition++] = this.gbcBGPalette[
          palette | tile[++texel]
        ];
      }
    }
    scrollXAdjustedAligned = (pixelPositionEnd - pixelPosition >> 3) +
      tileYDown;
    while (tileYDown < scrollXAdjustedAligned) {
      chrCode = this.BGCHRBank1[tileYDown];
      if (chrCode < this.gfxBackgroundBankOffset) {
        chrCode |= 0x100;
      }
      attrCode = this.BGCHRBank2[tileYDown++];
      tile = this.tileCache[
        (attrCode & 0x08) << 8 | (attrCode & 0x60) << 4 | chrCode
      ];
      palette = (attrCode & 0x7) << 2;
      texel = tileYLine;
      this.frameBuffer[pixelPosition++] = this.gbcBGPalette[
        palette | tile[texel++]
      ];
      this.frameBuffer[pixelPosition++] = this.gbcBGPalette[
        palette | tile[texel++]
      ];
      this.frameBuffer[pixelPosition++] = this.gbcBGPalette[
        palette | tile[texel++]
      ];
      this.frameBuffer[pixelPosition++] = this.gbcBGPalette[
        palette | tile[texel++]
      ];
      this.frameBuffer[pixelPosition++] = this.gbcBGPalette[
        palette | tile[texel++]
      ];
      this.frameBuffer[pixelPosition++] = this.gbcBGPalette[
        palette | tile[texel++]
      ];
      this.frameBuffer[pixelPosition++] = this.gbcBGPalette[
        palette | tile[texel++]
      ];
      this.frameBuffer[pixelPosition++] = this.gbcBGPalette[
        palette | tile[texel]
      ];
    }
    if (pixelPosition < pixelPositionEnd) {
      chrCode = this.BGCHRBank1[tileYDown];
      if (chrCode < this.gfxBackgroundBankOffset) {
        chrCode |= 0x100;
      }
      attrCode = this.BGCHRBank2[tileYDown];
      tile = this.tileCache[
        (attrCode & 0x08) << 8 | (attrCode & 0x60) << 4 | chrCode
      ];
      palette = (attrCode & 0x7) << 2;
      switch (pixelPositionEnd - pixelPosition) {
      case 7:
        this.frameBuffer[pixelPosition + 6] = this.gbcBGPalette[
          palette | tile[tileYLine | 6]
        ];
      case 6:
        this.frameBuffer[pixelPosition + 5] = this.gbcBGPalette[
          palette | tile[tileYLine | 5]
        ];
      case 5:
        this.frameBuffer[pixelPosition + 4] = this.gbcBGPalette[
          palette | tile[tileYLine | 4]
        ];
      case 4:
        this.frameBuffer[pixelPosition + 3] = this.gbcBGPalette[
          palette | tile[tileYLine | 3]
        ];
      case 3:
        this.frameBuffer[pixelPosition + 2] = this.gbcBGPalette[
          palette | tile[tileYLine | 2]
        ];
      case 2:
        this.frameBuffer[pixelPosition + 1] = this.gbcBGPalette[
          palette | tile[tileYLine | 1]
        ];
      case 1:
        this.frameBuffer[pixelPosition] = this.gbcBGPalette[
          palette | tile[tileYLine]
        ];
      }
    }
  }
};
GameBoyCore.prototype.WindowGBLayerRender = function (scanlineToRender) {
  if (this.gfxWindowDisplay) {
    //Is the window enabled?
    var scrollYAdjusted = scanlineToRender - this.windowY; //The line of the BG we're at.
    if (scrollYAdjusted >= 0) {
      var scrollXRangeAdjusted = this.windowX > 0 ?
        this.windowX + this.currentX :
        this.currentX;
      var pixelPosition = this.pixelStart + scrollXRangeAdjusted;
      var pixelPositionEnd = this.pixelStart + this.pixelEnd;
      if (pixelPosition < pixelPositionEnd) {
        var tileYLine = (scrollYAdjusted & 0x7) << 3;
        var tileNumber = (this.gfxWindowCHRBankPosition |
            (scrollYAdjusted & 0xf8) << 2) +
          (this.currentX >> 3);
        var chrCode = this.BGCHRBank1[tileNumber];
        if (chrCode < this.gfxBackgroundBankOffset) {
          chrCode |= 0x100;
        }
        var tile = this.tileCache[chrCode];
        var texel = scrollXRangeAdjusted - this.windowX & 0x7;
        scrollXRangeAdjusted = Math.min(
          8,
          texel + pixelPositionEnd - pixelPosition
        );
        while (texel < scrollXRangeAdjusted) {
          this.frameBuffer[pixelPosition++] = this.BGPalette[
            tile[tileYLine | texel++]
          ];
        }
        scrollXRangeAdjusted = tileNumber +
          (pixelPositionEnd - pixelPosition >> 3);
        while (tileNumber < scrollXRangeAdjusted) {
          chrCode = this.BGCHRBank1[++tileNumber];
          if (chrCode < this.gfxBackgroundBankOffset) {
            chrCode |= 0x100;
          }
          tile = this.tileCache[chrCode];
          texel = tileYLine;
          this.frameBuffer[pixelPosition++] = this.BGPalette[tile[texel++]];
          this.frameBuffer[pixelPosition++] = this.BGPalette[tile[texel++]];
          this.frameBuffer[pixelPosition++] = this.BGPalette[tile[texel++]];
          this.frameBuffer[pixelPosition++] = this.BGPalette[tile[texel++]];
          this.frameBuffer[pixelPosition++] = this.BGPalette[tile[texel++]];
          this.frameBuffer[pixelPosition++] = this.BGPalette[tile[texel++]];
          this.frameBuffer[pixelPosition++] = this.BGPalette[tile[texel++]];
          this.frameBuffer[pixelPosition++] = this.BGPalette[tile[texel]];
        }
        if (pixelPosition < pixelPositionEnd) {
          chrCode = this.BGCHRBank1[++tileNumber];
          if (chrCode < this.gfxBackgroundBankOffset) {
            chrCode |= 0x100;
          }
          tile = this.tileCache[chrCode];
          switch (pixelPositionEnd - pixelPosition) {
          case 7:
            this.frameBuffer[pixelPosition + 6] = this.BGPalette[
              tile[tileYLine | 6]
            ];
          case 6:
            this.frameBuffer[pixelPosition + 5] = this.BGPalette[
              tile[tileYLine | 5]
            ];
          case 5:
            this.frameBuffer[pixelPosition + 4] = this.BGPalette[
              tile[tileYLine | 4]
            ];
          case 4:
            this.frameBuffer[pixelPosition + 3] = this.BGPalette[
              tile[tileYLine | 3]
            ];
          case 3:
            this.frameBuffer[pixelPosition + 2] = this.BGPalette[
              tile[tileYLine | 2]
            ];
          case 2:
            this.frameBuffer[pixelPosition + 1] = this.BGPalette[
              tile[tileYLine | 1]
            ];
          case 1:
            this.frameBuffer[pixelPosition] = this.BGPalette[tile[tileYLine]];
          }
        }
      }
    }
  }
};
GameBoyCore.prototype.WindowGBCLayerRender = function (scanlineToRender) {
  if (this.gfxWindowDisplay) {
    //Is the window enabled?
    var scrollYAdjusted = scanlineToRender - this.windowY; //The line of the BG we're at.
    if (scrollYAdjusted >= 0) {
      var scrollXRangeAdjusted = this.windowX > 0 ?
        this.windowX + this.currentX :
        this.currentX;
      var pixelPosition = this.pixelStart + scrollXRangeAdjusted;
      var pixelPositionEnd = this.pixelStart + this.pixelEnd;
      if (pixelPosition < pixelPositionEnd) {
        var tileYLine = (scrollYAdjusted & 0x7) << 3;
        var tileNumber = (this.gfxWindowCHRBankPosition |
            (scrollYAdjusted & 0xf8) << 2) +
          (this.currentX >> 3);
        var chrCode = this.BGCHRBank1[tileNumber];
        if (chrCode < this.gfxBackgroundBankOffset) {
          chrCode |= 0x100;
        }
        var attrCode = this.BGCHRBank2[tileNumber];
        var tile = this.tileCache[
          (attrCode & 0x08) << 8 | (attrCode & 0x60) << 4 | chrCode
        ];
        var palette = (attrCode & 0x7) << 2 | (attrCode & 0x80) >> 2;
        var texel = scrollXRangeAdjusted - this.windowX & 0x7;
        scrollXRangeAdjusted = Math.min(
          8,
          texel + pixelPositionEnd - pixelPosition
        );
        while (texel < scrollXRangeAdjusted) {
          this.frameBuffer[pixelPosition++] = this.gbcBGPalette[
            palette | tile[tileYLine | texel++]
          ];
        }
        scrollXRangeAdjusted = tileNumber +
          (pixelPositionEnd - pixelPosition >> 3);
        while (tileNumber < scrollXRangeAdjusted) {
          chrCode = this.BGCHRBank1[++tileNumber];
          if (chrCode < this.gfxBackgroundBankOffset) {
            chrCode |= 0x100;
          }
          attrCode = this.BGCHRBank2[tileNumber];
          tile = this.tileCache[
            (attrCode & 0x08) << 8 | (attrCode & 0x60) << 4 | chrCode
          ];
          palette = (attrCode & 0x7) << 2 | (attrCode & 0x80) >> 2;
          texel = tileYLine;
          this.frameBuffer[pixelPosition++] = this.gbcBGPalette[
            palette | tile[texel++]
          ];
          this.frameBuffer[pixelPosition++] = this.gbcBGPalette[
            palette | tile[texel++]
          ];
          this.frameBuffer[pixelPosition++] = this.gbcBGPalette[
            palette | tile[texel++]
          ];
          this.frameBuffer[pixelPosition++] = this.gbcBGPalette[
            palette | tile[texel++]
          ];
          this.frameBuffer[pixelPosition++] = this.gbcBGPalette[
            palette | tile[texel++]
          ];
          this.frameBuffer[pixelPosition++] = this.gbcBGPalette[palette | tile[texel++]];
          this.frameBuffer[pixelPosition++] = this.gbcBGPalette[palette | tile[texel++]];
          this.frameBuffer[pixelPosition++] = this.gbcBGPalette[palette | tile[texel]];
        }
        if (pixelPosition < pixelPositionEnd) {
          chrCode = this.BGCHRBank1[++tileNumber];
          if (chrCode < this.gfxBackgroundBankOffset) {
            chrCode |= 0x100;
          }
          attrCode = this.BGCHRBank2[tileNumber];
          tile = this.tileCache[(attrCode & 0x08) << 8 | (attrCode & 0x60) << 4 | chrCode];
          palette = (attrCode & 0x7) << 2 | (attrCode & 0x80) >> 2;
          switch (pixelPositionEnd - pixelPosition) {
          case 7:
            this.frameBuffer[pixelPosition + 6] = this.gbcBGPalette[palette | tile[tileYLine | 6]];
          case 6:
            this.frameBuffer[pixelPosition + 5] = this.gbcBGPalette[palette | tile[tileYLine | 5]];
          case 5:
            this.frameBuffer[pixelPosition + 4] = this.gbcBGPalette[palette | tile[tileYLine | 4]];
          case 4:
            this.frameBuffer[pixelPosition + 3] = this.gbcBGPalette[palette | tile[tileYLine | 3]];
          case 3:
            this.frameBuffer[pixelPosition + 2] = this.gbcBGPalette[palette | tile[tileYLine | 2]];
          case 2:
            this.frameBuffer[pixelPosition + 1] = this.gbcBGPalette[palette | tile[tileYLine | 1]];
          case 1:
            this.frameBuffer[pixelPosition] = this.gbcBGPalette[palette | tile[tileYLine]];
          }
        }
      }
    }
  }
};
GameBoyCore.prototype.WindowGBCLayerRenderNoPriorityFlagging = function (scanlineToRender) {
  if (this.gfxWindowDisplay) {
    //Is the window enabled?
    var scrollYAdjusted = scanlineToRender - this.windowY; //The line of the BG we're at.
    if (scrollYAdjusted >= 0) {
      var scrollXRangeAdjusted = this.windowX > 0 ? this.windowX + this.currentX : this.currentX;
      var pixelPosition = this.pixelStart + scrollXRangeAdjusted;
      var pixelPositionEnd = this.pixelStart + this.pixelEnd;
      if (pixelPosition < pixelPositionEnd) {
        var tileYLine = (scrollYAdjusted & 0x7) << 3;
        var tileNumber = (this.gfxWindowCHRBankPosition | (scrollYAdjusted & 0xf8) << 2) + (this.currentX >> 3);
        var chrCode = this.BGCHRBank1[tileNumber];
        if (chrCode < this.gfxBackgroundBankOffset) {
          chrCode |= 0x100;
        }
        var attrCode = this.BGCHRBank2[tileNumber];
        var tile = this.tileCache[(attrCode & 0x08) << 8 | (attrCode & 0x60) << 4 | chrCode];
        var palette = (attrCode & 0x7) << 2;
        var texel = scrollXRangeAdjusted - this.windowX & 0x7;
        scrollXRangeAdjusted = Math.min(8, texel + pixelPositionEnd - pixelPosition);
        while (texel < scrollXRangeAdjusted) {
          this.frameBuffer[pixelPosition++] = this.gbcBGPalette[palette | tile[tileYLine | texel++]];
        }
        scrollXRangeAdjusted = tileNumber + (pixelPositionEnd - pixelPosition >> 3);
        while (tileNumber < scrollXRangeAdjusted) {
          chrCode = this.BGCHRBank1[++tileNumber];
          if (chrCode < this.gfxBackgroundBankOffset) {
            chrCode |= 0x100;
          }
          attrCode = this.BGCHRBank2[tileNumber];
          tile = this.tileCache[(attrCode & 0x08) << 8 | (attrCode & 0x60) << 4 | chrCode];
          palette = (attrCode & 0x7) << 2;
          texel = tileYLine;
          this.frameBuffer[pixelPosition++] = this.gbcBGPalette[palette | tile[texel++]];
          this.frameBuffer[pixelPosition++] = this.gbcBGPalette[palette | tile[texel++]];
          this.frameBuffer[pixelPosition++] = this.gbcBGPalette[palette | tile[texel++]];
          this.frameBuffer[pixelPosition++] = this.gbcBGPalette[palette | tile[texel++]];
          this.frameBuffer[pixelPosition++] = this.gbcBGPalette[palette | tile[texel++]];
          this.frameBuffer[pixelPosition++] = this.gbcBGPalette[palette | tile[texel++]];
          this.frameBuffer[pixelPosition++] = this.gbcBGPalette[palette | tile[texel++]];
          this.frameBuffer[pixelPosition++] = this.gbcBGPalette[palette | tile[texel]];
        }
        if (pixelPosition < pixelPositionEnd) {
          chrCode = this.BGCHRBank1[++tileNumber];
          if (chrCode < this.gfxBackgroundBankOffset) {
            chrCode |= 0x100;
          }
          attrCode = this.BGCHRBank2[tileNumber];
          tile = this.tileCache[(attrCode & 0x08) << 8 | (attrCode & 0x60) << 4 | chrCode];
          palette = (attrCode & 0x7) << 2;
          switch (pixelPositionEnd - pixelPosition) {
          case 7:
            this.frameBuffer[pixelPosition + 6] = this.gbcBGPalette[
              palette | tile[tileYLine | 6]
            ];
          case 6:
            this.frameBuffer[pixelPosition + 5] = this.gbcBGPalette[
              palette | tile[tileYLine | 5]
            ];
          case 5:
            this.frameBuffer[pixelPosition + 4] = this.gbcBGPalette[
              palette | tile[tileYLine | 4]
            ];
          case 4:
            this.frameBuffer[pixelPosition + 3] = this.gbcBGPalette[
              palette | tile[tileYLine | 3]
            ];
          case 3:
            this.frameBuffer[pixelPosition + 2] = this.gbcBGPalette[
              palette | tile[tileYLine | 2]
            ];
          case 2:
            this.frameBuffer[pixelPosition + 1] = this.gbcBGPalette[
              palette | tile[tileYLine | 1]
            ];
          case 1:
            this.frameBuffer[pixelPosition] = this.gbcBGPalette[
              palette | tile[tileYLine]
            ];
          }
        }
      }
    }
  }
};
GameBoyCore.prototype.SpriteGBLayerRender = function (scanlineToRender) {
  if (this.gfxSpriteShow) {
    //Are sprites enabled?
    var lineAdjusted = scanlineToRender + 0x10;
    var OAMAddress = 0xfe00;
    var yoffset = 0;
    var xcoord = 1;
    var xCoordStart = 0;
    var xCoordEnd = 0;
    var attrCode = 0;
    var palette = 0;
    var tile = null;
    var data = 0;
    var spriteCount = 0;
    var length = 0;
    var currentPixel = 0;
    var linePixel = 0;
    //Clear our x-coord sort buffer:
    while (xcoord < 168) {
      this.sortBuffer[xcoord++] = 0xff;
    }
    if (this.gfxSpriteNormalHeight) {
      //Draw the visible sprites:
      for (let length = this.findLowestSpriteDrawable(lineAdjusted, 0x7); spriteCount < length; ++spriteCount) {
        OAMAddress = this.OAMAddressCache[spriteCount];
        yoffset = lineAdjusted - this.memory[OAMAddress] << 3;
        attrCode = this.memory[OAMAddress | 3];
        palette = (attrCode & 0x10) >> 2;
        tile = this.tileCache[(attrCode & 0x60) << 4 | this.memory[OAMAddress | 0x2]];
        linePixel = xCoordStart = this.memory[OAMAddress | 1];
        xCoordEnd = Math.min(168 - linePixel, 8);
        xcoord = linePixel > 7 ? 0 : 8 - linePixel;
        for (currentPixel = this.pixelStart + (linePixel > 8 ? linePixel - 8 : 0); xcoord < xCoordEnd; ++xcoord, ++currentPixel, ++linePixel) {
          if (this.sortBuffer[linePixel] > xCoordStart) {
            if (this.frameBuffer[currentPixel] >= 0x2000000) {
              data = tile[yoffset | xcoord];
              if (data > 0) {
                this.frameBuffer[currentPixel] = this.OBJPalette[palette | data];
                this.sortBuffer[linePixel] = xCoordStart;
              }
            } else if (this.frameBuffer[currentPixel] < 0x1000000) {
              data = tile[yoffset | xcoord];
              if (data > 0 && attrCode < 0x80) {
                this.frameBuffer[currentPixel] = this.OBJPalette[palette | data];
                this.sortBuffer[linePixel] = xCoordStart;
              }
            }
          }
        }
      }
    } else {
      //Draw the visible sprites:
      for (let length = this.findLowestSpriteDrawable(lineAdjusted, 0xf); spriteCount < length; ++spriteCount) {
        OAMAddress = this.OAMAddressCache[spriteCount];
        yoffset = lineAdjusted - this.memory[OAMAddress] << 3;
        attrCode = this.memory[OAMAddress | 3];
        palette = (attrCode & 0x10) >> 2;
        if ((attrCode & 0x40) === (0x40 & yoffset)) {
          tile = this.tileCache[(attrCode & 0x60) << 4 | this.memory[OAMAddress | 0x2] & 0xfe];
        } else {
          tile = this.tileCache[(attrCode & 0x60) << 4 | this.memory[OAMAddress | 0x2] | 1];
        }
        yoffset &= 0x3f;
        linePixel = xCoordStart = this.memory[OAMAddress | 1];
        xCoordEnd = Math.min(168 - linePixel, 8);
        xcoord = linePixel > 7 ? 0 : 8 - linePixel;
        for (currentPixel = this.pixelStart + (linePixel > 8 ? linePixel - 8 : 0); xcoord < xCoordEnd; ++xcoord, ++currentPixel, ++linePixel) {
          if (this.sortBuffer[linePixel] > xCoordStart) {
            if (this.frameBuffer[currentPixel] >= 0x2000000) {
              data = tile[yoffset | xcoord];
              if (data > 0) {
                this.frameBuffer[currentPixel] = this.OBJPalette[palette | data];
                this.sortBuffer[linePixel] = xCoordStart;
              }
            } else if (this.frameBuffer[currentPixel] < 0x1000000) {
              data = tile[yoffset | xcoord];
              if (data > 0 && attrCode < 0x80) {
                this.frameBuffer[currentPixel] = this.OBJPalette[palette | data];
                this.sortBuffer[linePixel] = xCoordStart;
              }
            }
          }
        }
      }
    }
  }
};
GameBoyCore.prototype.findLowestSpriteDrawable = function (scanlineToRender, drawableRange) {
  var address = 0xfe00;
  var spriteCount = 0;
  var diff = 0;
  while (address < 0xfea0 && spriteCount < 10) {
    diff = scanlineToRender - this.memory[address];
    if ((diff & drawableRange) === diff) {
      this.OAMAddressCache[spriteCount++] = address;
    }
    address += 4;
  }
  return spriteCount;
};
GameBoyCore.prototype.SpriteGBCLayerRender = function (scanlineToRender) {
  if (this.gfxSpriteShow) {
    //Are sprites enabled?
    var OAMAddress = 0xfe00;
    var lineAdjusted = scanlineToRender + 0x10;
    var yoffset = 0;
    var xcoord = 0;
    var endX = 0;
    var xCounter = 0;
    var attrCode = 0;
    var palette = 0;
    var tile = null;
    var data = 0;
    var currentPixel = 0;
    var spriteCount = 0;
    if (this.gfxSpriteNormalHeight) {
      for (; OAMAddress < 0xfea0 && spriteCount < 10; OAMAddress += 4) {
        yoffset = lineAdjusted - this.memory[OAMAddress];
        if ((yoffset & 0x7) === yoffset) {
          xcoord = this.memory[OAMAddress | 1] - 8;
          endX = Math.min(160, xcoord + 8);
          attrCode = this.memory[OAMAddress | 3];
          palette = (attrCode & 7) << 2;
          tile = this.tileCache[(attrCode & 0x08) << 8 | (attrCode & 0x60) << 4 | this.memory[OAMAddress | 2]];
          xCounter = xcoord > 0 ? xcoord : 0;
          xcoord -= yoffset << 3;
          for (currentPixel = this.pixelStart + xCounter; xCounter < endX; ++xCounter, ++currentPixel) {
            if (this.frameBuffer[currentPixel] >= 0x2000000) {
              data = tile[xCounter - xcoord];
              if (data > 0) {
                this.frameBuffer[currentPixel] = this.gbcOBJPalette[palette | data];
              }
            } else if (this.frameBuffer[currentPixel] < 0x1000000) {
              data = tile[xCounter - xcoord];
              if (data > 0 && attrCode < 0x80) {
                //Don't optimize for attrCode, as LICM-capable JITs should optimize its checks.
                this.frameBuffer[currentPixel] = this.gbcOBJPalette[palette | data];
              }
            }
          }
          ++spriteCount;
        }
      }
    } else {
      for (; OAMAddress < 0xfea0 && spriteCount < 10; OAMAddress += 4) {
        yoffset = lineAdjusted - this.memory[OAMAddress];
        if ((yoffset & 0xf) === yoffset) {
          xcoord = this.memory[OAMAddress | 1] - 8;
          endX = Math.min(160, xcoord + 8);
          attrCode = this.memory[OAMAddress | 3];
          palette = (attrCode & 7) << 2;
          if ((attrCode & 0x40) === (0x40 & yoffset << 3)) {
            tile = this.tileCache[(attrCode & 0x08) << 8 | (attrCode & 0x60) << 4 | this.memory[OAMAddress | 0x2] & 0xfe];
          } else {
            tile = this.tileCache[(attrCode & 0x08) << 8 | (attrCode & 0x60) << 4 | this.memory[OAMAddress | 0x2] | 1];
          }
          xCounter = xcoord > 0 ? xcoord : 0;
          xcoord -= (yoffset & 0x7) << 3;
          for (currentPixel = this.pixelStart + xCounter; xCounter < endX; ++xCounter, ++currentPixel) {
            if (this.frameBuffer[currentPixel] >= 0x2000000) {
              data = tile[xCounter - xcoord];
              if (data > 0) {
                this.frameBuffer[currentPixel] = this.gbcOBJPalette[palette | data];
              }
            } else if (this.frameBuffer[currentPixel] < 0x1000000) {
              data = tile[xCounter - xcoord];
              if (data > 0 && attrCode < 0x80) {
                //Don't optimize for attrCode, as LICM-capable JITs should optimize its checks.
                this.frameBuffer[currentPixel] = this.gbcOBJPalette[palette | data];
              }
            }
          }
          ++spriteCount;
        }
      }
    }
  }
};
//Generate only a single tile line for the GB tile cache mode:
GameBoyCore.prototype.generateGBTileLine = function (address) {
  var lineCopy = this.memory[0x1 | address] << 8 | this.memory[0x9ffe & address];
  var tileBlock = this.tileCache[(address & 0x1ff0) >> 4];
  address = (address & 0xe) << 2;
  tileBlock[address | 7] = (lineCopy & 0x100) >> 7 | lineCopy & 0x1;
  tileBlock[address | 6] = (lineCopy & 0x200) >> 8 | (lineCopy & 0x2) >> 1;
  tileBlock[address | 5] = (lineCopy & 0x400) >> 9 | (lineCopy & 0x4) >> 2;
  tileBlock[address | 4] = (lineCopy & 0x800) >> 10 | (lineCopy & 0x8) >> 3;
  tileBlock[address | 3] = (lineCopy & 0x1000) >> 11 | (lineCopy & 0x10) >> 4;
  tileBlock[address | 2] = (lineCopy & 0x2000) >> 12 | (lineCopy & 0x20) >> 5;
  tileBlock[address | 1] = (lineCopy & 0x4000) >> 13 | (lineCopy & 0x40) >> 6;
  tileBlock[address] = (lineCopy & 0x8000) >> 14 | (lineCopy & 0x80) >> 7;
};
//Generate only a single tile line for the GBC tile cache mode (Bank 1):
GameBoyCore.prototype.generateGBCTileLineBank1 = function (address) {
  var lineCopy = this.memory[0x1 | address] << 8 | this.memory[0x9ffe & address];
  address &= 0x1ffe;
  var tileBlock1 = this.tileCache[address >> 4];
  var tileBlock2 = this.tileCache[0x200 | address >> 4];
  var tileBlock3 = this.tileCache[0x400 | address >> 4];
  var tileBlock4 = this.tileCache[0x600 | address >> 4];
  address = (address & 0xe) << 2;
  var addressFlipped = 0x38 - address;
  tileBlock4[addressFlipped] = tileBlock2[address] = tileBlock3[addressFlipped | 7] = tileBlock1[address | 7] = (lineCopy & 0x100) >> 7 | lineCopy & 0x1;
  tileBlock4[addressFlipped | 1] = tileBlock2[address | 1] = tileBlock3[addressFlipped | 6] = tileBlock1[address | 6] = (lineCopy & 0x200) >> 8 | (lineCopy & 0x2) >> 1;
  tileBlock4[addressFlipped | 2] = tileBlock2[address | 2] = tileBlock3[addressFlipped | 5] = tileBlock1[address | 5] = (lineCopy & 0x400) >> 9 | (lineCopy & 0x4) >> 2;
  tileBlock4[addressFlipped | 3] = tileBlock2[address | 3] = tileBlock3[addressFlipped | 4] = tileBlock1[address | 4] = (lineCopy & 0x800) >> 10 | (lineCopy & 0x8) >> 3;
  tileBlock4[addressFlipped | 4] = tileBlock2[address | 4] = tileBlock3[addressFlipped | 3] = tileBlock1[address | 3] = (lineCopy & 0x1000) >> 11 | (lineCopy & 0x10) >> 4;
  tileBlock4[addressFlipped | 5] = tileBlock2[address | 5] = tileBlock3[addressFlipped | 2] = tileBlock1[address | 2] = (lineCopy & 0x2000) >> 12 | (lineCopy & 0x20) >> 5;
  tileBlock4[addressFlipped | 6] = tileBlock2[address | 6] = tileBlock3[addressFlipped | 1] = tileBlock1[address | 1] = (lineCopy & 0x4000) >> 13 | (lineCopy & 0x40) >> 6;
  tileBlock4[addressFlipped | 7] = tileBlock2[address | 7] = tileBlock3[addressFlipped] = tileBlock1[address] = (lineCopy & 0x8000) >> 14 | (lineCopy & 0x80) >> 7;
};
//Generate all the flip combinations for a full GBC VRAM bank 1 tile:
GameBoyCore.prototype.generateGBCTileBank1 = function (vramAddress) {
  var address = vramAddress >> 4;
  var tileBlock1 = this.tileCache[address];
  var tileBlock2 = this.tileCache[0x200 | address];
  var tileBlock3 = this.tileCache[0x400 | address];
  var tileBlock4 = this.tileCache[0x600 | address];
  var lineCopy = 0;
  vramAddress |= 0x8000;
  address = 0;
  var addressFlipped = 56;
  do {
    lineCopy = this.memory[0x1 | vramAddress] << 8 | this.memory[vramAddress];
    tileBlock4[addressFlipped] = tileBlock2[address] = tileBlock3[addressFlipped | 7] = tileBlock1[address | 7] = (lineCopy & 0x100) >> 7 | lineCopy & 0x1;
    tileBlock4[addressFlipped | 1] = tileBlock2[address | 1] = tileBlock3[addressFlipped | 6] = tileBlock1[address | 6] = (lineCopy & 0x200) >> 8 | (lineCopy & 0x2) >> 1;
    tileBlock4[addressFlipped | 2] = tileBlock2[address | 2] = tileBlock3[addressFlipped | 5] = tileBlock1[address | 5] = (lineCopy & 0x400) >> 9 | (lineCopy & 0x4) >> 2;
    tileBlock4[addressFlipped | 3] = tileBlock2[address | 3] = tileBlock3[addressFlipped | 4] = tileBlock1[address | 4] = (lineCopy & 0x800) >> 10 | (lineCopy & 0x8) >> 3;
    tileBlock4[addressFlipped | 4] = tileBlock2[address | 4] = tileBlock3[addressFlipped | 3] = tileBlock1[address | 3] = (lineCopy & 0x1000) >> 11 | (lineCopy & 0x10) >> 4;
    tileBlock4[addressFlipped | 5] = tileBlock2[address | 5] = tileBlock3[addressFlipped | 2] = tileBlock1[address | 2] = (lineCopy & 0x2000) >> 12 | (lineCopy & 0x20) >> 5;
    tileBlock4[addressFlipped | 6] = tileBlock2[address | 6] = tileBlock3[addressFlipped | 1] = tileBlock1[address | 1] = (lineCopy & 0x4000) >> 13 | (lineCopy & 0x40) >> 6;
    tileBlock4[addressFlipped | 7] = tileBlock2[address | 7] = tileBlock3[addressFlipped] = tileBlock1[address] = (lineCopy & 0x8000) >> 14 | (lineCopy & 0x80) >> 7;
    address += 8;
    addressFlipped -= 8;
    vramAddress += 2;
  } while (addressFlipped > -1);
};
//Generate only a single tile line for the GBC tile cache mode (Bank 2):
GameBoyCore.prototype.generateGBCTileLineBank2 = function (address) {
  var lineCopy = this.VRAM[0x1 | address] << 8 | this.VRAM[0x1ffe & address];
  var tileBlock1 = this.tileCache[0x800 | address >> 4];
  var tileBlock2 = this.tileCache[0xa00 | address >> 4];
  var tileBlock3 = this.tileCache[0xc00 | address >> 4];
  var tileBlock4 = this.tileCache[0xe00 | address >> 4];
  address = (address & 0xe) << 2;
  var addressFlipped = 0x38 - address;
  tileBlock4[addressFlipped] = tileBlock2[address] = tileBlock3[addressFlipped | 7] = tileBlock1[address | 7] = (lineCopy & 0x100) >> 7 | lineCopy & 0x1;
  tileBlock4[addressFlipped | 1] = tileBlock2[address | 1] = tileBlock3[addressFlipped | 6] = tileBlock1[address | 6] = (lineCopy & 0x200) >> 8 | (lineCopy & 0x2) >> 1;
  tileBlock4[addressFlipped | 2] = tileBlock2[address | 2] = tileBlock3[addressFlipped | 5] = tileBlock1[address | 5] = (lineCopy & 0x400) >> 9 | (lineCopy & 0x4) >> 2;
  tileBlock4[addressFlipped | 3] = tileBlock2[address | 3] = tileBlock3[addressFlipped | 4] = tileBlock1[address | 4] = (lineCopy & 0x800) >> 10 | (lineCopy & 0x8) >> 3;
  tileBlock4[addressFlipped | 4] = tileBlock2[address | 4] = tileBlock3[addressFlipped | 3] = tileBlock1[address | 3] = (lineCopy & 0x1000) >> 11 | (lineCopy & 0x10) >> 4;
  tileBlock4[addressFlipped | 5] = tileBlock2[address | 5] = tileBlock3[addressFlipped | 2] = tileBlock1[address | 2] = (lineCopy & 0x2000) >> 12 | (lineCopy & 0x20) >> 5;
  tileBlock4[addressFlipped | 6] = tileBlock2[address | 6] = tileBlock3[addressFlipped | 1] = tileBlock1[address | 1] = (lineCopy & 0x4000) >> 13 | (lineCopy & 0x40) >> 6;
  tileBlock4[addressFlipped | 7] = tileBlock2[address | 7] = tileBlock3[addressFlipped] = tileBlock1[address] = (lineCopy & 0x8000) >> 14 | (lineCopy & 0x80) >> 7;
};
//Generate all the flip combinations for a full GBC VRAM bank 2 tile:
GameBoyCore.prototype.generateGBCTileBank2 = function (vramAddress) {
  var address = vramAddress >> 4;
  var tileBlock1 = this.tileCache[0x800 | address];
  var tileBlock2 = this.tileCache[0xa00 | address];
  var tileBlock3 = this.tileCache[0xc00 | address];
  var tileBlock4 = this.tileCache[0xe00 | address];
  var lineCopy = 0;
  address = 0;
  var addressFlipped = 56;
  do {
    lineCopy = this.VRAM[0x1 | vramAddress] << 8 | this.VRAM[vramAddress];
    tileBlock4[addressFlipped] = tileBlock2[address] = tileBlock3[addressFlipped | 7] = tileBlock1[address | 7] = (lineCopy & 0x100) >> 7 | lineCopy & 0x1;
    tileBlock4[addressFlipped | 1] = tileBlock2[address | 1] = tileBlock3[addressFlipped | 6] = tileBlock1[address | 6] = (lineCopy & 0x200) >> 8 | (lineCopy & 0x2) >> 1;
    tileBlock4[addressFlipped | 2] = tileBlock2[address | 2] = tileBlock3[addressFlipped | 5] = tileBlock1[address | 5] = (lineCopy & 0x400) >> 9 | (lineCopy & 0x4) >> 2;
    tileBlock4[addressFlipped | 3] = tileBlock2[address | 3] = tileBlock3[addressFlipped | 4] = tileBlock1[address | 4] = (lineCopy & 0x800) >> 10 | (lineCopy & 0x8) >> 3;
    tileBlock4[addressFlipped | 4] = tileBlock2[address | 4] = tileBlock3[addressFlipped | 3] = tileBlock1[address | 3] = (lineCopy & 0x1000) >> 11 | (lineCopy & 0x10) >> 4;
    tileBlock4[addressFlipped | 5] = tileBlock2[address | 5] = tileBlock3[addressFlipped | 2] = tileBlock1[address | 2] = (lineCopy & 0x2000) >> 12 | (lineCopy & 0x20) >> 5;
    tileBlock4[addressFlipped | 6] = tileBlock2[address | 6] = tileBlock3[addressFlipped | 1] = tileBlock1[address | 1] = (lineCopy & 0x4000) >> 13 | (lineCopy & 0x40) >> 6;
    tileBlock4[addressFlipped | 7] = tileBlock2[address | 7] = tileBlock3[addressFlipped] = tileBlock1[address] = (lineCopy & 0x8000) >> 14 | (lineCopy & 0x80) >> 7;
    address += 8;
    addressFlipped -= 8;
    vramAddress += 2;
  } while (addressFlipped > -1);
};
//Generate only a single tile line for the GB tile cache mode (OAM accessible range):
GameBoyCore.prototype.generateGBOAMTileLine = function (address) {
  var lineCopy = this.memory[0x1 | address] << 8 | this.memory[0x9ffe & address];
  address &= 0x1ffe;
  var tileBlock1 = this.tileCache[address >> 4];
  var tileBlock2 = this.tileCache[0x200 | address >> 4];
  var tileBlock3 = this.tileCache[0x400 | address >> 4];
  var tileBlock4 = this.tileCache[0x600 | address >> 4];
  address = (address & 0xe) << 2;
  var addressFlipped = 0x38 - address;
  tileBlock4[addressFlipped] = tileBlock2[address] = tileBlock3[addressFlipped | 7] = tileBlock1[address | 7] = (lineCopy & 0x100) >> 7 | lineCopy & 0x1;
  tileBlock4[addressFlipped | 1] = tileBlock2[address | 1] = tileBlock3[addressFlipped | 6] = tileBlock1[address | 6] = (lineCopy & 0x200) >> 8 | (lineCopy & 0x2) >> 1;
  tileBlock4[addressFlipped | 2] = tileBlock2[address | 2] = tileBlock3[addressFlipped | 5] = tileBlock1[address | 5] = (lineCopy & 0x400) >> 9 | (lineCopy & 0x4) >> 2;
  tileBlock4[addressFlipped | 3] = tileBlock2[address | 3] = tileBlock3[addressFlipped | 4] = tileBlock1[address | 4] = (lineCopy & 0x800) >> 10 | (lineCopy & 0x8) >> 3;
  tileBlock4[addressFlipped | 4] = tileBlock2[address | 4] = tileBlock3[addressFlipped | 3] = tileBlock1[address | 3] = (lineCopy & 0x1000) >> 11 | (lineCopy & 0x10) >> 4;
  tileBlock4[addressFlipped | 5] = tileBlock2[address | 5] = tileBlock3[addressFlipped | 2] = tileBlock1[address | 2] = (lineCopy & 0x2000) >> 12 | (lineCopy & 0x20) >> 5;
  tileBlock4[addressFlipped | 6] = tileBlock2[address | 6] = tileBlock3[addressFlipped | 1] = tileBlock1[address | 1] = (lineCopy & 0x4000) >> 13 | (lineCopy & 0x40) >> 6;
  tileBlock4[addressFlipped | 7] = tileBlock2[address | 7] = tileBlock3[addressFlipped] = tileBlock1[address] = (lineCopy & 0x8000) >> 14 | (lineCopy & 0x80) >> 7;
};
GameBoyCore.prototype.graphicsJIT = function () {
  if (this.LCDisOn) {
    this.cpu.totalLinesPassed = 0; //Mark frame for ensuring a JIT pass for the next framebuffer output.
    this.graphicsJITScanlineGroup();
  }
};
GameBoyCore.prototype.graphicsJITVBlank = function () {
  //JIT the graphics to v-blank framing:
  this.cpu.totalLinesPassed += this.queuedScanLines;
  this.graphicsJITScanlineGroup();
};
GameBoyCore.prototype.graphicsJITScanlineGroup = function () {
  //Normal rendering JIT, where we try to do groups of scanlines at once:
  while (this.queuedScanLines > 0) {
    this.renderScanLine(this.lastUnrenderedLine);
    if (this.lastUnrenderedLine < 143) {
      ++this.lastUnrenderedLine;
    } else {
      this.lastUnrenderedLine = 0;
    }
    --this.queuedScanLines;
  }
};
GameBoyCore.prototype.incrementScanLineQueue = function () {
  if (this.queuedScanLines < 144) {
    ++this.queuedScanLines;
  } else {
    this.currentX = 0;
    this.midScanlineOffset = -1;
    if (this.lastUnrenderedLine < 143) {
      ++this.lastUnrenderedLine;
    } else {
      this.lastUnrenderedLine = 0;
    }
  }
};
GameBoyCore.prototype.midScanLineJIT = function () {
  this.graphicsJIT();
  this.renderMidScanLine();
};
//Check for the highest priority IRQ to fire:
GameBoyCore.prototype.launchIRQ = function () {
  var bitShift = 0;
  var testbit = 1;
  do {
    //Check to see if an interrupt is enabled AND requested.
    if ((testbit & this.IRQLineMatched) === testbit) {
      this.IME = false; //Reset the interrupt enabling.
      this.interruptsRequested -= testbit; //Reset the interrupt request.
      this.IRQLineMatched = 0; //Reset the IRQ assertion.
      //Interrupts have a certain clock cycle length:
      this.CPUTicks = 20;
      //Set the stack pointer to the current program counter value:
      this.stackPointer = this.stackPointer - 1 & 0xffff;
      this.memoryWriter[this.stackPointer].apply(this, [this.stackPointer, this.programCounter >> 8]);
      this.stackPointer = this.stackPointer - 1 & 0xffff;
      this.memoryWriter[this.stackPointer].apply(this, [this.stackPointer, this.programCounter & 0xff]);
      //Set the program counter to the interrupt's address:
      this.programCounter = 0x40 | bitShift << 3;
      //Clock the core for mid-instruction updates:
      this.updateCore();
      return; //We only want the highest priority interrupt.
    }
    testbit = 1 << ++bitShift;
  } while (bitShift < 5);
};
/*
	Check for IRQs to be fired while not in HALT:
*/
GameBoyCore.prototype.checkIRQMatching = function () {
  if (this.IME) {
    this.IRQLineMatched = this.interruptsEnabled & this.interruptsRequested & 0x1f;
  }
};
/*
	Handle the HALT opcode by predicting all IRQ cases correctly,
	then selecting the next closest IRQ firing from the prediction to
	clock up to. This prevents hacky looping that doesn't predict, but
	instead just clocks through the core update procedure by one which
	is very slow. Not many emulators do this because they have to cover
	all the IRQ prediction cases and they usually get them wrong.
*/
GameBoyCore.prototype.calculateHALTPeriod = function () {
  //Initialize our variables and start our prediction:
  if (!this.halt) {
    this.halt = true;
    var currentClocks = -1;
    var temp_var = 0;
    if (this.LCDisOn) {
      //If the LCD is enabled, then predict the LCD IRQs enabled:
      if ((this.interruptsEnabled & 0x1) === 0x1) {
        currentClocks = 456 * ((this.modeSTAT === 1 ? 298 : 144) - this.actualScanLine) - this.LCDTicks << this.doubleSpeedShifter;
      }
      if ((this.interruptsEnabled & 0x2) === 0x2) {
        if (this.mode0TriggerSTAT) {
          temp_var = this.clocksUntilMode0() - this.LCDTicks << this.doubleSpeedShifter;
          if (temp_var <= currentClocks || currentClocks === -1) {
            currentClocks = temp_var;
          }
        }
        if (this.mode1TriggerSTAT && (this.interruptsEnabled & 0x1) === 0) {
          temp_var = 456 * ((this.modeSTAT === 1 ? 298 : 144) - this.actualScanLine) - this.LCDTicks << this.doubleSpeedShifter;
          if (temp_var <= currentClocks || currentClocks === -1) {
            currentClocks = temp_var;
          }
        }
        if (this.mode2TriggerSTAT) {
          temp_var = (this.actualScanLine >= 143 ? 456 * (154 - this.actualScanLine) : 456) - this.LCDTicks << this.doubleSpeedShifter;
          if (temp_var <= currentClocks || currentClocks === -1) {
            currentClocks = temp_var;
          }
        }
        if (this.LYCMatchTriggerSTAT && this.memory[0xff45] <= 153) {
          temp_var = this.clocksUntilLYCMatch() - this.LCDTicks << this.doubleSpeedShifter;
          if (temp_var <= currentClocks || currentClocks === -1) {
            currentClocks = temp_var;
          }
        }
      }
    }
    if (this.TIMAEnabled && (this.interruptsEnabled & 0x4) === 0x4) {
      //CPU timer IRQ prediction:
      temp_var = (0x100 - this.memory[0xff05]) * this.TACClocker - this.timerTicks;
      if (temp_var <= currentClocks || currentClocks === -1) {
        currentClocks = temp_var;
      }
    }
    if (this.serialTimer > 0 && (this.interruptsEnabled & 0x8) === 0x8) {
      //Serial IRQ prediction:
      if (this.serialTimer <= currentClocks || currentClocks === -1) {
        currentClocks = this.serialTimer;
      }
    }
  } else {
    var currentClocks = this.remainingClocks;
  }
  var maxClocks = this.cpu.cyclesTotal - this.cpu.ticks << this.doubleSpeedShifter;
  if (currentClocks >= 0) {
    if (currentClocks <= maxClocks) {
      //Exit out of HALT normally:
      this.CPUTicks = Math.max(currentClocks, this.CPUTicks);
      this.updateCoreFull();
      this.halt = false;
      this.CPUTicks = 0;
    } else {
      //Still in HALT, clock only up to the clocks specified per iteration:
      this.CPUTicks = Math.max(maxClocks, this.CPUTicks);
      this.remainingClocks = currentClocks - this.CPUTicks;
    }
  } else {
    //Still in HALT, clock only up to the clocks specified per iteration:
    //Will stay in HALT forever (Stuck in HALT forever), but the APU and LCD are still clocked, so don't pause:
    this.CPUTicks += maxClocks;
  }
};
//Memory Reading:
GameBoyCore.prototype.memoryRead = function (address) {
  //Act as a wrapper for reading the returns from the compiled jumps to memory.
  return this.memoryReader[address].apply(this, [address]); //This seems to be faster than the usual if/else.
};
GameBoyCore.prototype.memoryHighRead = function (address) {
  //Act as a wrapper for reading the returns from the compiled jumps to memory.
  return this.memoryHighReader[address].apply(this, [address]); //This seems to be faster than the usual if/else.
};
GameBoyCore.prototype.memoryReadJumpCompile = function () {
  //Faster in some browsers, since we are doing less conditionals overall by implementing them in advance.
  for (let index = 0x0000; index <= 0xffff; index++) {
    if (index < 0x4000) {
      this.memoryReader[index] = this.memoryReadNormal;
    } else if (index < 0x8000) {
      this.memoryReader[index] = this.memoryReadROM;
    } else if (index < 0x9800) {
      this.memoryReader[index] = this.cartridgeSlot.cartridge.useGBCMode ? this.VRAMDATAReadCGBCPU : this.VRAMDATAReadDMGCPU;
    } else if (index < 0xa000) {
      this.memoryReader[index] = this.cartridgeSlot.cartridge.useGBCMode ? this.VRAMCHRReadCGBCPU : this.VRAMCHRReadDMGCPU;
    } else if (index >= 0xa000 && index < 0xc000) {
      if (this.cartridgeSlot.cartridge.ramSize !== 0) {
        if (this.cartridgeSlot.cartridge.hasMBC7) {
          this.memoryReader[index] = this.memoryReadMBC7;
        } else if (!this.cartridgeSlot.cartridge.hasMBC3) {
          this.memoryReader[index] = this.memoryReadMBC;
        } else {
          //MBC3 RTC + RAM:
          this.memoryReader[index] = this.memoryReadMBC3;
        }
      } else {
        this.memoryReader[index] = this.memoryReadBAD;
      }
    } else if (index >= 0xc000 && index < 0xe000) {
      if (!this.cartridgeSlot.cartridge.useGBCMode || index < 0xd000) {
        this.memoryReader[index] = this.memoryReadNormal;
      } else {
        this.memoryReader[index] = this.memoryReadGBCMemory;
      }
    } else if (index >= 0xe000 && index < 0xfe00) {
      if (!this.cartridgeSlot.cartridge.useGBCMode || index < 0xf000) {
        this.memoryReader[index] = this.memoryReadECHONormal;
      } else {
        this.memoryReader[index] = this.memoryReadECHOGBCMemory;
      }
    } else if (index < 0xfea0) {
      this.memoryReader[index] = this.memoryReadOAM;
    } else if (this.cartridgeSlot.cartridge.useGBCMode && index >= 0xfea0 && index < 0xff00) {
      this.memoryReader[index] = this.memoryReadNormal;
    } else if (index >= 0xff00) {
      switch (index) {
      case 0xff00:
        //JOYPAD:
        this.memoryHighReader[0] = this.memoryReader[0xff00] = address => {
          return 0xc0 | this.memory[0xff00]; // top nibble returns as set.
        };
        break;
      case 0xff01:
        //SB
        this.memoryHighReader[0x01] = this.memoryReader[0xff01] = address => {
          return this.memory[0xff02] < 0x80 ? this.memory[0xff01] : 0xff;
        };
        break;
      case 0xff02:
        //SC
        if (this.cartridgeSlot.cartridge.useGBCMode) {
          this.memoryHighReader[0x02] = this.memoryReader[0xff02] = address => {
            return (this.serialTimer <= 0 ? 0x7c : 0xfc) | this.memory[0xff02];
          };
        } else {
          this.memoryHighReader[0x02] = this.memoryReader[0xff02] = address => {
            return (this.serialTimer <= 0 ? 0x7e : 0xfe) | this.memory[0xff02];
          };
        }
        break;
      case 0xff03:
        this.memoryHighReader[0x03] = this.memoryReader[0xff03] = this.memoryReadBAD;
        break;
      case 0xff04:
        //DIV
        this.memoryHighReader[0x04] = this.memoryReader[0xff04] = address => {
          this.memory[0xff04] = this.memory[0xff04] + (this.DIVTicks >> 8) & 0xff;
          this.DIVTicks &= 0xff;
          return this.memory[0xff04];
        };
        break;
      case 0xff05:
      case 0xff06:
        this.memoryHighReader[index & 0xff] = this.memoryHighReadNormal;
        this.memoryReader[index] = this.memoryReadNormal;
        break;
      case 0xff07:
        this.memoryHighReader[0x07] = this.memoryReader[0xff07] = address => {
          return 0xf8 | this.memory[0xff07];
        };
        break;
      case 0xff08:
      case 0xff09:
      case 0xff0a:
      case 0xff0b:
      case 0xff0c:
      case 0xff0d:
      case 0xff0e:
        this.memoryHighReader[index & 0xff] = this.memoryReader[index] = this.memoryReadBAD;
        break;
      case 0xff0f:
        //IF
        this.memoryHighReader[0x0f] = this.memoryReader[0xff0f] = address => {
          return 0xe0 | this.interruptsRequested;
        };
        break;
      case 0xff10:
        this.memoryHighReader[0x10] = this.memoryReader[0xff10] = address => {
          return 0x80 | this.memory[0xff10];
        };
        break;
      case 0xff11:
        this.memoryHighReader[0x11] = this.memoryReader[0xff11] = address => {
          return 0x3f | this.memory[0xff11];
        };
        break;
      case 0xff12:
        this.memoryHighReader[0x12] = this.memoryHighReadNormal;
        this.memoryReader[0xff12] = this.memoryReadNormal;
        break;
      case 0xff13:
        this.memoryHighReader[0x13] = this.memoryReader[0xff13] = this.memoryReadBAD;
        break;
      case 0xff14:
        this.memoryHighReader[0x14] = this.memoryReader[0xff14] = address => {
          return 0xbf | this.memory[0xff14];
        };
        break;
      case 0xff15:
        this.memoryHighReader[0x15] = this.memoryReadBAD;
        this.memoryReader[0xff15] = this.memoryReadBAD;
        break;
      case 0xff16:
        this.memoryHighReader[0x16] = this.memoryReader[0xff16] = address => {
          return 0x3f | this.memory[0xff16];
        };
        break;
      case 0xff17:
        this.memoryHighReader[0x17] = this.memoryHighReadNormal;
        this.memoryReader[0xff17] = this.memoryReadNormal;
        break;
      case 0xff18:
        this.memoryHighReader[0x18] = this.memoryReader[0xff18] = this.memoryReadBAD;
        break;
      case 0xff19:
        this.memoryHighReader[0x19] = this.memoryReader[0xff19] = address => {
          return 0xbf | this.memory[0xff19];
        };
        break;
      case 0xff1a:
        this.memoryHighReader[0x1a] = this.memoryReader[0xff1a] = address => {
          return 0x7f | this.memory[0xff1a];
        };
        break;
      case 0xff1b:
        this.memoryHighReader[0x1b] = this.memoryReader[0xff1b] = this.memoryReadBAD;
        break;
      case 0xff1c:
        this.memoryHighReader[0x1c] = this.memoryReader[0xff1c] = address => {
          return 0x9f | this.memory[0xff1c];
        };
        break;
      case 0xff1d:
        this.memoryHighReader[0x1d] = this.memoryReader[0xff1d] = this.memoryReadBAD;
        break;
      case 0xff1e:
        this.memoryHighReader[0x1e] = this.memoryReader[0xff1e] = address => {
          return 0xbf | this.memory[0xff1e];
        };
        break;
      case 0xff1f:
      case 0xff20:
        this.memoryHighReader[index & 0xff] = this.memoryReader[index] = this.memoryReadBAD;
        break;
      case 0xff21:
      case 0xff22:
        this.memoryHighReader[index & 0xff] = this.memoryHighReadNormal;
        this.memoryReader[index] = this.memoryReadNormal;
        break;
      case 0xff23:
        this.memoryHighReader[0x23] = this.memoryReader[0xff23] = address => {
          return 0xbf | this.memory[0xff23];
        };
        break;
      case 0xff24:
      case 0xff25:
        this.memoryHighReader[index & 0xff] = this.memoryHighReadNormal;
        this.memoryReader[index] = this.memoryReadNormal;
        break;
      case 0xff26:
        this.memoryHighReader[0x26] = this.memoryReader[0xff26] = address => {
          this.audioJIT();
          return 0x70 | this.memory[0xff26];
        };
        break;
      case 0xff27:
      case 0xff28:
      case 0xff29:
      case 0xff2a:
      case 0xff2b:
      case 0xff2c:
      case 0xff2d:
      case 0xff2e:
      case 0xff2f:
        this.memoryHighReader[index & 0xff] = this.memoryReader[index] = this.memoryReadBAD;
        break;
      case 0xff30:
      case 0xff31:
      case 0xff32:
      case 0xff33:
      case 0xff34:
      case 0xff35:
      case 0xff36:
      case 0xff37:
      case 0xff38:
      case 0xff39:
      case 0xff3a:
      case 0xff3b:
      case 0xff3c:
      case 0xff3d:
      case 0xff3e:
      case 0xff3f:
        this.memoryReader[index] = address => {
          return this.channel3canPlay ? this.memory[0xff00 | this.channel3lastSampleLookup >> 1] : this.memory[address];
        };
        this.memoryHighReader[index & 0xff] = address => {
          return this.channel3canPlay ? this.memory[0xff00 | this.channel3lastSampleLookup >> 1] : this.memory[0xff00 | address];
        };
        break;
      case 0xff40:
        this.memoryHighReader[0x40] = this.memoryHighReadNormal;
        this.memoryReader[0xff40] = this.memoryReadNormal;
        break;
      case 0xff41:
        this.memoryHighReader[0x41] = this.memoryReader[0xff41] = address => {
          return 0x80 | this.memory[0xff41] | this.modeSTAT;
        };
        break;
      case 0xff42:
        this.memoryHighReader[0x42] = this.memoryReader[0xff42] = address => {
          return this.backgroundY;
        };
        break;
      case 0xff43:
        this.memoryHighReader[0x43] = this.memoryReader[0xff43] = address => {
          return this.backgroundX;
        };
        break;
      case 0xff44:
        this.memoryHighReader[0x44] = this.memoryReader[0xff44] = address => {
          return this.LCDisOn ? this.memory[0xff44] : 0;
        };
        break;
      case 0xff45:
      case 0xff46:
      case 0xff47:
      case 0xff48:
      case 0xff49:
        this.memoryHighReader[index & 0xff] = this.memoryHighReadNormal;
        this.memoryReader[index] = this.memoryReadNormal;
        break;
      case 0xff4a:
        //WY
        this.memoryHighReader[0x4a] = this.memoryReader[0xff4a] = address => {
          return this.windowY;
        };
        break;
      case 0xff4b:
        this.memoryHighReader[0x4b] = this.memoryHighReadNormal;
        this.memoryReader[0xff4b] = this.memoryReadNormal;
        break;
      case 0xff4c:
        this.memoryHighReader[0x4c] = this.memoryReader[0xff4c] = this.memoryReadBAD;
        break;
      case 0xff4d:
        this.memoryHighReader[0x4d] = this.memoryHighReadNormal;
        this.memoryReader[0xff4d] = this.memoryReadNormal;
        break;
      case 0xff4e:
        this.memoryHighReader[0x4e] = this.memoryReader[0xff4e] = this.memoryReadBAD;
        break;
      case 0xff4f:
        this.memoryHighReader[0x4f] = this.memoryReader[0xff4f] = address => {
          return this.currVRAMBank;
        };
        break;
      case 0xff50:
      case 0xff51:
      case 0xff52:
      case 0xff53:
      case 0xff54:
        this.memoryHighReader[index & 0xff] = this.memoryHighReadNormal;
        this.memoryReader[index] = this.memoryReadNormal;
        break;
      case 0xff55:
        if (this.cartridgeSlot.cartridge.useGBCMode) {
          this.memoryHighReader[0x55] = this.memoryReader[0xff55] = address => {
            if (!this.LCDisOn && this.hdmaRunning) {
              //Undocumented behavior alert: HDMA becomes GDMA when LCD is off (Worms Armageddon Fix).
              //DMA
              this.DMAWrite((this.memory[0xff55] & 0x7f) + 1);
              this.memory[0xff55] = 0xff; //Transfer completed.
              this.hdmaRunning = false;
            }
            return this.memory[0xff55];
          };
        } else {
          this.memoryReader[0xff55] = this.memoryReadNormal;
          this.memoryHighReader[0x55] = this.memoryHighReadNormal;
        }
        break;
      case 0xff56:
        if (this.cartridgeSlot.cartridge.useGBCMode) {
          this.memoryHighReader[0x56] = this.memoryReader[0xff56] = address => {
            //Return IR "not connected" status:
            return 0x3c | (this.memory[0xff56] >= 0xc0 ? 0x2 | this.memory[0xff56] & 0xc1 : this.memory[0xff56] & 0xc3);
          };
        } else {
          this.memoryReader[0xff56] = this.memoryReadNormal;
          this.memoryHighReader[0x56] = this.memoryHighReadNormal;
        }
        break;
      case 0xff57:
      case 0xff58:
      case 0xff59:
      case 0xff5a:
      case 0xff5b:
      case 0xff5c:
      case 0xff5d:
      case 0xff5e:
      case 0xff5f:
      case 0xff60:
      case 0xff61:
      case 0xff62:
      case 0xff63:
      case 0xff64:
      case 0xff65:
      case 0xff66:
      case 0xff67:
        this.memoryHighReader[index & 0xff] = this.memoryReader[index] = this.memoryReadBAD;
        break;
      case 0xff68:
      case 0xff69:
      case 0xff6a:
      case 0xff6b:
        this.memoryHighReader[index & 0xff] = this.memoryHighReadNormal;
        this.memoryReader[index] = this.memoryReadNormal;
        break;
      case 0xff6c:
        if (this.cartridgeSlot.cartridge.useGBCMode) {
          this.memoryHighReader[0x6c] = this.memoryReader[0xff6c] = address => {
            return 0xfe | this.memory[0xff6c];
          };
        } else {
          this.memoryHighReader[0x6c] = this.memoryReader[0xff6c] = this.memoryReadBAD;
        }
        break;
      case 0xff6d:
      case 0xff6e:
      case 0xff6f:
        this.memoryHighReader[index & 0xff] = this.memoryReader[index] = this.memoryReadBAD;
        break;
      case 0xff70:
        if (this.cartridgeSlot.cartridge.useGBCMode) {
          //SVBK
          this.memoryHighReader[0x70] = this.memoryReader[0xff70] = address => {
            return 0x40 | this.memory[0xff70];
          };
        } else {
          this.memoryHighReader[0x70] = this.memoryReader[0xff70] = this.memoryReadBAD;
        }
        break;
      case 0xff71:
        this.memoryHighReader[0x71] = this.memoryReader[0xff71] = this.memoryReadBAD;
        break;
      case 0xff72:
      case 0xff73:
        this.memoryHighReader[index & 0xff] = this.memoryReader[index] = this.memoryReadNormal;
        break;
      case 0xff74:
        if (this.cartridgeSlot.cartridge.useGBCMode) {
          this.memoryHighReader[0x74] = this.memoryReader[0xff74] = this.memoryReadNormal;
        } else {
          this.memoryHighReader[0x74] = this.memoryReader[0xff74] = this.memoryReadBAD;
        }
        break;
      case 0xff75:
        this.memoryHighReader[0x75] = this.memoryReader[0xff75] = address => {
          return 0x8f | this.memory[0xff75];
        };
        break;
      case 0xff76:
        //Undocumented realtime PCM amplitude readback:
        this.memoryHighReader[0x76] = this.memoryReader[0xff76] = address => {
          this.audioJIT();
          return this.channel2envelopeVolume << 4 | this.channel1envelopeVolume;
        };
        break;
      case 0xff77:
        //Undocumented realtime PCM amplitude readback:
        this.memoryHighReader[0x77] = this.memoryReader[0xff77] = address => {
          this.audioJIT();
          return this.channel4envelopeVolume << 4 | this.channel3envelopeVolume;
        };
        break;
      case 0xff78:
      case 0xff79:
      case 0xff7a:
      case 0xff7b:
      case 0xff7c:
      case 0xff7d:
      case 0xff7e:
      case 0xff7f:
        this.memoryHighReader[index & 0xff] = this.memoryReader[index] = this.memoryReadBAD;
        break;
      case 0xffff:
        //IE
        this.memoryHighReader[0xff] = this.memoryReader[0xffff] = address => {
          return this.interruptsEnabled;
        };
        break;
      default:
        this.memoryReader[index] = this.memoryReadNormal;
        this.memoryHighReader[index & 0xff] = this.memoryHighReadNormal;
      }
    } else {
      this.memoryReader[index] = this.memoryReadBAD;
    }
  }
};
GameBoyCore.prototype.memoryReadNormal = function (address) {
  return this.memory[address];
};
GameBoyCore.prototype.memoryHighReadNormal = function (address) {
  return this.memory[0xff00 | address];
};
GameBoyCore.prototype.memoryReadROM = function (address) {
  return this.cartridgeSlot.cartridge.rom.getByte(
    this.cartridgeSlot.cartridge.mbc.currentROMBank + address
  );
};
GameBoyCore.prototype.memoryReadMBC = function (address) {
  return this.cartridgeSlot.cartridge.mbc.readRAM(address);
};
GameBoyCore.prototype.memoryReadMBC7 = function (address) {
  return this.cartridgeSlot.cartridge.mbc.readRAM(address);
};
GameBoyCore.prototype.memoryReadMBC3 = function (address) {
  return this.cartridgeSlot.cartridge.mbc.readRAM(address);
};
GameBoyCore.prototype.memoryReadGBCMemory = function (address) {
  return this.GBCMemory[address + this.gbcRamBankPosition];
};
GameBoyCore.prototype.memoryReadOAM = function (address) {
  return this.modeSTAT > 1 ? 0xff : this.memory[address];
};
GameBoyCore.prototype.memoryReadECHOGBCMemory = function (address) {
  return this.GBCMemory[address + this.gbcRamBankPositionECHO];
};
GameBoyCore.prototype.memoryReadECHONormal = function (address) {
  return this.memory[address - 0x2000];
};
GameBoyCore.prototype.memoryReadBAD = function (address) {
  return 0xff;
};
GameBoyCore.prototype.VRAMDATAReadCGBCPU = function (address) {
  // CPU Side Reading The VRAM (Optimized for GameBoy Color)
  return this.modeSTAT > 2 ?
    0xff :
    this.currVRAMBank === 0 ?
    this.memory[address] :
    this.VRAM[address & 0x1fff];
};
GameBoyCore.prototype.VRAMDATAReadDMGCPU = function (address) {
  // CPU Side Reading The VRAM (Optimized for classic GameBoy)
  return this.modeSTAT > 2 ? 0xff : this.memory[address];
};
GameBoyCore.prototype.VRAMCHRReadCGBCPU = function (address) {
  // CPU Side Reading the Character Data Map:
  return this.modeSTAT > 2 ? 0xff : this.BGCHRCurrentBank[address & 0x7ff];
};
GameBoyCore.prototype.VRAMCHRReadDMGCPU = function (address) {
  // CPU Side Reading the Character Data Map:
  return this.modeSTAT > 2 ? 0xff : this.BGCHRBank1[address & 0x7ff];
};
//Memory Writing:
GameBoyCore.prototype.memoryWrite = function (address, data) {
  //Act as a wrapper for writing by compiled jumps to specific memory writing functions.
  this.memoryWriter[address].apply(this, [address, data]);
};
//0xFFXX fast path:
GameBoyCore.prototype.memoryHighWrite = function (address, data) {
  //Act as a wrapper for writing by compiled jumps to specific memory writing functions.
  this.memoryHighWriter[address].apply(this, [address, data]);
};
GameBoyCore.prototype.memoryWriteJumpCompile = function () {
  //Faster in some browsers, since we are doing less conditionals overall by implementing them in advance.
  for (var index = 0x0000; index <= 0xffff; index++) {
    if (index < 0x8000) {
      if (this.cartridgeSlot.cartridge.hasMBC1) {
        if (index < 0x2000) {
          this.memoryWriter[index] = this.MBCWriteEnable;
        } else if (index < 0x4000) {
          this.memoryWriter[index] = this.MBC1WriteROMBank;
        } else if (index < 0x6000) {
          this.memoryWriter[index] = this.MBC1WriteRAMBank;
        } else {
          this.memoryWriter[index] = this.MBC1WriteType;
        }
      } else if (this.cartridgeSlot.cartridge.hasMBC2) {
        if (index < 0x1000) {
          this.memoryWriter[index] = this.MBCWriteEnable;
        } else if (index >= 0x2100 && index < 0x2200) {
          this.memoryWriter[index] = this.MBC2WriteROMBank;
        } else {
          this.memoryWriter[index] = this.cartIgnoreWrite;
        }
      } else if (this.cartridgeSlot.cartridge.hasMBC3) {
        if (index < 0x2000) {
          this.memoryWriter[index] = this.MBCWriteEnable;
        } else if (index < 0x4000) {
          this.memoryWriter[index] = this.MBC3WriteROMBank;
        } else if (index < 0x6000) {
          this.memoryWriter[index] = this.MBC3WriteRAMBank;
        } else {
          this.memoryWriter[index] = this.MBC3WriteRTCLatch;
        }
      } else if (
        this.cartridgeSlot.cartridge.hasMBC5 ||
        this.cartridgeSlot.cartridge.cRUMBLE ||
        this.cartridgeSlot.cartridge.hasMBC7
      ) {
        if (index < 0x2000) {
          this.memoryWriter[index] = this.MBCWriteEnable;
        } else if (index < 0x3000) {
          this.memoryWriter[index] = this.MBC5WriteROMBankLow;
        } else if (index < 0x4000) {
          this.memoryWriter[index] = this.MBC5WriteROMBankHigh;
        } else if (index < 0x6000) {
          this.memoryWriter[index] = this.cartridgeSlot.cartridge.cRUMBLE ?
            this.RUMBLEWriteRAMBank :
            this.MBC5WriteRAMBank;
        } else {
          this.memoryWriter[index] = this.cartIgnoreWrite;
        }
      } else if (this.cartridgeSlot.cartridge.cHuC3) {
        if (index < 0x2000) {
          this.memoryWriter[index] = this.MBCWriteEnable;
        } else if (index < 0x4000) {
          this.memoryWriter[index] = this.MBC3WriteROMBank;
        } else if (index < 0x6000) {
          this.memoryWriter[index] = this.HuC3WriteRAMBank;
        } else {
          this.memoryWriter[index] = this.cartIgnoreWrite;
        }
      } else {
        this.memoryWriter[index] = this.cartIgnoreWrite;
      }
    } else if (index < 0x9000) {
      this.memoryWriter[index] = this.cartridgeSlot.cartridge.useGBCMode ?
        this.VRAMGBCDATAWrite :
        this.VRAMGBDATAWrite;
    } else if (index < 0x9800) {
      this.memoryWriter[index] = this.cartridgeSlot.cartridge.useGBCMode ?
        this.VRAMGBCDATAWrite :
        this.VRAMGBDATAUpperWrite;
    } else if (index < 0xa000) {
      this.memoryWriter[index] = this.cartridgeSlot.cartridge.useGBCMode ?
        this.VRAMGBCCHRMAPWrite :
        this.VRAMGBCHRMAPWrite;
    } else if (index < 0xc000) {
      if (this.cartridgeSlot.cartridge.ramSize !== 0) {
        if (!this.cartridgeSlot.cartridge.hasMBC3) {
          this.memoryWriter[index] = this.memoryWriteMBCRAM;
        } else {
          //MBC3 RTC + RAM:
          this.memoryWriter[index] = this.memoryWriteMBC3RAM;
        }
      } else {
        this.memoryWriter[index] = this.cartIgnoreWrite;
      }
    } else if (index < 0xe000) {
      if (this.cartridgeSlot.cartridge.useGBCMode && index >= 0xd000) {
        this.memoryWriter[index] = this.memoryWriteGBCRAM;
      } else {
        this.memoryWriter[index] = this.memoryWriteNormal;
      }
    } else if (index < 0xfe00) {
      if (this.cartridgeSlot.cartridge.useGBCMode && index >= 0xf000) {
        this.memoryWriter[index] = this.memoryWriteECHOGBCRAM;
      } else {
        this.memoryWriter[index] = this.memoryWriteECHONormal;
      }
    } else if (index <= 0xfea0) {
      this.memoryWriter[index] = this.memoryWriteOAMRAM;
    } else if (index < 0xff00) {
      if (this.cartridgeSlot.cartridge.useGBCMode) {
        //Only GBC has access to this RAM.
        this.memoryWriter[index] = this.memoryWriteNormal;
      } else {
        this.memoryWriter[index] = this.cartIgnoreWrite;
      }
    } else {
      //Start the I/O initialization by filling in the slots as normal memory:
      this.memoryWriter[index] = this.memoryWriteNormal;
      this.memoryHighWriter[index & 0xff] = this.memoryHighWriteNormal;
    }
  }
  this.registerWriteJumpCompile(); //Compile the I/O write functions separately...
};
GameBoyCore.prototype.MBCWriteEnable = function (address, data) {
  this.cartridgeSlot.cartridge.mbc.writeEnable(address, data);
};
GameBoyCore.prototype.MBC1WriteROMBank = function (address, data) {
  this.cartridgeSlot.cartridge.mbc.writeROMBank(address, data);
};
GameBoyCore.prototype.MBC1WriteRAMBank = function (address, data) {
  this.cartridgeSlot.cartridge.mbc.writeRAMBank(address, data);
};
GameBoyCore.prototype.MBC1WriteType = function (address, data) {
  this.cartridgeSlot.cartridge.mbc.writeType(address, data);
};
GameBoyCore.prototype.MBC2WriteROMBank = function (address, data) {
  this.cartridgeSlot.cartridge.mbc.writeROMBank(address, data);
};
GameBoyCore.prototype.MBC3WriteROMBank = function (address, data) {
  return this.cartridgeSlot.cartridge.mbc.writeROMBank(address, data);
};
GameBoyCore.prototype.MBC3WriteRAMBank = function (address, data) {
  return this.cartridgeSlot.cartridge.mbc.writeRAMBank(address, data);
};
GameBoyCore.prototype.MBC3WriteRTCLatch = function (address, data) {
  return this.cartridgeSlot.cartridge.mbc.rtc.writeLatch(address, data);
};
GameBoyCore.prototype.MBC5WriteROMBankLow = function (address, data) {
  return this.cartridgeSlot.cartridge.mbc.writeROMBankLow(address, data);
};
GameBoyCore.prototype.MBC5WriteROMBankHigh = function (address, data) {
  return this.cartridgeSlot.cartridge.mbc.writeROMBankHigh(address, data);
};
GameBoyCore.prototype.MBC5WriteRAMBank = function (address, data) {
  return this.cartridgeSlot.cartridge.mbc.writeRAMBank(address, data);
};
GameBoyCore.prototype.RUMBLEWriteRAMBank = function (address, data) {
  //MBC5 RAM bank switching
  //Like MBC5, but bit 3 of the lower nibble is used for rumbling and bit 2 is ignored.
  this.cartridgeSlot.cartridge.mbc.currentMBCRAMBank = data & 0x03;
  this.cartridgeSlot.cartridge.mbc.currentRAMBankPosition = (
    this.cartridgeSlot.cartridge.mbc.currentMBCRAMBank << 13
  ) - 0xa000;
};
GameBoyCore.prototype.HuC3WriteRAMBank = function (address, data) {
  //HuC3 RAM bank switching
  this.cartridgeSlot.cartridge.mbc.currentMBCRAMBank = data & 0x03;
  this.cartridgeSlot.cartridge.mbc.currentRAMBankPosition = (
    this.cartridgeSlot.cartridge.mbc.currentMBCRAMBank << 13
  ) - 0xa000;
};
GameBoyCore.prototype.cartIgnoreWrite = function (address, data) {
  //We might have encountered illegal RAM writing or such, so just do nothing...
};
GameBoyCore.prototype.memoryWriteNormal = function (address, data) {
  this.memory[address] = data;
};
GameBoyCore.prototype.memoryHighWriteNormal = function (address, data) {
  this.memory[0xff00 | address] = data;
};
GameBoyCore.prototype.memoryWriteMBCRAM = function (address, data) {
  this.cartridgeSlot.cartridge.mbc.writeRAM(address, data);
};
GameBoyCore.prototype.memoryWriteMBC3RAM = function (address, data) {
  return this.cartridgeSlot.cartridge.mbc.writeRAM(address, data);
};
GameBoyCore.prototype.memoryWriteGBCRAM = function (address, data) {
  this.GBCMemory[address + this.gbcRamBankPosition] = data;
};
GameBoyCore.prototype.memoryWriteOAMRAM = function (address, data) {
  if (this.modeSTAT < 2) {
    //OAM RAM cannot be written to in mode 2 & 3
    if (this.memory[address] != data) {
      this.graphicsJIT();
      this.memory[address] = data;
    }
  }
};
GameBoyCore.prototype.memoryWriteECHOGBCRAM = function (address, data) {
  this.GBCMemory[address + this.gbcRamBankPositionECHO] = data;
};
GameBoyCore.prototype.memoryWriteECHONormal = function (address, data) {
  this.memory[address - 0x2000] = data;
};
GameBoyCore.prototype.VRAMGBDATAWrite = function (address, data) {
  if (this.modeSTAT < 3) {
    //VRAM cannot be written to during mode 3
    if (this.memory[address] != data) {
      //JIT the graphics render queue:
      this.graphicsJIT();
      this.memory[address] = data;
      this.generateGBOAMTileLine(address);
    }
  }
};
GameBoyCore.prototype.VRAMGBDATAUpperWrite = function (address, data) {
  if (this.modeSTAT < 3) {
    //VRAM cannot be written to during mode 3
    if (this.memory[address] != data) {
      //JIT the graphics render queue:
      this.graphicsJIT();
      this.memory[address] = data;
      this.generateGBTileLine(address);
    }
  }
};
GameBoyCore.prototype.VRAMGBCDATAWrite = function (address, data) {
  if (this.modeSTAT < 3) {
    //VRAM cannot be written to during mode 3
    if (this.currVRAMBank === 0) {
      if (this.memory[address] != data) {
        //JIT the graphics render queue:
        this.graphicsJIT();
        this.memory[address] = data;
        this.generateGBCTileLineBank1(address);
      }
    } else {
      address &= 0x1fff;
      if (this.VRAM[address] != data) {
        //JIT the graphics render queue:
        this.graphicsJIT();
        this.VRAM[address] = data;
        this.generateGBCTileLineBank2(address);
      }
    }
  }
};
GameBoyCore.prototype.VRAMGBCHRMAPWrite = function (address, data) {
  if (this.modeSTAT < 3) {
    //VRAM cannot be written to during mode 3
    address &= 0x7ff;
    if (this.BGCHRBank1[address] != data) {
      //JIT the graphics render queue:
      this.graphicsJIT();
      this.BGCHRBank1[address] = data;
    }
  }
};
GameBoyCore.prototype.VRAMGBCCHRMAPWrite = function (address, data) {
  if (this.modeSTAT < 3) {
    //VRAM cannot be written to during mode 3
    address &= 0x7ff;
    if (this.BGCHRCurrentBank[address] != data) {
      //JIT the graphics render queue:
      this.graphicsJIT();
      this.BGCHRCurrentBank[address] = data;
    }
  }
};
GameBoyCore.prototype.DMAWrite = function (tilesToTransfer) {
  if (!this.halt) {
    //Clock the CPU for the DMA transfer (CPU is halted during the transfer):
    this.CPUTicks += 4 | tilesToTransfer << 5 << this.doubleSpeedShifter;
  }
  //Source address of the transfer:
  var source = this.memory[0xff51] << 8 | this.memory[0xff52];
  //Destination address in the VRAM memory range:
  var destination = this.memory[0xff53] << 8 | this.memory[0xff54];
  //Creating some references:
  var memoryReader = this.memoryReader;
  //JIT the graphics render queue:
  this.graphicsJIT();
  var memory = this.memory;
  //Determining which bank we're working on so we can optimize:
  if (this.currVRAMBank === 0) {
    //DMA transfer for VRAM bank 0:
    do {
      if (destination < 0x1800) {
        memory[0x8000 | destination] = memoryReader[source].apply(this, [source++]);
        memory[0x8001 | destination] = memoryReader[source].apply(this, [source++]);
        memory[0x8002 | destination] = memoryReader[source].apply(this, [source++]);
        memory[0x8003 | destination] = memoryReader[source].apply(this, [source++]);
        memory[0x8004 | destination] = memoryReader[source].apply(this, [source++]);
        memory[0x8005 | destination] = memoryReader[source].apply(this, [source++]);
        memory[0x8006 | destination] = memoryReader[source].apply(this, [source++]);
        memory[0x8007 | destination] = memoryReader[source].apply(this, [source++]);
        memory[0x8008 | destination] = memoryReader[source].apply(this, [source++]);
        memory[0x8009 | destination] = memoryReader[source].apply(this, [source++]);
        memory[0x800a | destination] = memoryReader[source].apply(this, [source++]);
        memory[0x800b | destination] = memoryReader[source].apply(this, [source++]);
        memory[0x800c | destination] = memoryReader[source].apply(this, [source++]);
        memory[0x800d | destination] = memoryReader[source].apply(this, [source++]);
        memory[0x800e | destination] = memoryReader[source].apply(this, [source++]);
        memory[0x800f | destination] = memoryReader[source].apply(this, [source++]);
        this.generateGBCTileBank1(destination);
        destination += 0x10;
      } else {
        destination &= 0x7f0;
        this.BGCHRBank1[destination++] = memoryReader[source].apply(this, [source++]);
        this.BGCHRBank1[destination++] = memoryReader[source].apply(this, [source++]);
        this.BGCHRBank1[destination++] = memoryReader[source].apply(this, [source++]);
        this.BGCHRBank1[destination++] = memoryReader[source].apply(this, [source++]);
        this.BGCHRBank1[destination++] = memoryReader[source].apply(this, [source++]);
        this.BGCHRBank1[destination++] = memoryReader[source].apply(this, [source++]);
        this.BGCHRBank1[destination++] = memoryReader[source].apply(this, [source++]);
        this.BGCHRBank1[destination++] = memoryReader[source].apply(this, [source++]);
        this.BGCHRBank1[destination++] = memoryReader[source].apply(this, [source++]);
        this.BGCHRBank1[destination++] = memoryReader[source].apply(this, [source++]);
        this.BGCHRBank1[destination++] = memoryReader[source].apply(this, [source++]);
        this.BGCHRBank1[destination++] = memoryReader[source].apply(this, [source++]);
        this.BGCHRBank1[destination++] = memoryReader[source].apply(this, [source++]);
        this.BGCHRBank1[destination++] = memoryReader[source].apply(this, [source++]);
        this.BGCHRBank1[destination++] = memoryReader[source].apply(this, [source++]);
        this.BGCHRBank1[destination++] = memoryReader[source].apply(this, [source++]);
        destination = destination + 0x1800 & 0x1ff0;
      }
      source &= 0xfff0;
      --tilesToTransfer;
    } while (tilesToTransfer > 0);
  } else {
    var VRAM = this.VRAM;
    //DMA transfer for VRAM bank 1:
    do {
      if (destination < 0x1800) {
        VRAM[destination] = memoryReader[source].apply(this, [source++]);
        VRAM[destination | 0x1] = memoryReader[source].apply(this, [source++]);
        VRAM[destination | 0x2] = memoryReader[source].apply(this, [source++]);
        VRAM[destination | 0x3] = memoryReader[source].apply(this, [source++]);
        VRAM[destination | 0x4] = memoryReader[source].apply(this, [source++]);
        VRAM[destination | 0x5] = memoryReader[source].apply(this, [source++]);
        VRAM[destination | 0x6] = memoryReader[source].apply(this, [source++]);
        VRAM[destination | 0x7] = memoryReader[source].apply(this, [source++]);
        VRAM[destination | 0x8] = memoryReader[source].apply(this, [source++]);
        VRAM[destination | 0x9] = memoryReader[source].apply(this, [source++]);
        VRAM[destination | 0xa] = memoryReader[source].apply(this, [source++]);
        VRAM[destination | 0xb] = memoryReader[source].apply(this, [source++]);
        VRAM[destination | 0xc] = memoryReader[source].apply(this, [source++]);
        VRAM[destination | 0xd] = memoryReader[source].apply(this, [source++]);
        VRAM[destination | 0xe] = memoryReader[source].apply(this, [source++]);
        VRAM[destination | 0xf] = memoryReader[source].apply(this, [source++]);
        this.generateGBCTileBank2(destination);
        destination += 0x10;
      } else {
        destination &= 0x7f0;
        this.BGCHRBank2[destination++] = memoryReader[source].apply(this, [source++]);
        this.BGCHRBank2[destination++] = memoryReader[source].apply(this, [source++]);
        this.BGCHRBank2[destination++] = memoryReader[source].apply(this, [source++]);
        this.BGCHRBank2[destination++] = memoryReader[source].apply(this, [source++]);
        this.BGCHRBank2[destination++] = memoryReader[source].apply(this, [source++]);
        this.BGCHRBank2[destination++] = memoryReader[source].apply(this, [source++]);
        this.BGCHRBank2[destination++] = memoryReader[source].apply(this, [source++]);
        this.BGCHRBank2[destination++] = memoryReader[source].apply(this, [source++]);
        this.BGCHRBank2[destination++] = memoryReader[source].apply(this, [source++]);
        this.BGCHRBank2[destination++] = memoryReader[source].apply(this, [source++]);
        this.BGCHRBank2[destination++] = memoryReader[source].apply(this, [source++]);
        this.BGCHRBank2[destination++] = memoryReader[source].apply(this, [source++]);
        this.BGCHRBank2[destination++] = memoryReader[source].apply(this, [source++]);
        this.BGCHRBank2[destination++] = memoryReader[source].apply(this, [source++]);
        this.BGCHRBank2[destination++] = memoryReader[source].apply(this, [source++]);
        this.BGCHRBank2[destination++] = memoryReader[source].apply(this, [source++]);
        destination = destination + 0x1800 & 0x1ff0;
      }
      source &= 0xfff0;
      --tilesToTransfer;
    } while (tilesToTransfer > 0);
  }
  // Update the HDMA registers to their next addresses:
  memory[0xff51] = source >> 8;
  memory[0xff52] = source & 0xf0;
  memory[0xff53] = destination >> 8;
  memory[0xff54] = destination & 0xf0;
};
GameBoyCore.prototype.registerWriteJumpCompile = function () {
  //I/O Registers (GB + GBC):
  //JoyPad
  this.memoryHighWriter[0] = this.memoryWriter[0xff00] = (address, data) => {
    this.memory[0xff00] = data & 0x30 |
      ((data & 0x20) === 0 ? this.joypad.value >> 4 : 0xf) &
      ((data & 0x10) === 0 ? this.joypad.value & 0xf : 0xf);
  };
  //SB (Serial Transfer Data)
  this.memoryHighWriter[0x1] = this.memoryWriter[0xff01] = (address, data) => {
    if (this.memory[0xff02] < 0x80) {
      //Cannot write while a serial transfer is active.
      this.memory[0xff01] = data;
    }
  };
  //SC (Serial Transfer Control):
  this.memoryHighWriter[0x2] = this.memoryHighWriteNormal;
  this.memoryWriter[0xff02] = this.memoryWriteNormal;
  //Unmapped I/O:
  this.memoryHighWriter[0x3] = this.memoryWriter[0xff03] = this.cartIgnoreWrite;
  //DIV
  this.memoryHighWriter[0x4] = this.memoryWriter[0xff04] = (address, data) => {
    this.DIVTicks &= 0xff; //Update DIV for realignment.
    this.memory[0xff04] = 0;
  };
  //TIMA
  this.memoryHighWriter[0x5] = this.memoryWriter[0xff05] = (address, data) => {
    this.memory[0xff05] = data;
  };
  //TMA
  this.memoryHighWriter[0x6] = this.memoryWriter[0xff06] = (address, data) => {
    this.memory[0xff06] = data;
  };
  //TAC
  this.memoryHighWriter[0x7] = this.memoryWriter[0xff07] = (address, data) => {
    this.memory[0xff07] = data & 0x07;
    this.TIMAEnabled = (data & 0x04) === 0x04;
    this.TACClocker = Math.pow(4, (data & 0x3) != 0 ? data & 0x3 : 4) << 2; //TODO: Find a way to not make a conditional in here...
  };
  //Unmapped I/O:
  this.memoryHighWriter[0x8] = this.memoryWriter[0xff08] = this.cartIgnoreWrite;
  this.memoryHighWriter[0x9] = this.memoryWriter[0xff09] = this.cartIgnoreWrite;
  this.memoryHighWriter[0xa] = this.memoryWriter[0xff0a] = this.cartIgnoreWrite;
  this.memoryHighWriter[0xb] = this.memoryWriter[0xff0b] = this.cartIgnoreWrite;
  this.memoryHighWriter[0xc] = this.memoryWriter[0xff0c] = this.cartIgnoreWrite;
  this.memoryHighWriter[0xd] = this.memoryWriter[0xff0d] = this.cartIgnoreWrite;
  this.memoryHighWriter[0xe] = this.memoryWriter[0xff0e] = this.cartIgnoreWrite;
  //IF (Interrupt Request)
  this.memoryHighWriter[0xf] = this.memoryWriter[0xff0f] = (address, data) => {
    this.interruptsRequested = data;
    this.checkIRQMatching();
  };
  //NR10:
  this.memoryHighWriter[0x10] = this.memoryWriter[0xff10] = (address, data) => {
    if (this.soundMasterEnabled) {
      this.audioJIT();
      if (this.channel1decreaseSweep && (data & 0x08) === 0) {
        if (this.channel1Swept) {
          this.channel1SweepFault = true;
        }
      }
      this.channel1lastTimeSweep = (data & 0x70) >> 4;
      this.channel1frequencySweepDivider = data & 0x07;
      this.channel1decreaseSweep = (data & 0x08) === 0x08;
      this.memory[0xff10] = data;
      this.channel1EnableCheck();
    }
  };
  //NR11:
  this.memoryHighWriter[0x11] = this.memoryWriter[0xff11] = (address, data) => {
    if (this.soundMasterEnabled || !this.cartridgeSlot.cartridge.useGBCMode) {
      if (this.soundMasterEnabled) {
        this.audioJIT();
      } else {
        data &= 0x3f;
      }
      this.channel1CachedDuty = dutyLookup[data >> 6];
      this.channel1totalLength = 0x40 - (data & 0x3f);
      this.memory[0xff11] = data;
      this.channel1EnableCheck();
    }
  };
  //NR12:
  this.memoryHighWriter[0x12] = this.memoryWriter[0xff12] = (address, data) => {
    if (this.soundMasterEnabled) {
      this.audioJIT();
      if (this.channel1Enabled && this.channel1envelopeSweeps === 0) {
        //Zombie Volume PAPU Bug:
        if (((this.memory[0xff12] ^ data) & 0x8) === 0x8) {
          if ((this.memory[0xff12] & 0x8) === 0) {
            if ((this.memory[0xff12] & 0x7) === 0x7) {
              this.channel1envelopeVolume += 2;
            } else {
              ++this.channel1envelopeVolume;
            }
          }
          this.channel1envelopeVolume = 16 - this.channel1envelopeVolume & 0xf;
        } else if ((this.memory[0xff12] & 0xf) === 0x8) {
          this.channel1envelopeVolume = 1 + this.channel1envelopeVolume & 0xf;
        }
        this.channel1OutputLevelCache();
      }
      this.channel1envelopeType = (data & 0x08) === 0x08;
      this.memory[0xff12] = data;
      this.channel1VolumeEnableCheck();
    }
  };
  //NR13:
  this.memoryHighWriter[0x13] = this.memoryWriter[0xff13] = (address, data) => {
    if (this.soundMasterEnabled) {
      this.audioJIT();
      this.channel1frequency = this.channel1frequency & 0x700 | data;
      this.channel1FrequencyTracker = 0x800 - this.channel1frequency << 2;
    }
  };
  //NR14:
  this.memoryHighWriter[0x14] = this.memoryWriter[0xff14] = (address, data) => {
    if (this.soundMasterEnabled) {
      this.audioJIT();
      this.channel1consecutive = (data & 0x40) === 0x0;
      this.channel1frequency = (data & 0x7) << 8 | this.channel1frequency & 0xff;
      this.channel1FrequencyTracker = 0x800 - this.channel1frequency << 2;
      if (data > 0x7f) {
        //Reload 0xFF10:
        this.channel1timeSweep = this.channel1lastTimeSweep;
        this.channel1Swept = false;
        //Reload 0xFF12:
        var nr12 = this.memory[0xff12];
        this.channel1envelopeVolume = nr12 >> 4;
        this.channel1OutputLevelCache();
        this.channel1envelopeSweepsLast = (nr12 & 0x7) - 1;
        if (this.channel1totalLength === 0) {
          this.channel1totalLength = 0x40;
        }
        if (
          this.channel1lastTimeSweep > 0 ||
          this.channel1frequencySweepDivider > 0
        ) {
          this.memory[0xff26] |= 0x1;
        } else {
          this.memory[0xff26] &= 0xfe;
        }
        if ((data & 0x40) === 0x40) {
          this.memory[0xff26] |= 0x1;
        }
        this.channel1ShadowFrequency = this.channel1frequency;
        //Reset frequency overflow check + frequency sweep type check:
        this.channel1SweepFault = false;
        //Supposed to run immediately:
        this.channel1AudioSweepPerformDummy();
      }
      this.channel1EnableCheck();
      this.memory[0xff14] = data;
    }
  };
  //NR20 (Unused I/O):
  this.memoryHighWriter[0x15] = this.memoryWriter[
    0xff15
  ] = this.cartIgnoreWrite;
  //NR21:
  this.memoryHighWriter[0x16] = this.memoryWriter[0xff16] = (address, data) => {
    if (this.soundMasterEnabled || !this.cartridgeSlot.cartridge.useGBCMode) {
      if (this.soundMasterEnabled) {
        this.audioJIT();
      } else {
        data &= 0x3f;
      }
      this.channel2CachedDuty = dutyLookup[data >> 6];
      this.channel2totalLength = 0x40 - (data & 0x3f);
      this.memory[0xff16] = data;
      this.channel2EnableCheck();
    }
  };
  //NR22:
  this.memoryHighWriter[0x17] = this.memoryWriter[0xff17] = (address, data) => {
    if (this.soundMasterEnabled) {
      this.audioJIT();
      if (this.channel2Enabled && this.channel2envelopeSweeps === 0) {
        //Zombie Volume PAPU Bug:
        if (((this.memory[0xff17] ^ data) & 0x8) === 0x8) {
          if ((this.memory[0xff17] & 0x8) === 0) {
            if ((this.memory[0xff17] & 0x7) === 0x7) {
              this.channel2envelopeVolume += 2;
            } else {
              ++this.channel2envelopeVolume;
            }
          }
          this.channel2envelopeVolume = 16 - this.channel2envelopeVolume & 0xf;
        } else if ((this.memory[0xff17] & 0xf) === 0x8) {
          this.channel2envelopeVolume = 1 + this.channel2envelopeVolume & 0xf;
        }
        this.channel2OutputLevelCache();
      }
      this.channel2envelopeType = (data & 0x08) === 0x08;
      this.memory[0xff17] = data;
      this.channel2VolumeEnableCheck();
    }
  };
  //NR23:
  this.memoryHighWriter[0x18] = this.memoryWriter[0xff18] = (address, data) => {
    if (this.soundMasterEnabled) {
      this.audioJIT();
      this.channel2frequency = this.channel2frequency & 0x700 | data;
      this.channel2FrequencyTracker = 0x800 - this.channel2frequency << 2;
    }
  };
  //NR24:
  this.memoryHighWriter[0x19] = this.memoryWriter[0xff19] = (address, data) => {
    if (this.soundMasterEnabled) {
      this.audioJIT();
      if (data > 0x7f) {
        //Reload 0xFF17:
        var nr22 = this.memory[0xff17];
        this.channel2envelopeVolume = nr22 >> 4;
        this.channel2OutputLevelCache();
        this.channel2envelopeSweepsLast = (nr22 & 0x7) - 1;
        if (this.channel2totalLength === 0) {
          this.channel2totalLength = 0x40;
        }
        if ((data & 0x40) === 0x40) {
          this.memory[0xff26] |= 0x2;
        }
      }
      this.channel2consecutive = (data & 0x40) === 0x0;
      this.channel2frequency = (data & 0x7) << 8 | this.channel2frequency & 0xff;
      this.channel2FrequencyTracker = 0x800 - this.channel2frequency << 2;
      this.memory[0xff19] = data;
      this.channel2EnableCheck();
    }
  };
  //NR30:
  this.memoryHighWriter[0x1a] = this.memoryWriter[0xff1a] = (address, data) => {
    if (this.soundMasterEnabled) {
      this.audioJIT();
      if (!this.channel3canPlay && data >= 0x80) {
        this.channel3lastSampleLookup = 0;
        this.channel3UpdateCache();
      }
      this.channel3canPlay = data > 0x7f;
      if (this.channel3canPlay && this.memory[0xff1a] > 0x7f && !this.channel3consecutive) {
        this.memory[0xff26] |= 0x4;
      }
      this.memory[0xff1a] = data;
      //this.channel3EnableCheck();
    }
  };
  //NR31:
  this.memoryHighWriter[0x1b] = this.memoryWriter[0xff1b] = (address, data) => {
    if (this.soundMasterEnabled || !this.cartridgeSlot.cartridge.useGBCMode) {
      if (this.soundMasterEnabled) {
        this.audioJIT();
      }
      this.channel3totalLength = 0x100 - data;
      this.channel3EnableCheck();
    }
  };
  //NR32:
  this.memoryHighWriter[0x1c] = this.memoryWriter[0xff1c] = (address, data) => {
    if (this.soundMasterEnabled) {
      this.audioJIT();
      data &= 0x60;
      this.memory[0xff1c] = data;
      this.channel3patternType = data === 0 ? 4 : (data >> 5) - 1;
    }
  };
  //NR33:
  this.memoryHighWriter[0x1d] = this.memoryWriter[0xff1d] = (address, data) => {
    if (this.soundMasterEnabled) {
      this.audioJIT();
      this.channel3frequency = this.channel3frequency & 0x700 | data;
      this.channel3FrequencyPeriod = 0x800 - this.channel3frequency << 1;
    }
  };
  //NR34:
  this.memoryHighWriter[0x1e] = this.memoryWriter[0xff1e] = (address, data) => {
    if (this.soundMasterEnabled) {
      this.audioJIT();
      if (data > 0x7f) {
        if (this.channel3totalLength === 0) {
          this.channel3totalLength = 0x100;
        }
        this.channel3lastSampleLookup = 0;
        if ((data & 0x40) === 0x40) {
          this.memory[0xff26] |= 0x4;
        }
      }
      this.channel3consecutive = (data & 0x40) === 0x0;
      this.channel3frequency = (data & 0x7) << 8 | this.channel3frequency & 0xff;
      this.channel3FrequencyPeriod = 0x800 - this.channel3frequency << 1;
      this.memory[0xff1e] = data;
      this.channel3EnableCheck();
    }
  };
  //NR40 (Unused I/O):
  this.memoryHighWriter[0x1f] = this.memoryWriter[
    0xff1f
  ] = this.cartIgnoreWrite;
  //NR41:
  this.memoryHighWriter[0x20] = this.memoryWriter[0xff20] = (address, data) => {
    if (this.soundMasterEnabled || !this.cartridgeSlot.cartridge.useGBCMode) {
      if (this.soundMasterEnabled) {
        this.audioJIT();
      }
      this.channel4totalLength = 0x40 - (data & 0x3f);
      this.channel4EnableCheck();
    }
  };
  //NR42:
  this.memoryHighWriter[0x21] = this.memoryWriter[0xff21] = (address, data) => {
    if (this.soundMasterEnabled) {
      this.audioJIT();
      if (this.channel4Enabled && this.channel4envelopeSweeps === 0) {
        //Zombie Volume PAPU Bug:
        if (((this.memory[0xff21] ^ data) & 0x8) === 0x8) {
          if ((this.memory[0xff21] & 0x8) === 0) {
            if ((this.memory[0xff21] & 0x7) === 0x7) {
              this.channel4envelopeVolume += 2;
            } else {
              ++this.channel4envelopeVolume;
            }
          }
          this.channel4envelopeVolume = 16 - this.channel4envelopeVolume & 0xf;
        } else if ((this.memory[0xff21] & 0xf) === 0x8) {
          this.channel4envelopeVolume = 1 + this.channel4envelopeVolume & 0xf;
        }
        this.channel4currentVolume = this.channel4envelopeVolume << this.channel4VolumeShifter;
      }
      this.channel4envelopeType = (data & 0x08) === 0x08;
      this.memory[0xff21] = data;
      this.channel4UpdateCache();
      this.channel4VolumeEnableCheck();
    }
  };
  //NR43:
  this.memoryHighWriter[0x22] = this.memoryWriter[0xff22] = (address, data) => {
    if (this.soundMasterEnabled) {
      this.audioJIT();
      this.channel4FrequencyPeriod = Math.max((data & 0x7) << 4, 8) <<
        (data >> 4);
      var bitWidth = data & 0x8;
      if (
        bitWidth === 0x8 && this.channel4BitRange === 0x7fff ||
        bitWidth === 0 && this.channel4BitRange === 0x7f
      ) {
        this.channel4lastSampleLookup = 0;
        this.channel4BitRange = bitWidth === 0x8 ? 0x7f : 0x7fff;
        this.channel4VolumeShifter = bitWidth === 0x8 ? 7 : 15;
        this.channel4currentVolume = this.channel4envelopeVolume <<
          this.channel4VolumeShifter;
        this.noiseSampleTable = bitWidth === 0x8 ?
          this.LSFR7Table :
          this.LSFR15Table;
      }
      this.memory[0xff22] = data;
      this.channel4UpdateCache();
    }
  };
  //NR44:
  this.memoryHighWriter[0x23] = this.memoryWriter[0xff23] = (address, data) => {
    if (this.soundMasterEnabled) {
      this.audioJIT();
      this.memory[0xff23] = data;
      this.channel4consecutive = (data & 0x40) === 0x0;
      if (data > 0x7f) {
        var nr42 = this.memory[0xff21];
        this.channel4envelopeVolume = nr42 >> 4;
        this.channel4currentVolume = this.channel4envelopeVolume <<
          this.channel4VolumeShifter;
        this.channel4envelopeSweepsLast = (nr42 & 0x7) - 1;
        if (this.channel4totalLength === 0) {
          this.channel4totalLength = 0x40;
        }
        if ((data & 0x40) === 0x40) {
          this.memory[0xff26] |= 0x8;
        }
      }
      this.channel4EnableCheck();
    }
  };
  //NR50:
  this.memoryHighWriter[0x24] = this.memoryWriter[0xff24] = (address, data) => {
    if (this.soundMasterEnabled && this.memory[0xff24] != data) {
      this.audioJIT();
      this.memory[0xff24] = data;
      this.VinLeftChannelMasterVolume = (data >> 4 & 0x07) + 1;
      this.VinRightChannelMasterVolume = (data & 0x07) + 1;
      this.mixerOutputLevelCache();
    }
  };
  //NR51:
  this.memoryHighWriter[0x25] = this.memoryWriter[0xff25] = (address, data) => {
    if (this.soundMasterEnabled && this.memory[0xff25] != data) {
      this.audioJIT();
      this.memory[0xff25] = data;
      this.rightChannel1 = (data & 0x01) === 0x01;
      this.rightChannel2 = (data & 0x02) === 0x02;
      this.rightChannel3 = (data & 0x04) === 0x04;
      this.rightChannel4 = (data & 0x08) === 0x08;
      this.leftChannel1 = (data & 0x10) === 0x10;
      this.leftChannel2 = (data & 0x20) === 0x20;
      this.leftChannel3 = (data & 0x40) === 0x40;
      this.leftChannel4 = data > 0x7f;
      this.channel1OutputLevelCache();
      this.channel2OutputLevelCache();
      this.channel3OutputLevelCache();
      this.channel4OutputLevelCache();
    }
  };
  //NR52:
  this.memoryHighWriter[0x26] = this.memoryWriter[0xff26] = (address, data) => {
    this.audioJIT();
    if (!this.soundMasterEnabled && data > 0x7f) {
      this.memory[0xff26] = 0x80;
      this.soundMasterEnabled = true;
      this.initializeAudioStartState();
    } else if (this.soundMasterEnabled && data < 0x80) {
      this.memory[0xff26] = 0;
      this.soundMasterEnabled = false;
      //GBDev wiki says the registers are written with zeros on power off:
      for (var index = 0xff10; index < 0xff26; index++) {
        this.memoryWriter[index].apply(this, [index, 0]);
      }
    }
  };
  //0xFF27 to 0xFF2F don't do anything...
  this.memoryHighWriter[0x27] = this.memoryWriter[0xff27] = this.cartIgnoreWrite;
  this.memoryHighWriter[0x28] = this.memoryWriter[0xff28] = this.cartIgnoreWrite;
  this.memoryHighWriter[0x29] = this.memoryWriter[0xff29] = this.cartIgnoreWrite;
  this.memoryHighWriter[0x2a] = this.memoryWriter[0xff2a] = this.cartIgnoreWrite;
  this.memoryHighWriter[0x2b] = this.memoryWriter[0xff2b] = this.cartIgnoreWrite;
  this.memoryHighWriter[0x2c] = this.memoryWriter[0xff2c] = this.cartIgnoreWrite;
  this.memoryHighWriter[0x2d] = this.memoryWriter[0xff2d] = this.cartIgnoreWrite;
  this.memoryHighWriter[0x2e] = this.memoryWriter[0xff2e] = this.cartIgnoreWrite;
  this.memoryHighWriter[0x2f] = this.memoryWriter[0xff2f] = this.cartIgnoreWrite;
  //WAVE PCM RAM:
  this.memoryHighWriter[0x30] = this.memoryWriter[0xff30] = (address, data) => {
    this.channel3WriteRAM(0, data);
  };
  this.memoryHighWriter[0x31] = this.memoryWriter[0xff31] = (address, data) => {
    this.channel3WriteRAM(0x1, data);
  };
  this.memoryHighWriter[0x32] = this.memoryWriter[0xff32] = (address, data) => {
    this.channel3WriteRAM(0x2, data);
  };
  this.memoryHighWriter[0x33] = this.memoryWriter[0xff33] = (address, data) => {
    this.channel3WriteRAM(0x3, data);
  };
  this.memoryHighWriter[0x34] = this.memoryWriter[0xff34] = (address, data) => {
    this.channel3WriteRAM(0x4, data);
  };
  this.memoryHighWriter[0x35] = this.memoryWriter[0xff35] = (address, data) => {
    this.channel3WriteRAM(0x5, data);
  };
  this.memoryHighWriter[0x36] = this.memoryWriter[0xff36] = (address, data) => {
    this.channel3WriteRAM(0x6, data);
  };
  this.memoryHighWriter[0x37] = this.memoryWriter[0xff37] = (address, data) => {
    this.channel3WriteRAM(0x7, data);
  };
  this.memoryHighWriter[0x38] = this.memoryWriter[0xff38] = (address, data) => {
    this.channel3WriteRAM(0x8, data);
  };
  this.memoryHighWriter[0x39] = this.memoryWriter[0xff39] = (address, data) => {
    this.channel3WriteRAM(0x9, data);
  };
  this.memoryHighWriter[0x3a] = this.memoryWriter[0xff3a] = (address, data) => {
    this.channel3WriteRAM(0xa, data);
  };
  this.memoryHighWriter[0x3b] = this.memoryWriter[0xff3b] = (address, data) => {
    this.channel3WriteRAM(0xb, data);
  };
  this.memoryHighWriter[0x3c] = this.memoryWriter[0xff3c] = (address, data) => {
    this.channel3WriteRAM(0xc, data);
  };
  this.memoryHighWriter[0x3d] = this.memoryWriter[0xff3d] = (address, data) => {
    this.channel3WriteRAM(0xd, data);
  };
  this.memoryHighWriter[0x3e] = this.memoryWriter[0xff3e] = (address, data) => {
    this.channel3WriteRAM(0xe, data);
  };
  this.memoryHighWriter[0x3f] = this.memoryWriter[0xff3f] = (address, data) => {
    this.channel3WriteRAM(0xf, data);
  };
  //SCY
  this.memoryHighWriter[0x42] = this.memoryWriter[0xff42] = (address, data) => {
    if (this.backgroundY != data) {
      this.midScanLineJIT();
      this.backgroundY = data;
    }
  };
  //SCX
  this.memoryHighWriter[0x43] = this.memoryWriter[0xff43] = (address, data) => {
    if (this.backgroundX != data) {
      this.midScanLineJIT();
      this.backgroundX = data;
    }
  };
  //LY
  this.memoryHighWriter[0x44] = this.memoryWriter[0xff44] = (address, data) => {
    //Read Only:
    if (this.LCDisOn) {
      //Gambatte says to do this:
      this.modeSTAT = 2;
      this.midScanlineOffset = -1;
      this.cpu.totalLinesPassed = this.currentX = this.queuedScanLines = this.lastUnrenderedLine = this.LCDTicks = this.STATTracker = this.actualScanLine = this.memory[0xff44] = 0;
    }
  };
  //LYC
  this.memoryHighWriter[0x45] = this.memoryWriter[0xff45] = (address, data) => {
    if (this.memory[0xff45] != data) {
      this.memory[0xff45] = data;
      if (this.LCDisOn) {
        this.matchLYC(); //Get the compare of the first scan line.
      }
    }
  };
  //WY
  this.memoryHighWriter[0x4a] = this.memoryWriter[0xff4a] = (address, data) => {
    if (this.windowY != data) {
      this.midScanLineJIT();
      this.windowY = data;
    }
  };
  //WX
  this.memoryHighWriter[0x4b] = this.memoryWriter[0xff4b] = (address, data) => {
    if (this.memory[0xff4b] != data) {
      this.midScanLineJIT();
      this.memory[0xff4b] = data;
      this.windowX = data - 7;
    }
  };
  this.memoryHighWriter[0x72] = this.memoryWriter[0xff72] = (address, data) => {
    this.memory[0xff72] = data;
  };
  this.memoryHighWriter[0x73] = this.memoryWriter[0xff73] = (address, data) => {
    this.memory[0xff73] = data;
  };
  this.memoryHighWriter[0x75] = this.memoryWriter[0xff75] = (address, data) => {
    this.memory[0xff75] = data;
  };
  this.memoryHighWriter[0x76] = this.memoryWriter[0xff76] = this.cartIgnoreWrite;
  this.memoryHighWriter[0x77] = this.memoryWriter[0xff77] = this.cartIgnoreWrite;
  //IE (Interrupt Enable)
  this.memoryHighWriter[0xff] = this.memoryWriter[0xffff] = (address, data) => {
    this.interruptsEnabled = data;
    this.checkIRQMatching();
  };
  this.recompileModelSpecificIOWriteHandling();
  this.recompileBootIOWriteHandling();
};
GameBoyCore.prototype.recompileModelSpecificIOWriteHandling = function () {
  if (this.cartridgeSlot.cartridge.useGBCMode) {
    //GameBoy Color Specific I/O:
    //SC (Serial Transfer Control Register)
    this.memoryHighWriter[0x2] = this.memoryWriter[0xff02] = (address, data) => {
      if ((data & 0x1) === 0x1) {
        //Internal clock:
        this.memory[0xff02] = data & 0x7f;
        this.serialTimer = (data & 0x2) === 0 ? 4096 : 128; //Set the Serial IRQ counter.
        this.serialShiftTimer = this.serialShiftTimerAllocated = (data & 0x2) === 0 ? 512 : 16; //Set the transfer data shift counter.
      } else {
        //External clock:
        this.memory[0xff02] = data;
        this.serialShiftTimer = this.serialShiftTimerAllocated = this.serialTimer = 0; //Zero the timers, since we're emulating as if nothing is connected.
      }
    };
    this.memoryHighWriter[0x40] = this.memoryWriter[0xff40] = (address, data) => {
      if (this.memory[0xff40] != data) {
        this.midScanLineJIT();
        var temp_var = data > 0x7f;
        if (temp_var != this.LCDisOn) {
          // When the display mode changes...
          this.LCDisOn = temp_var;
          this.memory[0xff41] &= 0x78;
          this.midScanlineOffset = -1;
          this.cpu.totalLinesPassed = this.currentX = this.queuedScanLines = this.lastUnrenderedLine = this.STATTracker = this.LCDTicks = this.actualScanLine = this.memory[0xff44] = 0;
          if (this.LCDisOn) {
            this.modeSTAT = 2;
            this.matchLYC(); //Get the compare of the first scan line.
            this.LCDCONTROL = this.LINECONTROL;
          } else {
            this.modeSTAT = 0;
            this.LCDCONTROL = this.DISPLAYOFFCONTROL;
            this.lcd.DisplayShowOff();
          }
          this.interruptsRequested &= 0xfd;
        }
        this.gfxWindowCHRBankPosition = (data & 0x40) === 0x40 ? 0x400 : 0;
        this.gfxWindowDisplay = (data & 0x20) === 0x20;
        this.gfxBackgroundBankOffset = (data & 0x10) === 0x10 ? 0 : 0x80;
        this.gfxBackgroundCHRBankPosition = (data & 0x08) === 0x08 ? 0x400 : 0;
        this.gfxSpriteNormalHeight = (data & 0x04) === 0;
        this.gfxSpriteShow = (data & 0x02) === 0x02;
        this.BGPriorityEnabled = (data & 0x01) === 0x01;
        this.priorityFlaggingPathRebuild(); //Special case the priority flagging as an optimization.
        this.memory[0xff40] = data;
      }
    };
    this.memoryHighWriter[0x41] = this.memoryWriter[0xff41] = (address, data) => {
      this.LYCMatchTriggerSTAT = (data & 0x40) === 0x40;
      this.mode2TriggerSTAT = (data & 0x20) === 0x20;
      this.mode1TriggerSTAT = (data & 0x10) === 0x10;
      this.mode0TriggerSTAT = (data & 0x08) === 0x08;
      this.memory[0xff41] = data & 0x78;
    };
    this.memoryHighWriter[0x46] = this.memoryWriter[0xff46] = (address, data) => {
      this.memory[0xff46] = data;
      if (data < 0xe0) {
        data <<= 8;
        address = 0xfe00;
        var stat = this.modeSTAT;
        this.modeSTAT = 0;
        var newData = 0;
        do {
          newData = this.memoryReader[data].apply(this, [data++]);
          if (newData != this.memory[address]) {
            //JIT the graphics render queue:
            this.modeSTAT = stat;
            this.graphicsJIT();
            this.modeSTAT = 0;
            this.memory[address++] = newData;
            break;
          }
        } while (++address < 0xfea0);
        if (address < 0xfea0) {
          do {
            this.memory[address++] = this.memoryReader[data].apply(this, [data++]);
            this.memory[address++] = this.memoryReader[data].apply(this, [data++]);
            this.memory[address++] = this.memoryReader[data].apply(this, [data++]);
            this.memory[address++] = this.memoryReader[data].apply(this, [data++]);
          } while (address < 0xfea0);
        }
        this.modeSTAT = stat;
      }
    };
    //KEY1
    this.memoryHighWriter[0x4d] = this.memoryWriter[0xff4d] = (address, data) => {
      this.memory[0xff4d] = data & 0x7f | this.memory[0xff4d] & 0x80;
    };
    this.memoryHighWriter[0x4f] = this.memoryWriter[0xff4f] = (address, data) => {
      this.currVRAMBank = data & 0x01;
      if (this.currVRAMBank > 0) {
        this.BGCHRCurrentBank = this.BGCHRBank2;
      } else {
        this.BGCHRCurrentBank = this.BGCHRBank1;
      }

      //Only writable by GBC.
    };
    this.memoryHighWriter[0x51] = this.memoryWriter[0xff51] = (address, data) => {
      if (!this.hdmaRunning) {
        this.memory[0xff51] = data;
      }
    };
    this.memoryHighWriter[0x52] = this.memoryWriter[0xff52] = (address, data) => {
      if (!this.hdmaRunning) {
        this.memory[0xff52] = data & 0xf0;
      }
    };
    this.memoryHighWriter[0x53] = this.memoryWriter[0xff53] = (address, data) => {
      if (!this.hdmaRunning) {
        this.memory[0xff53] = data & 0x1f;
      }
    };
    this.memoryHighWriter[0x54] = this.memoryWriter[0xff54] = (address, data) => {
      if (!this.hdmaRunning) {
        this.memory[0xff54] = data & 0xf0;
      }
    };
    this.memoryHighWriter[0x55] = this.memoryWriter[0xff55] = (address, data) => {
      if (!this.hdmaRunning) {
        if ((data & 0x80) === 0) {
          //DMA
          this.DMAWrite((data & 0x7f) + 1);
          this.memory[0xff55] = 0xff; //Transfer completed.
        } else {
          //H-Blank DMA
          this.hdmaRunning = true;
          this.memory[0xff55] = data & 0x7f;
        }
      } else if ((data & 0x80) === 0) {
        //Stop H-Blank DMA
        this.hdmaRunning = false;
        this.memory[0xff55] |= 0x80;
      } else {
        this.memory[0xff55] = data & 0x7f;
      }
    };
    this.memoryHighWriter[0x68] = this.memoryWriter[0xff68] = (address, data) => {
      this.memory[0xff69] = this.gbcBGRawPalette[data & 0x3f];
      this.memory[0xff68] = data;
    };
    this.memoryHighWriter[0x69] = this.memoryWriter[0xff69] = (address, data) => {
      this.updateGBCBGPalette(this.memory[0xff68] & 0x3f, data);
      if (this.memory[0xff68] > 0x7f) {
        // high bit = autoincrement
        var next = this.memory[0xff68] + 1 & 0x3f;
        this.memory[0xff68] = next | 0x80;
        this.memory[0xff69] = this.gbcBGRawPalette[next];
      } else {
        this.memory[0xff69] = data;
      }
    };
    this.memoryHighWriter[0x6a] = this.memoryWriter[0xff6a] = (address, data) => {
      this.memory[0xff6b] = this.gbcOBJRawPalette[data & 0x3f];
      this.memory[0xff6a] = data;
    };
    this.memoryHighWriter[0x6b] = this.memoryWriter[0xff6b] = (address, data) => {
      this.updateGBCOBJPalette(this.memory[0xff6a] & 0x3f, data);
      if (this.memory[0xff6a] > 0x7f) {
        // high bit = autoincrement
        var next = this.memory[0xff6a] + 1 & 0x3f;
        this.memory[0xff6a] = next | 0x80;
        this.memory[0xff6b] = this.gbcOBJRawPalette[next];
      } else {
        this.memory[0xff6b] = data;
      }
    };
    //SVBK
    this.memoryHighWriter[0x70] = this.memoryWriter[0xff70] = (address, data) => {
      var addressCheck = this.memory[0xff51] << 8 | this.memory[0xff52]; //Cannot change the RAM bank while WRAM is the source of a running HDMA.
      if (!this.hdmaRunning || addressCheck < 0xd000 || addressCheck >= 0xe000) {
        this.gbcRamBank = Math.max(data & 0x07, 1); //Bank range is from 1-7
        this.gbcRamBankPosition = (this.gbcRamBank - 1 << 12) - 0xd000;
        this.gbcRamBankPositionECHO = this.gbcRamBankPosition - 0x2000;
      }
      this.memory[0xff70] = data; //Bit 6 cannot be written to.
    };
    this.memoryHighWriter[0x74] = this.memoryWriter[0xff74] = (address, data) => {
      this.memory[0xff74] = data;
    };
  } else {
    //Fill in the GameBoy Color I/O registers as normal RAM for GameBoy compatibility:
    //SC (Serial Transfer Control Register)
    this.memoryHighWriter[0x2] = this.memoryWriter[0xff02] = (address, data) => {
      if ((data & 0x1) === 0x1) {
        //Internal clock:
        this.memory[0xff02] = data & 0x7f;
        this.serialTimer = 4096; //Set the Serial IRQ counter.
        this.serialShiftTimer = this.serialShiftTimerAllocated = 512; //Set the transfer data shift counter.
      } else {
        //External clock:
        this.memory[0xff02] = data;
        this.serialShiftTimer = this.serialShiftTimerAllocated = this.serialTimer = 0; //Zero the timers, since we're emulating as if nothing is connected.
      }
    };
    this.memoryHighWriter[0x40] = this.memoryWriter[0xff40] = (address, data) => {
      if (this.memory[0xff40] != data) {
        this.midScanLineJIT();
        var temp_var = data > 0x7f;
        if (temp_var != this.LCDisOn) {
          //When the display mode changes...
          this.LCDisOn = temp_var;
          this.memory[0xff41] &= 0x78;
          this.midScanlineOffset = -1;
          this.cpu.totalLinesPassed = this.currentX = this.queuedScanLines = this.lastUnrenderedLine = this.STATTracker = this.LCDTicks = this.actualScanLine = this.memory[0xff44] = 0;
          if (this.LCDisOn) {
            this.modeSTAT = 2;
            this.matchLYC(); //Get the compare of the first scan line.
            this.LCDCONTROL = this.LINECONTROL;
          } else {
            this.modeSTAT = 0;
            this.LCDCONTROL = this.DISPLAYOFFCONTROL;
            this.lcd.DisplayShowOff();
          }
          this.interruptsRequested &= 0xfd;
        }
        this.gfxWindowCHRBankPosition = (data & 0x40) === 0x40 ? 0x400 : 0;
        this.gfxWindowDisplay = (data & 0x20) === 0x20;
        this.gfxBackgroundBankOffset = (data & 0x10) === 0x10 ? 0 : 0x80;
        this.gfxBackgroundCHRBankPosition = (data & 0x08) === 0x08 ? 0x400 : 0;
        this.gfxSpriteNormalHeight = (data & 0x04) === 0;
        this.gfxSpriteShow = (data & 0x02) === 0x02;
        this.bgEnabled = (data & 0x01) === 0x01;
        this.memory[0xff40] = data;
      }
    };
    this.memoryHighWriter[0x41] = this.memoryWriter[0xff41] = (address, data) => {
      this.LYCMatchTriggerSTAT = (data & 0x40) === 0x40;
      this.mode2TriggerSTAT = (data & 0x20) === 0x20;
      this.mode1TriggerSTAT = (data & 0x10) === 0x10;
      this.mode0TriggerSTAT = (data & 0x08) === 0x08;
      this.memory[0xff41] = data & 0x78;
      if (
        (!this.usedBootROM || !this.usedGBCBootROM) &&
        this.LCDisOn &&
        this.modeSTAT < 2
      ) {
        this.interruptsRequested |= 0x2;
        this.checkIRQMatching();
      }
    };
    this.memoryHighWriter[0x46] = this.memoryWriter[0xff46] = (address, data) => {
      this.memory[0xff46] = data;
      if (data > 0x7f && data < 0xe0) {
        //DMG cannot DMA from the ROM banks.
        data <<= 8;
        address = 0xfe00;
        var stat = this.modeSTAT;
        this.modeSTAT = 0;
        var newData = 0;
        do {
          newData = this.memoryReader[data].apply(this, [data++]);
          if (newData != this.memory[address]) {
            //JIT the graphics render queue:
            this.modeSTAT = stat;
            this.graphicsJIT();
            this.modeSTAT = 0;
            this.memory[address++] = newData;
            break;
          }
        } while (++address < 0xfea0);
        if (address < 0xfea0) {
          do {
            this.memory[address++] = this.memoryReader[data].apply(this, [data++]);
            this.memory[address++] = this.memoryReader[data].apply(this, [data++]);
            this.memory[address++] = this.memoryReader[data].apply(this, [data++]);
            this.memory[address++] = this.memoryReader[data].apply(this, [data++]);
          } while (address < 0xfea0);
        }
        this.modeSTAT = stat;
      }
    };
    this.memoryHighWriter[0x47] = this.memoryWriter[0xff47] = (address, data) => {
      if (this.memory[0xff47] != data) {
        this.midScanLineJIT();
        this.updateGBBGPalette(data);
        this.memory[0xff47] = data;
      }
    };
    this.memoryHighWriter[0x48] = this.memoryWriter[0xff48] = (address, data) => {
      if (this.memory[0xff48] != data) {
        this.midScanLineJIT();
        this.updateGBOBJPalette(0, data);
        this.memory[0xff48] = data;
      }
    };
    this.memoryHighWriter[0x49] = this.memoryWriter[0xff49] = (address, data) => {
      if (this.memory[0xff49] != data) {
        this.midScanLineJIT();
        this.updateGBOBJPalette(4, data);
        this.memory[0xff49] = data;
      }
    };
    this.memoryHighWriter[0x4d] = this.memoryWriter[0xff4d] = (address, data) => {
      this.memory[0xff4d] = data;
    };
    this.memoryHighWriter[0x4f] = this.memoryWriter[0xff4f] = this.cartIgnoreWrite; //Not writable in DMG mode.
    this.memoryHighWriter[0x55] = this.memoryWriter[0xff55] = this.cartIgnoreWrite;
    this.memoryHighWriter[0x68] = this.memoryWriter[0xff68] = this.cartIgnoreWrite;
    this.memoryHighWriter[0x69] = this.memoryWriter[0xff69] = this.cartIgnoreWrite;
    this.memoryHighWriter[0x6a] = this.memoryWriter[0xff6a] = this.cartIgnoreWrite;
    this.memoryHighWriter[0x6b] = this.memoryWriter[0xff6b] = this.cartIgnoreWrite;
    this.memoryHighWriter[0x6c] = this.memoryWriter[0xff6c] = this.cartIgnoreWrite;
    this.memoryHighWriter[0x70] = this.memoryWriter[0xff70] = this.cartIgnoreWrite;
    this.memoryHighWriter[0x74] = this.memoryWriter[0xff74] = this.cartIgnoreWrite;
  }
};
GameBoyCore.prototype.recompileBootIOWriteHandling = function () {
  //Boot I/O Registers:
  if (this.inBootstrap) {
    this.memoryHighWriter[0x50] = this.memoryWriter[0xff50] = (address, data) => {
      console.log("Boot ROM reads blocked: Bootstrap process has ended.", 0);
      this.inBootstrap = false;
      this.disableBootROM(); //Fill in the boot ROM ranges with ROM  bank 0 ROM ranges
      this.memory[0xff50] = data; //Bits are sustained in memory?
    };
    if (this.cartridgeSlot.cartridge.useGBCMode) {
      this.memoryHighWriter[0x6c] = this.memoryWriter[0xff6c] = (address, data) => {
        if (this.inBootstrap) {
          this.cartridgeSlot.cartridge.setGBCMode(data);
        }
        this.memory[0xff6c] = data;
      };
    }
  } else {
    //Lockout the ROMs from accessing the BOOT ROM control register:
    this.memoryHighWriter[0x50] = this.memoryWriter[
      0xff50
    ] = this.cartIgnoreWrite;
  }
};

export default GameBoyCore;
