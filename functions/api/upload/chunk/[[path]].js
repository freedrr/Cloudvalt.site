// Cloudflare Pages Functions for direct-to-B2 multipart uploads.
// File bytes never pass through Cloudflare; this function only authenticates
// the signed-in user and creates short-lived B2 upload URLs.

const encoder = new TextEncoder();
let firebaseKeys = { expires: 0, keys: {} };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function base64UrlEncode(value) {
  const bytes = value instanceof Uint8Array ? value : encoder.encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function textFromBase64Url(value) {
  return new TextDecoder().decode(base64UrlDecode(value));
}

async function sha256Hex(value) {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function hmac(key, value) {
  const cryptoKey = await crypto.subtle.importKey("raw", typeof key === "string" ? encoder.encode(key) : key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(value)));
}

function awsEncode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalQuery(entries) {
  return [...entries]
    .map(([key, value]) => [awsEncode(key), awsEncode(value)])
    .sort(([aKey, aValue], [bKey, bValue]) => aKey === bKey ? aValue.localeCompare(bValue) : aKey.localeCompare(bKey))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function timestamp() {
  const now = new Date();
  const iso = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

function b2Config(env) {
  const endpoint = (env.B2_ENDPOINT || `https://s3.${env.B2_REGION || "us-east-005"}.backblazeb2.com`).replace(/\/$/, "");
  if (!env.B2_KEY_ID || !env.B2_APPLICATION_KEY || !env.B2_BUCKET_NAME) throw new Error("Cloud storage is not configured.");
  return { endpoint, region: env.B2_REGION || "us-east-005", bucket: env.B2_BUCKET_NAME, keyId: env.B2_KEY_ID, secret: env.B2_APPLICATION_KEY };
}

function objectPath(bucket, key) {
  return `/${awsEncode(bucket)}/${key.split("/").map(awsEncode).join("/")}`;
}

async function signingKey(secret, dateStamp, region) {
  const dateKey = await hmac(`AWS4${secret}`, dateStamp);
  const regionKey = await hmac(dateKey, region);
  const serviceKey = await hmac(regionKey, "s3");
  return hmac(serviceKey, "aws4_request");
}

async function b2Request(env, method, key, queryEntries = [], body = "", extraHeaders = {}) {
  const config = b2Config(env);
  const endpoint = new URL(config.endpoint);
  const { amzDate, dateStamp } = timestamp();
  const canonicalUri = objectPath(config.bucket, key);
  const query = canonicalQuery(queryEntries);
  const payloadHash = await sha256Hex(body);
  const headers = { host: endpoint.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate, ...extraHeaders };
  const headerNames = Object.keys(headers).map(name => name.toLowerCase()).sort();
  const canonicalHeaders = headerNames.map(name => `${name}:${String(headers[name] ?? headers[Object.keys(headers).find(original => original.toLowerCase() === name)]).trim()}\n`).join("");
  const signedHeaders = headerNames.join(";");
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const canonicalRequest = [method, canonicalUri, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");
  const signature = [...await hmac(await signingKey(config.secret, dateStamp, config.region), stringToSign)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const url = `${config.endpoint}${canonicalUri}${query ? `?${query}` : ""}`;
  return fetch(url, { method, headers: { ...headers, Authorization: `AWS4-HMAC-SHA256 Credential=${config.keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` }, body: body || undefined });
}

async function presignedPartUrl(env, key, uploadId, partNumber) {
  const config = b2Config(env);
  const endpoint = new URL(config.endpoint);
  const { amzDate, dateStamp } = timestamp();
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const queryEntries = [
    ["partNumber", partNumber], ["uploadId", uploadId], ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${config.keyId}/${scope}`], ["X-Amz-Date", amzDate], ["X-Amz-Expires", "3600"], ["X-Amz-SignedHeaders", "host"],
  ];
  const canonicalUri = objectPath(config.bucket, key);
  const query = canonicalQuery(queryEntries);
  const canonicalRequest = ["PUT", canonicalUri, query, `host:${endpoint.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");
  const signature = [...await hmac(await signingKey(config.secret, dateStamp, config.region), stringToSign)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `${config.endpoint}${canonicalUri}?${query}&X-Amz-Signature=${signature}`;
}

async function signedSession(env, payload) {
  const encoded = base64UrlEncode(JSON.stringify(payload));
  return `${encoded}.${base64UrlEncode(await hmac(env.B2_APPLICATION_KEY, encoded))}`;
}

async function readSession(env, token, uid) {
  if (typeof token !== "string" || !token.includes(".")) throw new Error("Upload session is missing.");
  const [encoded, suppliedSignature] = token.split(".");
  const expectedSignature = base64UrlEncode(await hmac(env.B2_APPLICATION_KEY, encoded));
  if (suppliedSignature.length !== expectedSignature.length || !crypto.timingSafeEqual) {
    if (suppliedSignature !== expectedSignature) throw new Error("Upload session is invalid.");
  } else if (!crypto.timingSafeEqual(encoder.encode(suppliedSignature), encoder.encode(expectedSignature))) {
    throw new Error("Upload session is invalid.");
  }
  const payload = JSON.parse(textFromBase64Url(encoded));
  if (payload.uid !== uid || !payload.key || !payload.uploadId || payload.expires < Date.now()) throw new Error("Upload session has expired.");
  return payload;
}

async function firebaseUser(request, env) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  // The project ID is public client configuration. Keeping this fallback means
  // a missing Pages variable cannot accidentally take the upload service down.
  const projectId = env.FIREBASE_PROJECT_ID || "strange-bird-467010-q9";
  if (!token) throw new Error("Sign in is required.");
  const [headerPart, payloadPart, signaturePart] = token.split(".");
  if (!headerPart || !payloadPart || !signaturePart) throw new Error("Invalid sign-in token.");
  const header = JSON.parse(textFromBase64Url(headerPart));
  const payload = JSON.parse(textFromBase64Url(payloadPart));
  if (header.alg !== "RS256" || !header.kid || payload.aud !== projectId || payload.iss !== `https://securetoken.google.com/${projectId}` || !payload.sub || payload.exp * 1000 < Date.now()) throw new Error("Your sign-in has expired.");
  if (firebaseKeys.expires < Date.now()) {
    const response = await fetch("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com");
    if (!response.ok) throw new Error("Could not verify your sign-in.");
    const keySet = await response.json();
    firebaseKeys = { keys: Object.fromEntries(keySet.keys.map(key => [key.kid, key])), expires: Date.now() + 60 * 60 * 1000 };
  }
  const publicKey = firebaseKeys.keys[header.kid];
  if (!publicKey) throw new Error("Your sign-in key has rotated. Please try again.");
  const key = await crypto.subtle.importKey("jwk", publicKey, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64UrlDecode(signaturePart), encoder.encode(`${headerPart}.${payloadPart}`));
  if (!valid) throw new Error("Invalid sign-in token.");
  return payload.sub;
}

function fileType(name, mimeType) {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (/\.(zip|rar|7z|tar|gz)$/i.test(name)) return "archive";
  if (/\.(pdf|docx?|xlsx?|pptx?|txt|csv)$/i.test(name)) return "document";
  return "other";
}

function xmlEscape(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function onRequest(context) {
  try {
    if (context.request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const action = context.params.path?.[0];
    const body = await context.request.json();
    const uid = await firebaseUser(context.request, context.env);

    if (action === "init") {
      const fileName = typeof body.fileName === "string" ? body.fileName.trim() : "";
      const fileSize = Number(body.fileSize);
      if (!fileName || !Number.isSafeInteger(fileSize) || fileSize <= 0) return json({ error: "fileName and fileSize are required." }, 400);
      if (body.userId && body.userId !== uid) return json({ error: "Upload user does not match the signed-in account." }, 403);
      const chunkSize = Math.max(16 * 1024 * 1024, Math.ceil(fileSize / 10000 / (1024 * 1024)) * 1024 * 1024);
      const safeName = fileName.replace(/[\\/:*?"<>|]/g, "_");
      const objectKey = `users/${uid}/${crypto.randomUUID()}_${safeName}`;
      const create = await b2Request(context.env, "POST", objectKey, [["uploads", ""]], "", { "content-type": body.mimeType || "application/octet-stream" });
      const createText = await create.text();
      const uploadId = createText.match(/<UploadId>([^<]+)<\/UploadId>/)?.[1];
      if (!create.ok || !uploadId) {
        const b2Message = createText.match(/<Message>([^<]+)<\/Message>/)?.[1];
        const b2Code = createText.match(/<Code>([^<]+)<\/Code>/)?.[1];
        console.error("B2 multipart initialization failed", { status: create.status, code: b2Code || null, message: b2Message || createText.slice(0, 500) });
        return json({
          error: `Cloud storage could not start this upload (B2 ${create.status}${b2Code ? `: ${b2Code}` : ""}).`,
          storageStatus: create.status,
          storageCode: b2Code || undefined,
          storageMessage: b2Message || undefined,
        }, 502);
      }
      const uploadToken = await signedSession(context.env, { uid, uploadId, key: objectKey, size: fileSize, chunkSize, name: fileName, mimeType: body.mimeType || "application/octet-stream", expires: Date.now() + 2 * 60 * 60 * 1000 });
      return json({ success: true, uploadId, uploadToken, chunkSize });
    }

    const session = await readSession(context.env, body.uploadToken, uid);
    if (body.uploadId !== session.uploadId) return json({ error: "Upload session is invalid." }, 403);
    const expectedParts = Math.ceil(session.size / session.chunkSize);

    if (action === "url") {
      const chunkIndex = Number(body.chunkIndex);
      if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= expectedParts) return json({ error: "Invalid file part." }, 400);
      return json({ uploadUrl: await presignedPartUrl(context.env, session.key, session.uploadId, chunkIndex + 1), partNumber: chunkIndex + 1 });
    }

    if (action === "part-complete") {
      const chunkIndex = Number(body.chunkIndex);
      if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= expectedParts || typeof body.eTag !== "string" || !body.eTag) return json({ error: "Invalid uploaded file part." }, 400);
      return json({ success: true });
    }

    if (action === "complete") {
      const parts = Array.isArray(body.parts) ? body.parts : [];
      if (Number(body.totalChunks) !== expectedParts || parts.length !== expectedParts) return json({ error: "Incomplete cloud upload." }, 400);
      const sortedParts = [...parts].sort((a, b) => Number(a.PartNumber) - Number(b.PartNumber));
      if (sortedParts.some((part, index) => Number(part.PartNumber) !== index + 1 || typeof part.ETag !== "string" || !part.ETag)) return json({ error: "Invalid uploaded file parts." }, 400);
      const completeXml = `<CompleteMultipartUpload>${sortedParts.map(part => `<Part><PartNumber>${Number(part.PartNumber)}</PartNumber><ETag>${xmlEscape(part.ETag)}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
      const complete = await b2Request(context.env, "POST", session.key, [["uploadId", session.uploadId]], completeXml, { "content-type": "application/xml" });
      const completeText = await complete.text();
      if (!complete.ok) return json({ error: "Cloud storage could not finish this upload." }, 502);
      const b2FileId = completeText.match(/<ETag>([^<]+)<\/ETag>/)?.[1] || null;
      const id = `file_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
      const file = { id, name: session.name, size: session.size, type: fileType(session.name, session.mimeType), mimeType: session.mimeType, userId: uid, uploadedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), isFavorite: false, isDeleted: false, storedInB2: true, b2BucketName: context.env.B2_BUCKET_NAME, b2FileId, b2FileName: session.key, url: `/api/files/${id}?userId=${encodeURIComponent(uid)}&b2FileName=${encodeURIComponent(session.key)}` };
      return json({ success: true, message: `Successfully uploaded ${session.name}`, file, files: [file] });
    }
    return json({ error: "Unknown upload action." }, 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload service failed.";
    const status = /Sign in|token|session/.test(message) ? 401 : 500;
    return json({ error: message }, status);
  }
}
