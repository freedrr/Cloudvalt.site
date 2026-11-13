// Private-file delivery endpoint. It creates a fresh, short-lived B2 read URL
// for each request and redirects the browser; file bytes stay in B2.

let firebaseKeys = { expires: 0, keys: {} };
const encoder = new TextEncoder();

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

export async function onRequest(context) {
  try {
    const uid = await verifyUser(context.request, context.env);
    const url = new URL(context.request.url);
    const userId = url.searchParams.get("userId");
    const objectKey = url.searchParams.get("b2FileName");
    const requestedMethod = context.request.method;
    if (!uid || !userId || uid !== userId) return new Response("Sign in is required.", { status: 401 });
    if (!objectKey || !objectKey.startsWith(`users/${uid}/`) || !context.env.B2_KEY_ID || !context.env.B2_APPLICATION_KEY || !context.env.B2_BUCKET_NAME) {
      return new Response("File could not be found.", { status: 404 });
    }
    const signedUrl = await createReadUrl(context.env, context.env.B2_BUCKET_NAME, objectKey);
    if (requestedMethod === "HEAD") return fetch(signedUrl, { method: "HEAD" });
    return Response.redirect(signedUrl, 302);
  } catch (error) {
    console.error("Private file read URL could not be created:", error instanceof Error ? error.message : error);
    return new Response("File preview is temporarily unavailable.", { status: 502 });
  }
}
