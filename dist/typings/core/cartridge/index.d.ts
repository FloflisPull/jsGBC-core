import ROM from "../rom";
import MBC from "./mbc";
import MBC1 from "./mbc1";
import MBC2 from "./mbc2";
import MBC3 from "./mbc3";
import MBC5 from "./mbc5";
import MBC7 from "./mbc7";
import RUMBLE from "./RUMBLE";
import GameBoyCore from "../GameBoyCore";
export default class Cartridge {
    hasMBC1: boolean;
    hasMBC2: boolean;
    hasMBC3: boolean;
    hasMBC5: boolean;
    hasMBC7: boolean;
    hasSRAM: boolean;
    hasRUMBLE: boolean;
    hasCamera: boolean;
    hasTAMA5: boolean;
    hasHuC3: boolean;
    hasHuC1: boolean;
    hasMMMO1: boolean;
    hasRTC: boolean;
    hasBattery: boolean;
    gameboy: GameBoyCore;
    rom: ROM;
    useGBCMode: boolean;
    name: string;
    gameCode: string;
    colorCompatibilityByte: number;
    type: number;
    typeName: string;
    romSizeType: number;
    ramSizeType: number;
    hasNewLicenseCode: boolean;
    licenseCode: number;
    mbc: MBC;
    mbc1: MBC1;
    mbc2: MBC2;
    mbc3: MBC3;
    mbc5: MBC5;
    mbc7: MBC7;
    rumble: RUMBLE;
    constructor(rom: ROM | Uint8Array | ArrayBuffer);
    connect(gameboy: GameBoyCore): void;
    interpret(): void;
    setGBCMode(data: any): void;
    setTypeName(): void;
    setupRAM(): void;
}
