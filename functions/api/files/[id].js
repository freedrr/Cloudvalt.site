// Private-file delivery endpoint. It creates a fresh B2 read URL for each
// request and streams the response through this same origin for preview CORS.

let firebaseKeys = { expires: 0, keys: {} };
const encoder = new TextEncoder();
const FIRESTORE_DATABASE = "ai-studio-remixremixcloudv-42a2b61a-2d55-4ff5-9eec-86f128500033";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function base64UrlDecode(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0));
}

function decodeJson(value) {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(value)));
}

async function verifyUser(request, env) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const [head, payloadPart, signature] = token.split(".");
  if (!head || !payloadPart || !signature) return null;
  const header = decodeJson(head);
  const payload = decodeJson(payloadPart);
  const projectId = env.FIREBASE_PROJECT_ID || "strange-bird-467010-q9";
  if (header.alg !== "RS256" || !header.kid || payload.aud !== projectId || payload.iss !== `https://securetoken.google.com/${projectId}` || !payload.sub || payload.exp * 1000 <= Date.now()) return null;
  if (firebaseKeys.expires < Date.now()) {
    const response = await fetch("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com");
    if (!response.ok) return null;
    const keySet = await response.json();
    firebaseKeys = { keys: Object.fromEntries(keySet.keys.map(key => [key.kid, key])), expires: Date.now() + 60 * 60 * 1000 };
  }
  const publicKey = firebaseKeys.keys[header.kid];
  if (!publicKey) return null;
  const key = await crypto.subtle.importKey("jwk", publicKey, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64UrlDecode(signature), encoder.encode(`${head}.${payloadPart}`));
  return valid ? payload.sub : null;
}

async function createReadUrl(env, bucket, key) {
  const [{ S3Client, GetObjectCommand }, { getSignedUrl }] = await Promise.all([
    import("@aws-sdk/client-s3"),
    import("@aws-sdk/s3-request-presigner"),
  ]);
  const region = env.B2_REGION || "us-east-005";
  const client = new S3Client({
    endpoint: env.B2_ENDPOINT || `https://s3.${region}.backblazeb2.com`,
    region,
    credentials: { accessKeyId: env.B2_KEY_ID, secretAccessKey: env.B2_APPLICATION_KEY },
    forcePathStyle: true,
  });
  try {
    return await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 3600 });
  } finally {
    client.destroy();
  }
}

async function firebaseDatabaseRequest(env, path, token, method, body) {
  const projectId = env.FIREBASE_PROJECT_ID || "strange-bird-467010-q9";
  const endpoint = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${FIRESTORE_DATABASE}/documents/${path}`;
  return fetch(endpoint, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function firestoreFields(data) {
  const fields = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === null) fields[key] = { nullValue: null };
    else if (typeof value === "boolean") fields[key] = { booleanValue: value };
    else if (typeof value === "number") fields[key] = { integerValue: String(value) };
    else fields[key] = { stringValue: String(value) };
  }
  return { fields };
}

function firestoreValue(field) {
  if (!field) return undefined;
  if ("stringValue" in field) return field.stringValue;
  if ("integerValue" in field) return Number(field.integerValue);
  if ("booleanValue" in field) return field.booleanValue;
  if ("nullValue" in field) return null;
  return undefined;
}

function firestoreDocumentData(document) {
  return Object.fromEntries(Object.entries(document?.fields || {}).map(([key, value]) => [key, firestoreValue(value)]));
}

function xmlDecode(value) {
  return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function parseObjectVersions(xml, targetKey) {
  const objects = [];
  const itemPattern = /<(Version|DeleteMarker)>([\s\S]*?)<\/\1>/g;
  for (const match of xml.matchAll(itemPattern)) {
    const block = match[2];
    const key = block.match(/<Key>([\s\S]*?)<\/Key>/)?.[1];
    const versionId = block.match(/<VersionId>([\s\S]*?)<\/VersionId>/)?.[1];
    if (key && versionId && xmlDecode(key) === targetKey) objects.push({ Key: targetKey, VersionId: xmlDecode(versionId) });
  }
  return objects;
}

function b2ClientConfig(env) {
  const region = env.B2_REGION || "us-east-005";
  return {
    endpoint: env.B2_ENDPOINT || `https://s3.${region}.backblazeb2.com`,
    region,
    credentials: { accessKeyId: env.B2_KEY_ID, secretAccessKey: env.B2_APPLICATION_KEY },
    forcePathStyle: true,
  };
}

function awsEncode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`).replace(/%[0-9a-f]{2}/gi, match => match.toUpperCase());
}

function canonicalQuery(entries) {
  return [...entries]
    .map(([key, value]) => [awsEncode(key), awsEncode(value)])
    .sort(([aKey, aValue], [bKey, bValue]) => aKey === bKey ? aValue.localeCompare(bValue) : aKey.localeCompare(bKey))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

async function hmac(key, value) {
  const cryptoKey = await crypto.subtle.importKey("raw", typeof key === "string" ? encoder.encode(key) : key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(value)));
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function signS3Request(env, method, queryEntries) {
  const config = b2ClientConfig(env);
  const endpoint = new URL(config.endpoint);
  const date = new Date();
  const amzDate = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const key = `${endpoint.pathname.replace(/\/$/, "")}/${awsEncode(env.B2_BUCKET_NAME)}`;
  const query = canonicalQuery(queryEntries);
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalHeaders = `host:${endpoint.host}\nx-amz-content-sha256:UNSIGNED-PAYLOAD\nx-amz-date:${amzDate}\n`;
  const canonicalRequest = [method, key || "/", query, canonicalHeaders, signedHeaders, "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");
  const dateKey = await hmac(`AWS4${config.credentials.secretAccessKey}`, dateStamp);
  const regionKey = await hmac(dateKey, config.region);
  const serviceKey = await hmac(regionKey, "s3");
  const signingKey = await hmac(serviceKey, "aws4_request");
  const signature = [...await hmac(signingKey, stringToSign)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const authorization = `AWS4-HMAC-SHA256 Credential=${config.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { url: `${endpoint.origin}${key}?${query}`, headers: { host: endpoint.host, "x-amz-content-sha256": "UNSIGNED-PAYLOAD", "x-amz-date": amzDate, Authorization: authorization } };
}

async function deleteB2ObjectAndVersions(env, objectKey) {
  const config = b2ClientConfig(env);
  const { S3Client, DeleteObjectCommand } = await import("@aws-sdk/client-s3");
  const client = new S3Client(config);
  try {
    // B2 S3 DeleteObject removes the current version by creating a marker in
    // versioned buckets. For non-versioned buckets it permanently removes the
    // object. Avoid XML listing here because Workers lack DOMParser.
    await client.send(new DeleteObjectCommand({ Bucket: env.B2_BUCKET_NAME, Key: objectKey }));
  } finally {
    client.destroy();
  }
}

export async function onRequest(context) {
  try {
    if (context.request.method === "DELETE") {
      const uid = await verifyUser(context.request, context.env);
      const requestUrl = new URL(context.request.url);
      const userId = requestUrl.searchParams.get("userId");
      const fileId = String(context.params.id || "");
      const b2FileName = requestUrl.searchParams.get("b2FileName");
      if (!uid || !userId || uid !== userId) return json({ success: false, error: "Sign in to manage this file." }, 401);
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(fileId)) return json({ success: false, error: "Invalid file ID." }, 400);
      const token = context.request.headers.get("authorization").replace(/^Bearer\s+/i, "");
      const docPath = `users/${uid}/files/${fileId}`;
      const read = await firebaseDatabaseRequest(context.env, docPath, token, "GET");
      if (!read.ok) return json({ success: false, error: read.status === 404 ? "File not found in this account." : "Could not verify this file." }, read.status === 404 ? 404 : 502);
      const fileData = firestoreDocumentData(await read.json());
      if (fileData.userId !== uid) return json({ success: false, error: "You can only manage your own files." }, 403);
      const objectKey = b2FileName || fileData.b2FileName;
      const permanently = requestUrl.searchParams.get("permanent") === "true";

      if (!permanently) {
        const deletedAt = new Date().toISOString();
        const updatePath = `users/${uid}/files/${fileId}?updateMask.fieldPaths=isDeleted&updateMask.fieldPaths=updatedAt`;
        const updated = await firebaseDatabaseRequest(context.env, updatePath, token, "PATCH", firestoreFields({ isDeleted: true, updatedAt: deletedAt }));
        if (!updated.ok) return json({ success: false, error: "Could not move this file to Trash." }, 502);
        return json({ success: true, trashed: true, deletedAt, retentionDays: 30 });
      }

      if (fileData.storedInB2 && !objectKey) return json({ success: false, error: "The cloud file key is missing; file was not deleted." }, 409);
      if (objectKey) {
        if (!objectKey.startsWith(`users/${uid}/`)) return json({ success: false, error: "File key does not belong to this account." }, 403);
        try {
          await deleteB2ObjectAndVersions(context.env, objectKey);
        } catch (error) {
          const errorName = error?.name || error?.Code || "B2Error";
          const errorMessage = error instanceof Error ? error.message : String(error || "Unknown B2 error");
          const requestId = error?.$metadata?.requestId;
          console.error("B2 permanent file deletion failed:", { name: errorName, message: errorMessage, requestId });
          return json({
            success: false,
            error: `Cloud storage could not delete the file (${errorName}): ${errorMessage}`,
            storageRequestId: requestId,
          }, 502);
        }
      }

      // Browser Firestore rules authorize permanent deletion from the signed-in
      // client. Return success for B2 removal; the app deletes both Firestore
      // copies immediately after this confirmation.
      return json({ success: true, b2Deleted: Boolean(objectKey), message: "File permanently deleted from cloud storage." });
    }
    // Media elements cannot attach Authorization headers. The file key is
    // scoped to its UID and this route only returns a short-lived, read-only URL.
    const uid = await verifyUser(context.request, context.env);
    const url = new URL(context.request.url);
    const userId = url.searchParams.get("userId");
    const objectKey = url.searchParams.get("b2FileName");
    const requestedMethod = context.request.method;
    const ownerId = uid || userId;
    if (!ownerId || (uid && userId && uid !== userId)) return new Response("Sign in is required.", { status: 401 });
    if (!objectKey || !objectKey.startsWith(`users/${ownerId}/`) || !context.env.B2_KEY_ID || !context.env.B2_APPLICATION_KEY || !context.env.B2_BUCKET_NAME) {
      return new Response("File could not be found.", { status: 404 });
    }
    const signedUrl = await createReadUrl(context.env, context.env.B2_BUCKET_NAME, objectKey);
    const upstream = await fetch(signedUrl, { method: requestedMethod === "HEAD" ? "HEAD" : "GET" });
    if (!upstream.ok) return new Response("File preview could not be loaded.", { status: upstream.status });
    const headers = new Headers();
    for (const name of ["content-type", "content-length", "content-range", "accept-ranges", "last-modified", "etag"]) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    headers.set("cache-control", "private, no-store");
    return new Response(requestedMethod === "HEAD" ? null : upstream.body, { status: upstream.status, headers });
  } catch (error) {
    console.error("Private file read URL could not be created:", error instanceof Error ? error.message : error);
    return new Response("File preview is temporarily unavailable.", { status: 502 });
  }
}
