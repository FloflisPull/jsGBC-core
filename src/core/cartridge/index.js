import util from "../util.js";
import settings from "../../settings.js";
import ROM from "./rom.js";
import MBC1 from "./mbc1.js";
import MBC2 from "./mbc2.js";
import MBC3 from "./mbc3.js";
import MBC5 from "./mbc5.js";
import MBC7 from "./mbc7.js";

export default class Cartridge {
  constructor(rom) {
    this.rom = new ROM(rom);

    this.MBCRam = []; // Switchable RAM (Used by games for more RAM) for the main memory range 0xA000 - 0xC000.
    this.MBC1Mode = false; // MBC1 Type (4/32, 16/8)

    this.hasMBC1 = false; // Does the cartridge use MBC1?
    this.hasMBC2 = false; // Does the cartridge use MBC2?
    this.hasMBC3 = false; // Does the cartridge use MBC3?
    this.hasMBC5 = false; // Does the cartridge use MBC5?
    this.hasMBC7 = false; // Does the cartridge use MBC7?
    this.hasSRAM = false; // Does the cartridge use save RAM?
    this.cMMMO1 = false; // ...
    this.hasBattery = false;
    this.cRUMBLE = false; // Does the cartridge use the RUMBLE addressing (modified MBC5)?
    this.cCamera = false; // Is the cartridge actually a GameBoy Camera?
    this.cTAMA5 = false; // Does the cartridge use TAMA5? (Tamagotchi Cartridge)
    this.cHuC3 = false; // Does the cartridge use HuC3 (Hudson Soft / modified MBC3)?
    this.cHuC1 = false; // Does the cartridge use HuC1 (Hudson Soft / modified MBC1)?
    this.hasRTC = false; // Does the cartridge have an RTC?

    this.ROMBanks = [
      // 1 Bank = 16 KBytes = 256 Kbits
      2,
      4,
      8,
      16,
      32,
      64,
      128,
      256,
      512
    ];
    this.ROMBanks[0x52] = 72;
    this.ROMBanks[0x53] = 80;
    this.ROMBanks[0x54] = 96;

    this.RAMBanks = [0, 1, 2, 4, 16]; // Used to map the RAM banks to maximum size the MBC used can do.
    this.numRAMBanks = 0; // How many RAM banks were actually allocated?
  }

  connect(gameboy) {
    this.gameboy = gameboy;
    this.parseROM();
  }

  parseROM() {
    // TODO: move to gameboy core
    // Load the first two ROM banks (0x0000 - 0x7FFF) into regular gameboy memory:
    this.gameboy.usedBootROM = settings.bootBootRomFirst &&
      (!settings.forceGBBootRom && this.gameboy.GBCBOOTROM.length === 0x800 ||
        settings.forceGBBootRom && this.gameboy.GBBOOTROM.length === 0x100);

    // http://www.enliten.force9.co.uk/gameboy/carthead.htm
    if (this.rom.length < 0x4000) throw new Error("ROM size too small.");

    let romIndex = 0;
    if (this.gameboy.usedBootROM) {
      // if (!settings.forceGBBootRom) {
      //   //Patch in the GBC boot ROM into the memory map:
      //   for (; romIndex < 0x100; ++romIndex) {
      //     this.memory[romIndex] = this.GBCBOOTROM[romIndex]; //Load in the GameBoy Color BOOT ROM.
      //     this.ROM[romIndex] = this.rom.getByte(romIndex); //Decode the ROM binary for the switch out.
      //   }
      //
      //   for (; romIndex < 0x200; ++romIndex) {
      //     this.memory[romIndex] = this.ROM[romIndex] = this.rom.getByte(romIndex); //Load in the game ROM.
      //   }
      //
      //   for (; romIndex < 0x900; ++romIndex) {
      //     this.memory[romIndex] = this.GBCBOOTROM[romIndex - 0x100]; //Load in the GameBoy Color BOOT ROM.
      //     this.ROM[romIndex] = this.rom.getByte(romIndex); //Decode the ROM binary for the switch out.
      //   }
      //
      //   this.usedGBCBootROM = true;
      // } else {
      //   //Patch in the GB boot ROM into the memory map:
      //   for (; romIndex < 0x100; ++romIndex) {
      //     this.memory[romIndex] = this.GBBOOTROM[romIndex]; //Load in the GameBoy BOOT ROM.
      //     this.ROM[romIndex] = this.rom.getByte(romIndex); //Decode the ROM binary for the switch out.
      //   }
      // }
      //
      // for (; romIndex < 0x4000; ++romIndex) {
      //   this.memory[romIndex] = this.ROM[romIndex] = this.rom.getByte(romIndex); //Load in the game ROM.
      // }
    } else {
      // Don't load in the boot ROM:
      while (romIndex < 0x4000) {
        this.gameboy.memory[romIndex] = this.rom.getByte(romIndex) & 0xff;
        ++romIndex;
      }
    }
  }

  interpret() {
    this.name = this.rom.getString(0x134, 0x13e);
    this.gameCode = this.rom.getString(0x13f, 0x142);
    this.colorCompatibilityByte = this.rom.getByte(0x143);
    this.type = this.rom.getByte(0x147);
    this.setTypeName();

    if (this.name) {
      console.log("Game Title: " + this.name);
    }
    if (this.gameCode) {
      console.log("Game Code: " + this.gameCode);
    }
    if (this.colorCompatibilityByte) {
      console.log("Color Compatibility Byte: " + this.colorCompatibilityByte);
    }
    if (this.type) {
      console.log("Cartridge Type: " + this.type);
    }
    if (this.typeName) {
      console.log("Cartridge Type Name: " + this.typeName);
    }

    this.romSize = this.rom.getByte(0x148);
    this.ramSize = this.rom.getByte(0x149);

    // ROM and RAM banks
    this.numROMBanks = this.ROMBanks[this.romSize];

    console.log(this.numROMBanks + " ROM banks.");

    switch (this.RAMBanks[this.ramSize]) {
      case 0:
        console.log(
          "No RAM banking requested for allocation or MBC is of type 2."
        );
        break;
      case 2:
        console.log("1 RAM bank requested for allocation.");
        break;
      case 3:
        console.log("4 RAM banks requested for allocation.");
        break;
      case 4:
        console.log("16 RAM banks requested for allocation.");
        break;
      default:
        console.log(
          "RAM bank amount requested is unknown, will use maximum allowed by specified MBC type."
        );
    }

    // Check the GB/GBC mode byte:
    if (!this.gameboy.usedBootROM) {
      switch (this.colorCompatibilityByte) {
        case 0x00: // GB only
          this.useGBCMode = false;
          break;
        case 0x32: // Exception to the GBC identifying code:
          if (
            !settings.gbHasPriority &&
            this.name + this.gameCode + this.colorCompatibilityByte ===
              "Game and Watch 50"
          ) {
            this.useGBCMode = true;
            console.log(
              "Created a boot exception for Game and Watch Gallery 2 (GBC ID byte is wrong on the cartridge)."
            );
          } else {
            this.useGBCMode = false;
          }
          break;
        case 0x80: //Both GB + GBC modes
          this.useGBCMode = !settings.gbHasPriority;
          break;
        case 0xc0: //Only GBC mode
          this.useGBCMode = true;
          break;
        default:
          this.useGBCMode = false;
          console.warn(
            "Unknown GameBoy game type code #" +
              this.colorCompatibilityByte +
              ", defaulting to GB mode (Old games don't have a type code)."
          );
      }
    } else {
      console.log("used boot rom");
      this.useGBCMode = this.gameboy.usedGBCBootROM; // Allow the GBC boot ROM to run in GBC mode...
    }

    const oldLicenseCode = this.rom.getByte(0x14b);
    const newLicenseCode = this.rom.getByte(0x144) & 0xff00 |
      this.rom.getByte(0x145) & 0xff;
    if (oldLicenseCode !== 0x33) {
      this.isNewLicenseCode = false;
      this.licenseCode = oldLicenseCode;
    } else {
      this.isNewLicenseCode = true;
      this.licenseCode = newLicenseCode;
    }
  }

  setTypeName() {
    switch (this.type) {
      case 0x00:
        //ROM w/o bank switching
        if (!settings.enableMBC1Override) {
          this.typeName = "ROM";
        }
      case 0x01:
        this.hasMBC1 = true;
        this.typeName = "MBC1";
        break;
      case 0x02:
        this.hasMBC1 = true;
        this.hasSRAM = true;
        this.typeName = "MBC1 + SRAM";
        break;
      case 0x03:
        this.hasMBC1 = true;
        this.hasSRAM = true;
        this.hasBattery = true;
        this.typeName = "MBC1 + SRAM + Battery";
        break;
      case 0x05:
        this.hasMBC2 = true;
        this.typeName = "MBC2";
        break;
      case 0x06:
        this.hasMBC2 = true;
        this.hasBattery = true;
        this.typeName = "MBC2 + Battery";
        break;
      case 0x08:
        this.hasSRAM = true;
        this.typeName = "ROM + SRAM";
        break;
      case 0x09:
        this.hasSRAM = true;
        this.hasBattery = true;
        this.typeName = "ROM + SRAM + Battery";
        break;
      case 0x0b:
        this.cMMMO1 = true;
        this.typeName = "MMMO1";
        break;
      case 0x0c:
        this.cMMMO1 = true;
        this.hasSRAM = true;
        this.typeName = "MMMO1 + SRAM";
        break;
      case 0x0d:
        this.cMMMO1 = true;
        this.hasSRAM = true;
        this.hasBattery = true;
        this.typeName = "MMMO1 + SRAM + Battery";
        break;
      case 0x0f:
        this.hasMBC3 = true;
        this.hasRTC = true;
        this.hasBattery = true;
        this.typeName = "MBC3 + RTC + Battery";
        break;
      case 0x10:
        this.hasMBC3 = true;
        this.hasRTC = true;
        this.hasBattery = true;
        this.hasSRAM = true;
        this.typeName = "MBC3 + RTC + Battery + SRAM";
        break;
      case 0x11:
        this.hasMBC3 = true;
        this.typeName = "MBC3";
        break;
      case 0x12:
        this.hasMBC3 = true;
        this.hasSRAM = true;
        this.typeName = "MBC3 + SRAM";
        break;
      case 0x13:
        this.hasMBC3 = true;
        this.hasSRAM = true;
        this.hasBattery = true;
        this.typeName = "MBC3 + SRAM + Battery";
        break;
      case 0x19:
        this.hasMBC5 = true;
        this.typeName = "MBC5";
        break;
      case 0x1a:
        this.hasMBC5 = true;
        this.hasSRAM = true;
        this.typeName = "MBC5 + SRAM";
        break;
      case 0x1b:
        this.hasMBC5 = true;
        this.hasSRAM = true;
        this.hasBattery = true;
        this.typeName = "MBC5 + SRAM + Battery";
        break;
      case 0x1c:
        this.cRUMBLE = true;
        this.typeName = "RUMBLE";
        break;
      case 0x1d:
        this.cRUMBLE = true;
        this.hasSRAM = true;
        this.typeName = "RUMBLE + SRAM";
        break;
      case 0x1e:
        this.cRUMBLE = true;
        this.hasSRAM = true;
        this.hasBattery = true;
        this.typeName = "RUMBLE + SRAM + Battery";
        break;
      case 0x1f:
        this.cCamera = true;
        this.typeName = "GameBoy Camera";
        break;
      case 0x22:
        this.hasMBC7 = true;
        this.hasSRAM = true;
        this.hasBattery = true;
        this.typeName = "MBC7 + SRAM + Battery";
        break;
      case 0xfd:
        this.cTAMA5 = true;
        this.typeName = "TAMA5";
        break;
      case 0xfe:
        this.cHuC3 = true;
        this.typeName = "HuC3";
        break;
      case 0xff:
        this.cHuC1 = true;
        this.typeName = "HuC1";
        break;
      default:
        this.typeName = "Unknown";
        console.log("Cartridge type is unknown.");
        // TODO error
        break;
    }

    if (this.hasMBC1) {
      this.mbc1 = new MBC1(this);
    }

    if (this.hasMBC2) {
      this.mbc2 = new MBC2(this);
    }

    if (this.hasMBC3) {
      this.mbc3 = new MBC3(this);
    }

    if (this.hasMBC5) {
      this.mbc5 = new MBC5(this);
    }

    if (this.hasMBC7) {
      this.mbc7 = new MBC7(this);
    }

    this.mbc = this.mbc1 ||
      this.mbc2 ||
      this.mbc3 ||
      this.mbc5 ||
      this.mbc7 ||
      null;
  }

  setupRAM() {
    // Setup the auxilliary/switchable RAM:
    if (this.hasMBC2) {
      this.numRAMBanks = 1 / 16;
    } else if (this.hasMBC1 || this.cRUMBLE || this.hasMBC3 || this.cHuC3) {
      this.numRAMBanks = 4;
    } else if (this.hasMBC5) {
      this.numRAMBanks = 16;
    } else if (this.hasSRAM) {
      this.numRAMBanks = 1;
    }

    this.allocatedRamBytes = this.numRAMBanks * 0x2000;

    console.log("Actual bytes of MBC RAM allocated: " + this.allocatedRamBytes);

    if (this.numRAMBanks > 0) {
      let mbcRam = null;
      if (typeof this.gameboy.loadSRAMState === "function") {
        mbcRam = this.gameboy.loadSRAMState(this.name);
      }

      if (mbcRam) {
        this.MBCRam = util.toTypedArray(mbcRam, "uint8");
      } else {
        this.MBCRam = util.getTypedArray(this.allocatedRamBytes, 0, "uint8");
      }
    }

    this.gameboy.loadRTCState2();
  }

  saveSRAMState() {
    if (!this.hasBattery || this.MBCRam.length === 0) return; // No battery backup...

    // return the MBC RAM for backup...
    return util.fromTypedArray(this.MBCRam);
  }
}
