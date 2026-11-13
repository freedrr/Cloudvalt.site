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
        const updated = { ...fileData, isDeleted: true, deletedAt, updatedAt: deletedAt };
        const write = await firebaseDatabaseRequest(context.env, docPath, token, "PATCH", firestoreFields(updated));
        if (!write.ok) return json({ success: false, error: "Could not move this file to Trash." }, 502);
        return json({ success: true, trashed: true, deletedAt, retentionDays: 30 });
      }

      if (fileData.storedInB2 && !objectKey) return json({ success: false, error: "The cloud file key is missing; file was not deleted." }, 409);
      if (objectKey) {
        if (!objectKey.startsWith(`users/${uid}/`)) return json({ success: false, error: "File key does not belong to this account." }, 403);
        const [{ S3Client, DeleteObjectCommand, ListObjectVersionsCommand, DeleteObjectsCommand }] = await Promise.all([import("@aws-sdk/client-s3")]);
        const region = context.env.B2_REGION || "us-east-005";
        const client = new S3Client({ endpoint: context.env.B2_ENDPOINT || `https://s3.${region}.backblazeb2.com`, region, credentials: { accessKeyId: context.env.B2_KEY_ID, secretAccessKey: context.env.B2_APPLICATION_KEY }, forcePathStyle: true });
        try {
          const bucket = context.env.B2_BUCKET_NAME;
          const listed = await client.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: objectKey }));
          const versions = [...(listed.Versions || []), ...(listed.DeleteMarkers || [])].filter(item => item.Key === objectKey && item.VersionId);
          if (versions.length) {
            await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: versions.map(item => ({ Key: objectKey, VersionId: item.VersionId })), Quiet: false } }));
          } else {
            await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }));
          }
        } catch (error) {
          console.error("B2 permanent file deletion failed:", error instanceof Error ? error.message : error);
          return json({ success: false, error: "Cloud storage could not confirm permanent deletion." }, 502);
        } finally {
          client.destroy();
        }
      }

      const deleteResult = await firebaseDatabaseRequest(context.env, docPath, token, "DELETE");
      if (!deleteResult.ok && deleteResult.status !== 404) return json({ success: false, error: "Cloud file deleted, but file details could not be removed." }, 502);
      const rootDelete = await firebaseDatabaseRequest(context.env, `files/${fileId}`, token, "DELETE");
      if (!rootDelete.ok && rootDelete.status !== 404) return json({ success: false, error: "Cloud file deleted, but its index record could not be removed." }, 502);
      return json({ success: true, b2Deleted: Boolean(objectKey), message: "File permanently deleted." });
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
