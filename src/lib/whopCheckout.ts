import { auth } from "@/lib/firebase";

const CHECKOUT_ENDPOINT = "https://cloudvaltwebhook.ip624717.workers.dev/api/checkout";

export async function createWhopCheckout(planId: "50gb" | "250gb" | "1tb"): Promise<string> {
  const firebaseUser = auth.currentUser;
  if (!firebaseUser) throw new Error("Sign in before starting checkout.");

  const idToken = await firebaseUser.getIdToken(true);
  const response = await fetch(CHECKOUT_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${idToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ planId }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || typeof result.purchase_url !== "string") {
    throw new Error(result.error || "Could not open secure checkout. Please try again.");
  }

  const purchaseUrl = new URL(result.purchase_url);
  if (purchaseUrl.protocol !== "https:" || !["whop.com", "www.whop.com"].includes(purchaseUrl.hostname)) {
    throw new Error("Checkout returned an invalid destination.");
  }
  return purchaseUrl.toString();
}
