export const SECTOR_BYTES = 512;

function readU16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

export const HARD_DISK_GEOMETRY = Object.freeze({
  cylinders: 615,
  heads: 4,
  sectorsPerTrack: 17,
  totalSectors: 615 * 4 * 17,
});

export function parseFloppyGeometry(image) {
  if (image.length < SECTOR_BYTES || image.length % SECTOR_BYTES !== 0) {
    throw new Error('floppy image must contain whole 512-byte sectors');
  }
  if (image[510] !== 0x55 || image[511] !== 0xaa) throw new Error('floppy image has no boot signature');
  const bytesPerSector = readU16(image, 11);
  const sectorsPerTrack = readU16(image, 24);
  const heads = readU16(image, 26);
  const totalSectors = readU16(image, 19) || readU32(image, 32);
  if (bytesPerSector !== SECTOR_BYTES || !sectorsPerTrack || !heads || !totalSectors) {
    throw new Error('unsupported floppy BPB geometry');
  }
  if (totalSectors !== image.length / bytesPerSector) {
    throw new Error('floppy image size does not match its BPB');
  }
  const sectorsPerCylinder = sectorsPerTrack * heads;
  if (totalSectors % sectorsPerCylinder !== 0) throw new Error('floppy BPB has a partial cylinder');
  const cylinders = totalSectors / sectorsPerCylinder;
  if (cylinders > 1024 || heads > 256 || sectorsPerTrack > 63) {
    throw new Error('floppy BPB geometry exceeds BIOS CHS limits');
  }
  return Object.freeze({ cylinders, heads, sectorsPerTrack, totalSectors });
}

export class DiskImage {
  constructor(image, geometry, { copy = true } = {}) {
    const bytes = image instanceof Uint8Array ? image : new Uint8Array(image);
    const totalSectors = geometry.cylinders * geometry.heads * geometry.sectorsPerTrack;
    if (!geometry.cylinders || !geometry.heads || !geometry.sectorsPerTrack
        || totalSectors !== geometry.totalSectors || bytes.length !== totalSectors * SECTOR_BYTES) {
      throw new Error('disk image size does not match its CHS geometry');
    }
    this.bytes = copy ? bytes.slice() : bytes;
    this.geometry = Object.freeze({ ...geometry });
    this.dirty = false;
  }

  static blank(geometry) {
    return new DiskImage(new Uint8Array(geometry.totalSectors * SECTOR_BYTES), geometry, { copy: false });
  }

  readSectors(cylinder, head, sector, count) {
    const firstLba = this.toLba(cylinder, head, sector, count);
    if (firstLba === null) return null;
    const start = firstLba * SECTOR_BYTES;
    return this.bytes.slice(start, start + count * SECTOR_BYTES);
  }

  writeSectors(cylinder, head, sector, data) {
    if (!(data instanceof Uint8Array) || !data.length || data.length % SECTOR_BYTES !== 0) return false;
    const count = data.length / SECTOR_BYTES;
    const firstLba = this.toLba(cylinder, head, sector, count);
    if (firstLba === null) return false;
    this.bytes.set(data, firstLba * SECTOR_BYTES);
    this.dirty = true;
    return true;
  }

  markSaved() {
    this.dirty = false;
  }

  toLba(cylinder, head, sector, count) {
    const { cylinders, heads, sectorsPerTrack, totalSectors } = this.geometry;
    if (!Number.isInteger(cylinder) || !Number.isInteger(head) || !Number.isInteger(sector)
        || !Number.isInteger(count) || cylinder < 0 || cylinder >= cylinders
        || head < 0 || head >= heads || sector < 1 || sector > sectorsPerTrack || count < 1) {
      return null;
    }
    const firstLba = (cylinder * heads + head) * sectorsPerTrack + sector - 1;
    return firstLba + count <= totalSectors ? firstLba : null;
  }
}
