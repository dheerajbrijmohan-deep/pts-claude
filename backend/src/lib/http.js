function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readRawBody(req, limitBytes = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readRawBody(req);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch (err) {
    throw Object.assign(new Error('Invalid JSON body'), { statusCode: 400 });
  }
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

// Minimal multipart/form-data parser — no external deps. Returns
// { fields: {name: value}, files: [{fieldName, fileName, mimeType, data}] }.
async function readMultipart(req, contentType, limitBytes = 25 * 1024 * 1024) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!boundaryMatch) throw Object.assign(new Error('Missing multipart boundary'), { statusCode: 400 });
  const boundary = '--' + (boundaryMatch[1] || boundaryMatch[2]).trim();
  const raw = await readRawBody(req, limitBytes);

  const boundaryBuf = Buffer.from(boundary);
  const parts = [];
  let start = raw.indexOf(boundaryBuf);
  while (start !== -1) {
    const next = raw.indexOf(boundaryBuf, start + boundaryBuf.length);
    if (next === -1) break;
    let segment = raw.slice(start + boundaryBuf.length, next);
    if (segment.slice(0, 2).toString('latin1') === '--') break;
    if (segment[0] === 0x0d && segment[1] === 0x0a) segment = segment.slice(2);
    if (segment.slice(-2).toString('latin1') === '\r\n') segment = segment.slice(0, -2);
    parts.push(segment);
    start = next;
  }

  const fields = {};
  const files = [];
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headerText = part.slice(0, headerEnd).toString('utf8');
    const body = part.slice(headerEnd + 4);

    const nameMatch = /name="([^"]*)"/i.exec(headerText);
    const fileNameMatch = /filename="([^"]*)"/i.exec(headerText);
    const mimeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headerText);
    const fieldName = nameMatch ? nameMatch[1] : '';

    if (fileNameMatch) {
      if (!fileNameMatch[1]) continue; // empty file input
      files.push({
        fieldName,
        fileName: fileNameMatch[1],
        mimeType: mimeMatch ? mimeMatch[1].trim() : 'application/octet-stream',
        data: body,
      });
    } else {
      fields[fieldName] = body.toString('utf8');
    }
  }

  return { fields, files };
}

module.exports = { sendJson, readJsonBody, readRawBody, parseCookies, readMultipart };
