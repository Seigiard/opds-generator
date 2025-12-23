import type { FormatHandler, FormatHandlerRegistration, BookMetadata } from "./types.ts";
import { cleanDescription } from "./utils.ts";
import { logHandlerError } from "../utils/errors.ts";

interface ExthData {
  title?: string;
  creator?: string[];
  publisher?: string;
  description?: string;
  subject?: string[];
  date?: string;
  rights?: string;
  coverOffset?: number;
  thumbnailOffset?: number;
}

interface MobiHeader {
  title: string;
  firstImageIndex: number;
  exthFlag: boolean;
  headerLength: number;
}

const EXTH_TYPES: Record<number, string> = {
  100: "creator",
  101: "publisher",
  103: "description",
  105: "subject",
  106: "date",
  109: "rights",
  201: "coverOffset",
  202: "thumbnailOffset",
  503: "title",
};

const decoder = new TextDecoder("utf-8");

function readString(buf: Uint8Array, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length);
  const nullIndex = slice.indexOf(0);
  return decoder.decode(nullIndex >= 0 ? slice.subarray(0, nullIndex) : slice);
}

function parseRecordOffsets(view: DataView, numRecords: number, bufLength: number): number[] {
  const offsets: number[] = [];
  for (let i = 0; i < numRecords; i++) {
    offsets.push(view.getUint32(78 + i * 8));
  }
  offsets.push(bufLength);
  return offsets;
}

function parseMobiHeader(record0: Uint8Array): MobiHeader | null {
  const magic = readString(record0, 16, 4);
  if (magic !== "MOBI") return null;

  const view = new DataView(record0.buffer, record0.byteOffset, record0.byteLength);
  const headerLength = view.getUint32(20);
  const titleOffset = view.getUint32(84);
  const titleLength = view.getUint32(88);
  const firstImageIndex = view.getUint32(108);
  const exthFlag = (view.getUint32(128) & 0x40) !== 0;

  return {
    title: readString(record0, titleOffset, titleLength),
    firstImageIndex,
    exthFlag,
    headerLength,
  };
}

function parseExthRecords(record0: Uint8Array, offset: number): ExthData {
  const magic = readString(record0, offset, 4);
  if (magic !== "EXTH") return {};

  const view = new DataView(record0.buffer, record0.byteOffset, record0.byteLength);
  const count = view.getUint32(offset + 8);
  let pos = offset + 12;
  const data: ExthData = {};
  const creators: string[] = [];
  const subjects: string[] = [];

  for (let i = 0; i < count && pos < record0.length; i++) {
    const type = view.getUint32(pos);
    const len = view.getUint32(pos + 4);
    if (len < 8 || pos + len > record0.length) break;

    const value = record0.subarray(pos + 8, pos + len);
    const key = EXTH_TYPES[type];

    if (key) {
      if (type === 201 || type === 202) {
        const valueView = new DataView(value.buffer, value.byteOffset, value.byteLength);
        (data as Record<string, number>)[key] = valueView.getUint32(0);
      } else {
        const str = readString(value, 0, value.length);
        if (key === "creator") {
          creators.push(str);
        } else if (key === "subject") {
          subjects.push(str);
        } else {
          (data as Record<string, string>)[key] = str;
        }
      }
    }
    pos += len;
  }

  if (creators.length > 0) data.creator = creators;
  if (subjects.length > 0) data.subject = subjects;

  return data;
}

function loadResource(buf: Uint8Array, offsets: number[], index: number): Buffer | null {
  if (index < 0 || index >= offsets.length - 1) return null;
  const start = offsets[index];
  const end = offsets[index + 1];
  if (start === undefined || end === undefined) return null;
  if (start >= buf.length || end > buf.length) return null;
  return Buffer.from(buf.subarray(start, end));
}

async function createMobiHandler(filePath: string): Promise<FormatHandler | null> {
  try {
    const file = Bun.file(filePath);
    const buffer = new Uint8Array(await file.arrayBuffer());

    if (buffer.length < 78) return null;

    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const numRecords = view.getUint16(76);
    if (numRecords === 0) return null;

    const offsets = parseRecordOffsets(view, numRecords, buffer.length);
    if (offsets.length < 2) return null;
    const firstOffset = offsets[0];
    const secondOffset = offsets[1];
    if (firstOffset === undefined || secondOffset === undefined) return null;
    const record0 = buffer.subarray(firstOffset, secondOffset);

    const mobi = parseMobiHeader(record0);
    if (!mobi) return null;

    const exthOffset = 16 + mobi.headerLength;
    const exth = mobi.exthFlag ? parseExthRecords(record0, exthOffset) : {};

    const metadata: BookMetadata = {
      title: exth.title || mobi.title || "",
      author: exth.creator?.[0],
      description: cleanDescription(exth.description),
      publisher: exth.publisher,
      issued: exth.date,
      subjects: exth.subject,
      rights: exth.rights,
    };

    return {
      getMetadata() {
        return metadata;
      },
      async getCover() {
        const coverIdx = exth.coverOffset ?? exth.thumbnailOffset;
        if (coverIdx === undefined) return null;
        return loadResource(buffer, offsets, mobi.firstImageIndex + coverIdx);
      },
    };
  } catch (error) {
    logHandlerError("MOBI", filePath, error);
    return null;
  }
}

export const mobiHandlerRegistration: FormatHandlerRegistration = {
  extensions: ["mobi", "azw", "azw3"],
  create: createMobiHandler,
};
