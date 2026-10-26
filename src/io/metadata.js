// Reads what we need from a DJI JPEG: the XMP block DJI writes (gimbal angles,
// GPS) and a few EXIF tags (focal length, exposure). Only the first part of the
// file is read, which is where both live.

const HEADER_BYTES = 256 * 1024;

const EXIF_TAGS = {
  0x829a: "exposureTime",
  0x829d: "fNumber",
  0x8827: "iso",
  0x920a: "focalLength",
  0xa405: "focalLength35",
  0x8769: "exifIfd",
};

export async function readMetadata(blob) {
  const buf = await blob.slice(0, HEADER_BYTES).arrayBuffer();
  const bytes = new Uint8Array(buf);
  return { ...parseJpeg(bytes), ...parseXmp(bytes) };
}

export function parseXmp(bytes) {
  const text = latin1(bytes);
  const start = text.indexOf("<x:xmpmeta");
  const end = text.indexOf("</x:xmpmeta>", start);
  if (start < 0 || end < 0) return {};
  const xmp = text.slice(start, end);

  const attr = (name) => {
    const m = xmp.match(new RegExp(`${name}="([^"]*)"`));
    return m ? m[1] : undefined;
  };
  const num = (name) => {
    const v = attr(name);
    return v === undefined || v === "" ? undefined : Number(v);
  };

  return {
    make: attr("tiff:Make"),
    model: attr("drone-dji:ProductName") ?? attr("tiff:Model"),
    createDate: attr("xmp:CreateDate"),
    gimbalYaw: num("drone-dji:GimbalYawDegree"),
    gimbalPitch: num("drone-dji:GimbalPitchDegree"),
    gimbalRoll: num("drone-dji:GimbalRollDegree"),
    flightYaw: num("drone-dji:FlightYawDegree"),
    latitude: num("drone-dji:GpsLatitude"),
    longitude: num("drone-dji:GpsLongitude"),
    relativeAltitude: num("drone-dji:RelativeAltitude"),
    absoluteAltitude: num("drone-dji:AbsoluteAltitude"),
  };
}

// Walks the JPEG segments for the image size (SOF) and the EXIF block (APP1).
export function parseJpeg(bytes) {
  const out = {};
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0) !== 0xffd8) return out;

  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) break;
    const marker = bytes[i + 1];
    const len = view.getUint16(i + 2);
    if (marker === 0xe1 && latin1(bytes.subarray(i + 4, i + 10)) === "Exif\0\0") {
      Object.assign(out, parseTiff(new DataView(bytes.buffer, bytes.byteOffset + i + 10, len - 8)));
    } else if (marker >= 0xc0 && marker <= 0xc2) {
      out.height = view.getUint16(i + 5);
      out.width = view.getUint16(i + 7);
      break;
    }
    i += 2 + len;
  }
  return out;
}

function parseTiff(view) {
  const out = {};
  const little = view.getUint16(0) === 0x4949;
  const u16 = (o) => view.getUint16(o, little);
  const u32 = (o) => view.getUint32(o, little);

  const readIfd = (offset) => {
    if (offset <= 0 || offset + 2 > view.byteLength) return;
    const count = u16(offset);
    for (let n = 0; n < count; n++) {
      const e = offset + 2 + n * 12;
      if (e + 12 > view.byteLength) return;
      const name = EXIF_TAGS[u16(e)];
      if (!name) continue;
      const type = u16(e + 2);
      if (name === "exifIfd") {
        readIfd(u32(e + 8));
      } else if (type === 5) {
        // RATIONAL, stored at an offset
        const p = u32(e + 8);
        out[name] = u32(p) / u32(p + 4);
      } else if (type === 3) {
        out[name] = u16(e + 8);
      } else if (type === 4) {
        out[name] = u32(e + 8);
      }
    }
  };
  readIfd(u32(4));
  return out;
}

function latin1(bytes) {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return s;
}
