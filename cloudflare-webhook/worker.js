const DEFAULT_DATABASE_ID = "ai-studio-remixremixcloudv-42a2b61a-2d55-4ff5-9eec-86f128500033";
const FIREBASE_PROJECT_ID = "strange-bird-467010-q9";
const CHECKOUTS = {
  "50gb": { checkoutId: "ch_nQGMC9zyxWndgAz", name: "50 GB Starter", bytes: 50 * 1024 ** 3 },
  "250gb": { checkoutId: "ch_5Ws2YBO75QKKJfS", name: "250 GB Pro Studio", bytes: 250 * 1024 ** 3 },
  "1tb": { checkoutId: "ch_Bk8BD0spJ6gdDgy", name: "1 TB Ultimate", bytes: 1024 ** 4 },
};
const encoder = new TextEncoder();
let cachedGoogleToken = { value: "", expiresAt: 0 };
let firebaseSigningKeys = { expiresAt: 0, keys: {} };

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

function decodeBase64UrlJson(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  return JSON.parse(atob(padded));
}

async function verifyFirebaseIdToken(request) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature) return null;
  try {
    const header = decodeBase64UrlJson(encodedHeader);
    const payload = decodeBase64UrlJson(encodedPayload);
    const now = Math.floor(Date.now() / 1000);
    if (header.alg !== "RS256" || !header.kid || payload.aud !== FIREBASE_PROJECT_ID
      || payload.iss !== `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`
      || typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 128
      || payload.exp <= now || payload.iat > now || !payload.auth_time || payload.auth_time > now) return null;

    if (firebaseSigningKeys.expiresAt <= Date.now()) {
      const response = await fetch("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com");
      if (!response.ok) return null;
      const keySet = await response.json();
      firebaseSigningKeys = {
        keys: Object.fromEntries(keySet.keys.map((key) => [key.kid, key])),
        expiresAt: Date.now() + 60 * 60 * 1000,
      };
    }
    const jwk = firebaseSigningKeys.keys[header.kid];
    if (!jwk) return null;
    const publicKey = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const signature = Uint8Array.from(atob(encodedSignature.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - encodedSignature.length % 4) % 4)), (char) => char.charCodeAt(0));
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, signature, encoder.encode(`${encodedHeader}.${encodedPayload}`));
    return valid ? { uid: payload.sub, email: typeof payload.email === "string" ? payload.email : "" } : null;
  } catch {
    return null;
  }
}

function checkoutCorsHeaders(request) {
  const origin = request.headers.get("origin") || "";
  const allowed = new Set([
    "https://cloudvalt-site.pages.dev",
    "https://cloudvalt.site",
    "https://www.cloudvalt.site",
    "http://localhost:3000",
  ]);
  return {
    "access-control-allow-origin": allowed.has(origin) ? origin : "https://cloudvalt-site.pages.dev",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "Authorization, Content-Type",
    "access-control-max-age": "86400",
    "vary": "Origin",
  };
}

function checkoutJson(request, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...checkoutCorsHeaders(request), "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function handleCreateCheckout(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: checkoutCorsHeaders(request) });
  if (request.method !== "POST") return checkoutJson(request, { error: "Method not allowed." }, 405);
  if (!env.WHOP_API_KEY) return checkoutJson(request, { error: "Checkout is not configured." }, 503);

  const identity = await verifyFirebaseIdToken(request);
  if (!identity) return checkoutJson(request, { error: "Sign in to continue to checkout." }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return checkoutJson(request, { error: "Invalid checkout request." }, 400);
  }
  const planId = body?.planId;
  const plan = CHECKOUTS[planId];
  if (!plan) return checkoutJson(request, { error: "Choose a valid storage plan." }, 400);

  try {
    const apiHeaders = {
      authorization: `Bearer ${env.WHOP_API_KEY}`,
      "content-type": "application/json",
      "api-version-date": "2026-08-21-1",
    };
    const existingResponse = await fetch(`https://api.whop.com/api/v1/checkout_configurations/${plan.checkoutId}`, {
      headers: apiHeaders,
    });
    const existing = await existingResponse.json().catch(() => ({}));
    if (!existingResponse.ok) {
      console.error("Whop checkout source lookup failed:", existingResponse.status);
      return checkoutJson(request, { error: "Could not load this storage plan from checkout." }, 502);
    }
    const accountId = existing.account_id || existing.account?.id;
    // Whop's retrieve response exposes legacy checkout plans as `plan`,
    // while newer responses use `variant`.
    const variantId = existing.variant?.id || existing.plan?.id || existing.variant_id || existing.plan_id;
    if (!accountId || !variantId) {
      console.error("Whop checkout source did not include account and variant identifiers.");
      return checkoutJson(request, { error: "The selected subscription plan is not available." }, 502);
    }

    const createResponse = await fetch("https://api.whop.com/api/v1/checkout_configurations", {
      method: "POST",
      headers: {
        ...apiHeaders,
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        account_id: accountId,
        variant_id: variantId,
        mode: "payment",
        redirect_url: "https://cloudvalt-site.pages.dev/",
        metadata: {
          firebase_uid: identity.uid,
          cloudvalt_plan_id: planId,
        },
      }),
    });
    const checkout = await createResponse.json().catch(() => ({}));
    if (!createResponse.ok || typeof checkout.purchase_url !== "string") {
      console.error("Whop checkout creation failed:", createResponse.status, checkout?.error?.code || "unknown");
      return checkoutJson(request, { error: "Could not create checkout. Please try again." }, 502);
    }
    return checkoutJson(request, { purchase_url: checkout.purchase_url });
  } catch (error) {
    console.error("Whop checkout request failed:", error instanceof Error ? error.message : "unknown error");
    return checkoutJson(request, { error: "Checkout is temporarily unavailable." }, 502);
  }
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

function getEventMetadata(data) {
  return data?.metadata || data?.membership?.metadata || {};
}

function planFromCloudvaltKey(key) {
  const plan = CHECKOUTS[key];
  return plan ? { key, name: plan.name, bytes: plan.bytes } : null;
}

function planForWhopId(env, planId) {
  const plans = [
    { id: env.WHOP_PLAN_50GB_ID, key: "50gb", name: "50 GB Starter", bytes: 50 * 1024 ** 3 },
    { id: env.WHOP_PLAN_250GB_ID, key: "250gb", name: "250 GB Pro Studio", bytes: 250 * 1024 ** 3 },
    { id: env.WHOP_PLAN_1TB_ID, key: "1tb", name: "1 TB Ultimate", bytes: 1024 ** 4 },
  ];
  return plans.find((plan) => plan.id && plan.id === planId) || null;
}

async function findUserByUid(projectId, token, uid, env) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) throw new Error("Payment metadata contains an invalid account ID.");
  const response = await fetch(firestoreUrl(projectId, `users/${encodeURIComponent(uid)}`, env), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (response.status === 404) throw new Error("The Cloudvalt account for this payment no longer exists.");
  if (!response.ok) throw new Error("Could not find the Cloudvalt account for this payment.");
  return response.json();
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
  const eventType = event.event || event.type;
  const eventId = request.headers.get("webhook-id") || event.id;
  console.log("📩 Webhook received:", eventType || "unknown", eventId || "");
  const respond = (extra = {}, status = 200) => json({
    received: true,
    event: eventType || null,
    timestamp: new Date().toISOString(),
    ...extra,
  }, status);

  if (typeof eventType !== "string") {
    return json({ error: "Webhook event is missing its event type." }, 400);
  }

  if (eventType === "payment.failed") {
    console.log("❌ PAYMENT FAILED:", eventId || "unknown");
    return respond({ ignored: true });
  }
  if (eventType === "payment.created") {
    console.log("⏳ PAYMENT CREATED (PENDING):", eventId || "unknown");
    return respond({ pending: true });
  }
  if (!["payment.succeeded", "membership.activated", "membership.deactivated"].includes(eventType)) {
    console.log("ℹ️ OTHER WEBHOOK EVENT:", eventType, eventId || "");
    return respond({ ignored: true });
  }
  if (!eventId || !event.data || typeof event.data !== "object") {
    return json({ error: "Webhook event is missing required fields." }, 400);
  }
  if (eventType === "payment.succeeded") console.log("✅ PAYMENT SUCCEEDED:", eventId);

  if (!env.FIREBASE_SERVICE_ACCOUNT_JSON) return json({ error: "Payment account updates are not configured." }, 503);

  try {
    const serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
    const projectId = env.FIREBASE_PROJECT_ID || serviceAccount.project_id;
    if (!serviceAccount.client_email || !serviceAccount.private_key || !projectId) {
      return json({ error: "Payment account updates are not configured correctly." }, 503);
    }
    const token = await getGoogleAccessToken(serviceAccount);
    const duplicateCheck = await isDuplicate(projectId, token, eventId, env);
    if (duplicateCheck.duplicate) return respond({ duplicate: true });

    const metadata = getEventMetadata(event.data);
    const metadataUid = typeof metadata.firebase_uid === "string" ? metadata.firebase_uid : "";
    if (!metadataUid || !/^[A-Za-z0-9_-]{1,128}$/.test(metadataUid)) {
      console.warn("Whop payment event has no trusted Firebase UID; no account plan was changed.", eventId);
      return respond({ ignored: true, reason: "missing_trusted_firebase_uid" });
    }
    const user = await findUserByUid(projectId, token, metadataUid, env);
    const uid = user.name.split("/").pop();
    const updateMask = ["plan", "planId", "maxStorageBytes", "updatedAt"];
    let fields;

    if (eventType === "membership.deactivated") {
      const membershipId = readString(event.data.id);
      const savedMembershipId = user.fields?.whopMembershipId?.stringValue || "";
      if (savedMembershipId && membershipId && savedMembershipId !== membershipId) {
        return respond({ ignored: true, reason: "A different membership is active." });
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
      const plan = planFromCloudvaltKey(metadata.cloudvalt_plan_id) || planForWhopId(env, getPlanId(event.data));
      if (!plan) throw new Error("The paid Whop plan ID is not mapped to a Cloudvalt storage plan.");
      fields = {
        plan: firestoreString(plan.name),
        planId: firestoreString(plan.key),
        maxStorageBytes: firestoreInteger(plan.bytes),
        updatedAt: firestoreString(new Date().toISOString()),
      };
      const membershipId = eventType === "membership.activated"
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
        eventType: firestoreString(eventType),
        processedAt: firestoreString(new Date().toISOString()),
        userId: firestoreString(uid),
      },
    }, env);
    return respond({ processed: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook processing failed.";
    console.error("🚨 Webhook error:", { event: eventType, id: eventId, message });
    return json({ error: "Webhook processing failed" }, 500);
  }
}

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/api/checkout" || pathname === "/checkout") {
      return handleCreateCheckout(request, env);
    }
    return handleWebhook(request, env);
  },
};
