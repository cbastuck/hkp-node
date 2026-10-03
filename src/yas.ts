/**
 * The YAS frames a runtime socket carries when what flows is not JSON.
 *
 * Reference implementations:
 *   hkp-frontend/src/runtime/rest/Message.ts   (TypeScript, the peer here)
 *   hkp-rt/lib/src/types/message.cpp           (C++, yas library)
 *   hkp-python/src/hkp/yas.py                  (Python)
 *
 * Frame layout, integers little-endian:
 *
 *   7 bytes   YAS header, b"yas" + 4 flag/version bytes (only "yas" is checked)
 *   uint16    message purpose
 *   uint16    data type id
 *   uint64    sender length
 *   bytes     sender (ascii)
 *   ...       payload — for BinaryData the raw bytes to the end of the frame,
 *             for Null a single ignored byte
 *
 * Only those two types are read and written: a Node service has nothing to do
 * with a FloatRingBuffer, and JSON and text travel as JSON frames.
 */

export enum MessagePurpose {
  NOTIFICATION = 0,
  RESULT = 1,
  RESULT_AWAITING_RESPONSE = 2,
  RESULT_WITH_REQUEST_ID = 3,
}

/** In sync with hkp-rt/lib/include/types/data.h. */
export enum DataTypeId {
  Undefined = 0,
  FloatRingBuffer = 1,
  JSON = 2,
  BinaryData = 3,
  String = 4,
  Null = 5,
}

export type YasMessage = {
  purpose: number;
  dataType: number;
  sender: string;
  /** A Buffer for BinaryData, null for Null; undefined for a type not read. */
  data: Buffer | null | undefined;
};

const HEADER = Buffer.from("yas0017", "latin1");
const FIXED = HEADER.length + 2 + 2 + 8;

/** The frame, or null when the bytes are not one. */
export function decodeYasMessage(frame: Buffer): YasMessage | null {
  if (frame.length < FIXED || frame.toString("latin1", 0, 3) !== "yas") {
    return null;
  }
  let offset = HEADER.length;
  const purpose = frame.readUInt16LE(offset);
  offset += 2;
  const dataType = frame.readUInt16LE(offset);
  offset += 2;
  const senderLength = Number(frame.readBigUInt64LE(offset));
  offset += 8;
  if (offset + senderLength > frame.length) {
    return null;
  }
  const sender = frame.toString("latin1", offset, offset + senderLength);
  offset += senderLength;

  let data: Buffer | null | undefined;
  if (dataType === DataTypeId.BinaryData) {
    data = frame.subarray(offset);
  } else if (dataType === DataTypeId.Null) {
    data = null;
  }
  return { purpose, dataType, sender, data };
}

/** The bytes as a BinaryData frame. */
export function encodeYasBinary(
  bytes: Uint8Array,
  purpose: MessagePurpose,
  sender = "",
): Buffer {
  const head = Buffer.alloc(FIXED + sender.length);
  HEADER.copy(head, 0);
  let offset = HEADER.length;
  head.writeUInt16LE(purpose, offset);
  offset += 2;
  head.writeUInt16LE(DataTypeId.BinaryData, offset);
  offset += 2;
  head.writeBigUInt64LE(BigInt(sender.length), offset);
  offset += 8;
  head.write(sender, offset, "latin1");
  return Buffer.concat([head, bytes]);
}
