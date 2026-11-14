const DEFAULT_DATABASE_ID = "ai-studio-remixremixcloudv-42a2b61a-2d55-4ff5-9eec-86f128500033";
const encoder = new TextEncoder();
let cachedGoogleToken = { value: "", expiresAt: 0 };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function constantTimeEqual(left, right) {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] || 0) ^ (b[index] || 0);
  }
  return difference === 0;
}

async function verifyWhopSignature(request, rawBody, secret) {
  const messageId = request.headers.get("webhook-id");
  const timestamp = request.headers.get("webhook-timestamp");
  const signatures = request.headers.get("webhook-signature");
  if (!messageId || !timestamp || !signatures) return false;

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds) || Math.abs(Date.now() / 1000 - timestampSeconds) > 300) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = encoder.encode(`${messageId}.${timestamp}.${rawBody}`);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, signed));
  const expected = base64Url(digest).replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - base64Url(digest).length % 4) % 4);

  return signatures.split(" ").some((entry) => {
    const [version, value] = entry.split(",", 2);
    return version === "v1" && value && constantTimeEqual(value, expected);
  });
}

function pemToBytes(pem) {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  return Uint8Array.from(atob(body), (character) => character.charCodeAt(0));
}

async function getGoogleAccessToken(serviceAccount) {
  if (cachedGoogleToken.value && cachedGoogleToken.expiresAt > Date.now() + 60_000) {
    return cachedGoogleToken.value;
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = base64Url(encoder.encode(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })));
  const unsignedToken = `${header}.${claims}`;
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToBytes(serviceAccount.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, encoder.encode(unsignedToken)));
  const assertion = `${unsignedToken}.${base64Url(signature)}`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const tokenResult = await response.json().catch(() => ({}));
  if (!response.ok || !tokenResult.access_token) throw new Error("Could not authenticate with the account database.");
  cachedGoogleToken = { value: tokenResult.access_token, expiresAt: Date.now() + Number(tokenResult.expires_in || 3600) * 1000 };
  return cachedGoogleToken.value;
}

function firestoreUrl(projectId, documentPath = "", env = {}) {
  const databaseId = env.FIRESTORE_DATABASE_ID || DEFAULT_DATABASE_ID;
  const base = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/documents`;
  return documentPath ? `${base}/${documentPath}` : base;
}

async function firestoreRequest(projectId, token, path, method, body, env) {
  const response = await fetch(firestoreUrl(projectId, path, env), {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("Whop webhook Firestore request failed:", { method, status: response.status, path });
    throw new Error("Could not update the account after payment.");
  }
  return result;
}

function firestoreString(value) {
  return { stringValue: String(value) };
}

function firestoreInteger(value) {
  return { integerValue: String(value) };
}

function readString(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.id === "string") return value.id;
  return "";
}

function getEmail(data) {
  const candidates = [data?.user?.email, data?.member?.email, data?.email, data?.user_email];
  const found = candidates.find((value) => typeof value === "string" && value.includes("@"));
  return found ? found.trim().toLowerCase() : "";
}

function getPlanId(data) {
  return readString(data?.plan_id)
    || readString(data?.plan)
    || readString(data?.membership?.plan_id)
    || readString(data?.membership?.plan)
    || "";
}

function getMembershipId(data) {
  return readString(data?.membership_id) || readString(data?.membership) || "";
}

function planForWhopId(env, planId) {
  const plans = [
    { id: env.WHOP_PLAN_50GB_ID, key: "50gb", name: "50 GB Starter", bytes: 50 * 1024 ** 3 },
    { id: env.WHOP_PLAN_250GB_ID, key: "250gb", name: "250 GB Pro Studio", bytes: 250 * 1024 ** 3 },
    { id: env.WHOP_PLAN_1TB_ID, key: "1tb", name: "1 TB Ultimate", bytes: 1024 ** 4 },
  ];
  return plans.find((plan) => plan.id && plan.id === planId) || null;
}

async function findUserByEmail(projectId, token, email, env) {
  const queryUrl = `${firestoreUrl(projectId, "", env)}:runQuery`;
  const query = (value) => fetch(queryUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: "users" }],
      where: { fieldFilter: { field: { fieldPath: "email" }, op: "EQUAL", value: firestoreString(value) } },
      limit: 2,
    } }),
  });

  let response = await query(email);
  if (!response.ok) throw new Error("Could not find the matching Cloudvalt account.");
  let matches = (await response.json()).map((entry) => entry.document).filter(Boolean);
  if (!matches.length && email !== email.toLowerCase()) {
    response = await query(email.toLowerCase());
    if (!response.ok) throw new Error("Could not find the matching Cloudvalt account.");
    matches = (await response.json()).map((entry) => entry.document).filter(Boolean);
  }
  if (matches.length !== 1) {
    if (matches.length > 1) throw new Error("More than one Cloudvalt account matches this payment email.");
    throw new Error("No Cloudvalt account matches the email used at checkout.");
  }
  return matches[0];
}

async function isDuplicate(projectId, token, eventId, env) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(eventId)));
  const documentId = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const response = await fetch(firestoreUrl(projectId, `whopWebhookEvents/${documentId}`, env), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (response.ok) return { duplicate: true, documentId };
  if (response.status === 404) return { duplicate: false, documentId };
  throw new Error("Could not check whether this payment event was already handled.");
}

async function handleWebhook(request, env) {
  if (request.method === "GET") return json({
    ready: Boolean(env.WHOP_WEBHOOK_SECRET && env.FIREBASE_SERVICE_ACCOUNT_JSON
      && env.WHOP_PLAN_50GB_ID && env.WHOP_PLAN_250GB_ID && env.WHOP_PLAN_1TB_ID),
    service: "Cloudvalt Whop webhook",
  });
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  if (!env.WHOP_WEBHOOK_SECRET) return json({ error: "Webhook verification is not configured." }, 503);

  const length = Number(request.headers.get("content-length") || 0);
  if (length > 1024 * 1024) return json({ error: "Webhook payload is too large." }, 413);
  const rawBody = await request.text();
  if (rawBody.length > 1024 * 1024) return json({ error: "Webhook payload is too large." }, 413);

  let validSignature = false;
  try {
    validSignature = await verifyWhopSignature(request, rawBody, env.WHOP_WEBHOOK_SECRET.trim());
  } catch (error) {
    console.error("Whop webhook signature check failed:", error instanceof Error ? error.message : "unknown error");
  }
  if (!validSignature) return json({ error: "Invalid webhook signature." }, 401);

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ error: "Invalid webhook payload." }, 400);
  }
  const eventId = request.headers.get("webhook-id") || event.id;
  if (!eventId || typeof event.type !== "string" || !event.data || typeof event.data !== "object") {
    return json({ error: "Webhook event is missing required fields." }, 400);
  }

  if (event.type === "payment.failed") return json({ received: true, ignored: true });
  if (!["payment.succeeded", "membership.activated", "membership.deactivated"].includes(event.type)) {
    return json({ received: true, ignored: true });
  }

  if (!env.FIREBASE_SERVICE_ACCOUNT_JSON) return json({ error: "Payment account updates are not configured." }, 503);

  try {
    const serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
    const projectId = env.FIREBASE_PROJECT_ID || serviceAccount.project_id;
    if (!serviceAccount.client_email || !serviceAccount.private_key || !projectId) {
      return json({ error: "Payment account updates are not configured correctly." }, 503);
    }
    const token = await getGoogleAccessToken(serviceAccount);
    const duplicateCheck = await isDuplicate(projectId, token, eventId, env);
    if (duplicateCheck.duplicate) return json({ received: true, duplicate: true });

    const email = getEmail(event.data);
    if (!email) throw new Error("Whop did not include the buyer email. Enable buyer email access for these webhook events.");
    const user = await findUserByEmail(projectId, token, email, env);
    const uid = user.name.split("/").pop();
    const updateMask = ["plan", "planId", "maxStorageBytes", "updatedAt"];
    let fields;

    if (event.type === "membership.deactivated") {
      const membershipId = readString(event.data.id);
      const savedMembershipId = user.fields?.whopMembershipId?.stringValue || "";
      if (savedMembershipId && membershipId && savedMembershipId !== membershipId) {
        return json({ received: true, ignored: true, reason: "A different membership is active." });
      }
      fields = {
        plan: firestoreString("100 MB Free"),
        planId: firestoreString("100mb"),
        maxStorageBytes: firestoreInteger(100 * 1024 * 1024),
        updatedAt: firestoreString(new Date().toISOString()),
      };
      updateMask.push("whopMembershipId");
      fields.whopMembershipId = { nullValue: null };
    } else {
      const planId = getPlanId(event.data);
      const plan = planForWhopId(env, planId);
      if (!plan) throw new Error("The paid Whop plan ID is not mapped to a Cloudvalt storage plan.");
      fields = {
        plan: firestoreString(plan.name),
        planId: firestoreString(plan.key),
        maxStorageBytes: firestoreInteger(plan.bytes),
        updatedAt: firestoreString(new Date().toISOString()),
      };
      const membershipId = event.type === "membership.activated"
        ? readString(event.data.id)
        : getMembershipId(event.data);
      if (membershipId) {
        fields.whopMembershipId = firestoreString(membershipId);
        updateMask.push("whopMembershipId");
      }
    }

    const userPath = `users/${encodeURIComponent(uid)}`;
    const patchUrl = new URL(firestoreUrl(projectId, userPath, env));
    for (const field of updateMask) patchUrl.searchParams.append("updateMask.fieldPaths", field);
    const userUpdate = await fetch(patchUrl, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ fields }),
    });
    if (!userUpdate.ok) throw new Error("Could not update the matching Cloudvalt account.");

    await firestoreRequest(projectId, token, `whopWebhookEvents/${duplicateCheck.documentId}`, "PATCH", {
      fields: {
        eventId: firestoreString(eventId),
        eventType: firestoreString(event.type),
        processedAt: firestoreString(new Date().toISOString()),
        userId: firestoreString(uid),
      },
    }, env);
    return json({ received: true, processed: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook processing failed.";
    console.error("Whop webhook processing failed:", { type: event.type, message });
    return json({ error: message }, 503);
  }
}

export default {
  async fetch(request, env) {
    return handleWebhook(request, env);
  },
};
