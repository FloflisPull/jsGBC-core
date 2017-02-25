import settings from "../../settings.js";
import RTC from "./rtc.js";
import MBC from "./mbc.js";

export default class MBC3 extends MBC {
  constructor(cartridge) {
    super(cartridge);

    this.rtc = new RTC(this);
  }

  writeROMBank(address, data) {
    // MBC3 ROM bank switching:
    this.ROMBank1Offset = data & 0x7f;
    this.setCurrentROMBank();
  }

  writeRAMBank(address, data) {
    this.currentMBCRAMBank = data;
    if (data < 4) {
      // MBC3 RAM bank switching
      this.currentRAMBankPosition = (this.currentMBCRAMBank << 13) - 0xa000;
    }
  }

  writeRAM(address, data) {
    if (this.MBCRAMBanksEnabled || settings.alwaysAllowRWtoBanks) {
      switch (this.currentMBCRAMBank) {
      case 0x00:
      case 0x01:
      case 0x02:
      case 0x03:
        this.emit("ramWrite");
        this.RAM[address + this.currentRAMBankPosition] = data;
        break;
      case 0x08:
        this.rtc && this.rtc.writeSeconds(data);
        break;
      case 0x09:
        this.rtc && this.rtc.writeMinutes(data);
        break;
      case 0x0a:
        this.rtc && this.rtc.writeHours(data);
        break;
      case 0x0b:
        this.rtc && this.rtc.writeDaysLow(data);
        break;
      case 0x0c:
        this.rtc && this.rtc.writeDaysHigh(data);
        break;
      default:
        console.log(
          "Invalid MBC3 bank address selected: " + this.currentMBCRAMBank
        );
      }
    }
  }

  readRAM(address) {
    // Switchable RAM
    if (this.MBCRAMBanksEnabled || settings.alwaysAllowRWtoBanks) {
      switch (this.currentMBCRAMBank) {
      case 0x00:
      case 0x01:
      case 0x02:
      case 0x03:
        return this.RAM[address + this.currentRAMBankPosition];
        break;
      case 0x08:
        return this.rtc && this.rtc.readSeconds();
        break;
      case 0x09:
        return this.rtc && this.rtc.readMinutes();
        break;
      case 0x0a:
        return this.rtc && this.rtc.readHours();
        break;
      case 0x0b:
        return this.rtc && this.rtc.readDaysLow();
        break;
      case 0x0c:
        return this.rtc && this.rtc.readDaysHigh();
      }
    }
    //console.log("Reading from invalid or disabled RAM.");
    return 0xff;
  }
}